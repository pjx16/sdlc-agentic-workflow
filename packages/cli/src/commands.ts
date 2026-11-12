import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { compose } from './compose';
import { envFor, runDoctor } from './doctor';
import { getEnv } from './envfile';
import { readManifest } from './manifest';
import { run } from './proc';
import { CliError, dim, green, out, yellow } from './ui';

export function openBrowser(url: string): void {
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    const child = spawn(opener, [url], { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    /* opening the browser is a convenience; ignore failures */
  }
}

function readEnvText(dir: string): string {
  const file = path.join(dir, '.env');
  if (!existsSync(file)) throw new CliError(`No installation found at ${dir}. Run \`sdlc-agent init\` first.`);
  return readFileSync(file, 'utf8');
}

export function dashboardUrl(dir: string): string {
  const bind = getEnv(readEnvText(dir), 'DASHBOARD_BIND') || '127.0.0.1';
  return `http://${bind === '0.0.0.0' ? 'localhost' : bind}:3000`;
}

export async function fetchSetupStatus(dir: string): Promise<{ adminCreated: boolean } | null> {
  try {
    const res = await fetch(`${dashboardUrl(dir)}/api/setup/status`, { signal: AbortSignal.timeout(5000) });
    return res.ok ? ((await res.json()) as { adminCreated: boolean }) : null;
  } catch {
    return null;
  }
}

/** The agent image the worker will start containers from; pulled now so the first stage does not wait. */
export function agentImage(envText: string): string {
  return getEnv(envText, 'AGENT_IMAGE') || `${getEnv(envText, 'SDLC_REGISTRY') || 'ghcr.io/pjx16'}/sdlc-agent-agent:${getEnv(envText, 'SDLC_VERSION')}`;
}

export async function up(opts: { dir: string; quiet?: boolean }): Promise<void> {
  const envText = readEnvText(opts.dir);
  const doctor = await runDoctor({ dir: opts.dir, env: envFor(opts.dir) }, opts.quiet);
  if (!doctor.ok) throw new CliError('Fix the checks marked ✖ above, then try again.');

  out('Pulling images…');
  if ((await compose(opts.dir, ['pull'], { inherit: true })).code !== 0) throw new CliError('Could not pull the images. Check your network and that the release is published.');
  out('Starting…');
  if ((await compose(opts.dir, ['up', '-d', '--wait', '--wait-timeout', '300'], { inherit: true })).code !== 0) throw new CliError('The stack did not become healthy. See `sdlc-agent logs`.');
  const image = agentImage(envText);
  out(`Pulling the agent image ${image}…`);
  if ((await run('docker', ['pull', image], { inherit: true })).code !== 0) out(yellow('Could not pull the agent image now; the worker will try again on its first stage.'));

  const status = await fetchSetupStatus(opts.dir);
  if (status && !status.adminCreated) {
    out();
    out(`Open ${dashboardUrl(opts.dir)} to finish setup. Setup code: ${getEnv(envText, 'SETUP_CODE') ?? '(see docker compose logs api)'}`);
  }
}

export async function down(dir: string): Promise<void> {
  readEnvText(dir);
  const res = await compose(dir, ['down'], { inherit: true });
  if (res.code !== 0) throw new CliError('`docker compose down` failed.');
  out('Stopped. Your data (database and files) is kept; run `sdlc-agent up` to start again.');
}

interface PsRow {
  Service?: string;
  State?: string;
  Health?: string;
  Status?: string;
}

export function parsePs(stdout: string): PsRow[] {
  const text = stdout.trim();
  if (!text) return [];
  if (text.startsWith('[')) return JSON.parse(text) as PsRow[];
  return text.split('\n').map((l) => JSON.parse(l) as PsRow);
}

export async function status(dir: string): Promise<void> {
  readEnvText(dir);
  const manifest = readManifest(dir);
  out(`sdlc-agent ${manifest?.version ?? '(unknown version)'} in ${dir}`);
  const ps = await compose(dir, ['ps', '--all', '--format', 'json']);
  const rows = ps.code === 0 ? parsePs(ps.stdout) : [];
  if (rows.length === 0) out(dim('No containers. Run `sdlc-agent up`.'));
  for (const r of rows) out(`  ${(r.Service ?? '?').padEnd(10)} ${r.State === 'running' ? green(r.State) : (r.State ?? '?')}${r.Health ? ` (${r.Health})` : ''}`);
  const setup = await fetchSetupStatus(dir);
  out(setup ? `Setup: admin ${setup.adminCreated ? 'created' : 'not created yet'}  ${dashboardUrl(dir)}` : dim('Dashboard is not reachable.'));
}

export async function logs(dir: string, service: string | undefined, follow: boolean): Promise<void> {
  readEnvText(dir);
  const res = await compose(dir, ['logs', ...(follow ? ['-f'] : ['--tail', '200']), ...(service ? [service] : [])], { inherit: true });
  if (res.code !== 0) throw new CliError('`docker compose logs` failed.');
}
