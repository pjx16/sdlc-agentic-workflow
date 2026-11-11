import type Docker from 'dockerode';

export const AGENT_LABEL = 'sdlc.agent=true';
export const AGENT_NETWORK = 'sdlc_agent_net';
export const NPM_CACHE_VOLUME = 'sdlc_npm_cache';
const AGENT_UID = '1000:1000'; // user `node` in the agent image
const PIDS_LIMIT = 512;

export interface ContainerSpec {
  /** Container name, `sdlc-run-<stageRunId>` for stages. */
  name: string;
  image: string;
  /** Entrypoint script in the image: `run-stage` or `run-cmd`. */
  cmd: string[];
  env: Record<string, string>;
  /** Absent for Jira stages. */
  workspace?: {
    path: string;
    readOnly: boolean;
    /** CLAUDE.md mode `ours`: bind an empty file over these files in /workspace so Claude Code cannot see them. */
    hide?: { emptyFile: string; names: string[] };
  };
  /** Mounted read-only at /context. */
  contextDir?: string;
  /** Like "4g". */
  memory: string;
  cpus: number;
  network?: string;
  timeoutMs: number;
}

const UNITS: Record<string, number> = { '': 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };

export function parseMemory(text: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/i.exec(text.trim());
  if (!match) throw new Error(`Invalid memory value "${text}" (expected something like 4g or 512m)`);
  return Math.floor(Number(match[1]) * (UNITS[(match[2] ?? '').toLowerCase()] as number));
}

/** The hardening from BUILD_PLAN 6.4 and F5, in one place so it can be tested. */
export function buildCreateOptions(spec: ContainerSpec): Docker.ContainerCreateOptions {
  const binds: string[] = [];
  if (spec.workspace) {
    binds.push(`${spec.workspace.path}:/workspace:${spec.workspace.readOnly ? 'ro' : 'rw'}`);
    for (const name of spec.workspace.hide?.names ?? []) binds.push(`${spec.workspace.hide?.emptyFile}:/workspace/${name}:ro`);
  }
  if (spec.contextDir) binds.push(`${spec.contextDir}:/context:ro`);
  binds.push(`${NPM_CACHE_VOLUME}:/npm-cache:rw`);

  return {
    name: spec.name,
    Image: spec.image,
    Cmd: spec.cmd,
    User: AGENT_UID,
    WorkingDir: '/workspace',
    Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
    Labels: { 'sdlc.agent': 'true' },
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    HostConfig: {
      Binds: binds,
      NetworkMode: spec.network ?? AGENT_NETWORK,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      Memory: parseMemory(spec.memory),
      NanoCpus: Math.round(spec.cpus * 1e9),
      PidsLimit: PIDS_LIMIT,
      AutoRemove: false, // removed explicitly after the logs are read
    },
  };
}
