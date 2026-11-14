import Docker from 'dockerode';
import { DockerodeEngine } from '../worker/agent-runner/container-engine';
import { AGENT_NETWORK } from '../worker/agent-runner/container-options';
import { ContainerRunner } from '../worker/agent-runner/container-runner';

export const AGENT_IMAGE = 'sdlc-agent/agent:latest';
export const PROXY_IMAGE = 'sdlc-agent/proxy:test';
const EGRESS_NETWORK = 'sdlc_test_egress';
const PROXY_NAME = 'sdlc-test-proxy';

export const docker = new Docker();

async function ensureNetwork(name: string, internal: boolean): Promise<boolean> {
  const existing = await docker.listNetworks({ filters: { name: [name] } });
  if (existing.some((n) => n.Name === name)) return false;
  await docker.createNetwork({ Name: name, Internal: internal, CheckDuplicate: true });
  return true;
}

export interface EgressFixture {
  stop(): Promise<void>;
}

/**
 * The real egress setup from BUILD_PLAN 6.1 for tests: the internal agent network, an egress network, and the
 * Squid proxy image attached to both (alias `proxy`).
 */
export async function startEgress(): Promise<EgressFixture> {
  const createdAgent = await ensureNetwork(AGENT_NETWORK, true);
  const createdEgress = await ensureNetwork(EGRESS_NETWORK, false);
  await docker.getContainer(PROXY_NAME).remove({ force: true }).catch(() => undefined);
  const proxy = await docker.createContainer({
    name: PROXY_NAME,
    Image: PROXY_IMAGE,
    HostConfig: { NetworkMode: EGRESS_NETWORK },
  });
  await proxy.start();
  await docker.getNetwork(AGENT_NETWORK).connect({ Container: proxy.id, EndpointConfig: { Aliases: ['proxy'] } });
  await waitForProxy();
  return {
    async stop() {
      await proxy.remove({ force: true }).catch(() => undefined);
      if (createdEgress) await docker.getNetwork(EGRESS_NETWORK).remove().catch(() => undefined);
      if (createdAgent) await docker.getNetwork(AGENT_NETWORK).remove().catch(() => undefined);
    },
  };
}

/** Runs a shell snippet in the agent image on the agent network, as the agent would run. Returns its output lines. */
export async function shellInAgent(script: string, opts: { env?: Record<string, string>; workspace?: { path: string; readOnly: boolean; hide?: { emptyFile: string; names: string[] } }; network?: string } = {}) {
  const runner = new ContainerRunner(new DockerodeEngine(docker));
  const lines: string[] = [];
  const result = await runner.run(
    { name: `sdlc-test-shell-${Math.random().toString(36).slice(2, 8)}`, image: AGENT_IMAGE, cmd: ['sh', '-c', script], env: opts.env ?? {}, workspace: opts.workspace, memory: '512m', cpus: 1, timeoutMs: 60_000, network: opts.network },
    { onLine: (l) => lines.push(l) },
  );
  return { ...result, lines };
}

async function waitForProxy(): Promise<void> {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const { lines } = await shellInAgent('curl -s -o /dev/null -w "%{http_code}" --max-time 5 -x http://proxy:3128 https://registry.npmjs.org/; echo " exit=$?"');
    if (/exit=0/.test(lines.join(' '))) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('The test proxy did not become ready');
}

/** Removes any agent container left behind (the runner must always remove its containers). */
export async function leftoverAgentContainers(): Promise<string[]> {
  const containers = await docker.listContainers({ all: true, filters: { label: ['sdlc.agent=true'] } });
  return containers.map((c) => c.Names.join(','));
}
