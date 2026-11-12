import { existsSync, readFileSync, statfsSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { isRunning } from './compose';
import { getEnv } from './envfile';
import { assetsDir } from './paths';
import { run } from './proc';
import { dim, green, out, red, yellow } from './ui';

export interface Check {
  name: string;
  ok: boolean;
  required: boolean;
  /** Shown with a failing check. */
  hint?: string;
  detail?: string;
}

export interface DoctorResult {
  ok: boolean;
  checks: Check[];
  /** Set when the default Docker socket is missing but another one exists. */
  dockerSock?: string;
}

/** `2.20.1` / `v2.29.0` style versions: returns <0, 0 or >0. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.replace(/^v/, '').split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export const DEFAULT_SOCKET = '/var/run/docker.sock';

/** Where Colima, OrbStack and Docker Desktop put the socket when /var/run/docker.sock is not there. */
export function socketCandidates(home: string): string[] {
  return [path.join(home, '.colima/default/docker.sock'), path.join(home, '.orbstack/run/docker.sock'), path.join(home, '.docker/run/docker.sock')];
}

/** The socket to use: the configured one, else the default, else the first existing alternative. */
export function pickSocket(configured: string | undefined, exists: (p: string) => boolean, home: string): { path: string; found: boolean; suggested: boolean } {
  const wanted = configured || DEFAULT_SOCKET;
  if (exists(wanted)) return { path: wanted, found: true, suggested: false };
  const alt = socketCandidates(home).find(exists);
  return alt ? { path: alt, found: true, suggested: true } : { path: wanted, found: false, suggested: false };
}

const portFree = (port: number, host: string) =>
  new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });

const MIN_DISK_BYTES = 10 * 1024 ** 3;

export interface DoctorOptions {
  dir: string;
  /** DASHBOARD_BIND, DOCKER_SOCK and DATA_DIR from an existing .env, if there is one. */
  env?: { bind?: string; dockerSock?: string; dataDir?: string };
}

function postgresImage(dir: string): string {
  for (const file of [path.join(dir, 'docker-compose.yml'), path.join(assetsDir(), 'docker-compose.yml')]) {
    if (!existsSync(file)) continue;
    const m = /image:\s*(postgres:\S+)/.exec(readFileSync(file, 'utf8'));
    if (m) return m[1] as string;
  }
  return 'postgres:17';
}

/** Reads the values doctor needs from the install folder's .env, if it has one. */
export function envFor(dir: string): DoctorOptions['env'] {
  const file = path.join(dir, '.env');
  if (!existsSync(file)) return {};
  const text = readFileSync(file, 'utf8');
  return { bind: getEnv(text, 'DASHBOARD_BIND'), dockerSock: getEnv(text, 'DOCKER_SOCK'), dataDir: getEnv(text, 'DATA_DIR') };
}

export async function doctor(opts: DoctorOptions): Promise<DoctorResult> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] as string, 10);
  add({
    name: 'Node.js 20+ on macOS or Linux',
    required: true,
    ok: nodeMajor >= 20 && process.platform !== 'win32',
    detail: `Node ${process.versions.node}, ${process.platform}`,
    hint: process.platform === 'win32' ? 'Windows is not supported yet; use WSL2 and run sdlc-agent inside it.' : 'Install Node.js 20 or newer.',
  });

  const server = await run('docker', ['version', '--format', '{{.Server.Version}}']);
  const dockerUp = server.code === 0 && server.stdout.trim() !== '';
  add({ name: 'Docker is running', required: true, ok: dockerUp, detail: dockerUp ? `Server ${server.stdout.trim()}` : undefined, hint: 'Docker is not running or not installed. Start Docker Desktop (or Colima / OrbStack).' });

  const cv = await run('docker', ['compose', 'version', '--short']);
  const composeVersion = cv.stdout.trim();
  add({
    name: 'Docker Compose 2.20 or newer',
    required: true,
    ok: cv.code === 0 && compareVersions(composeVersion, '2.20.0') >= 0,
    detail: composeVersion || undefined,
    hint: 'Install Docker Compose v2.20 or newer (it ships with current Docker Desktop).',
  });

  const sock = pickSocket(opts.env?.dockerSock, existsSync, os.homedir());
  add({
    name: 'Docker socket',
    required: true,
    ok: sock.found,
    detail: sock.found ? sock.path + (sock.suggested ? ' (found instead of /var/run/docker.sock)' : '') : undefined,
    hint: `No Docker socket at ${sock.path}. Set DOCKER_SOCK in ${path.join(opts.dir, '.env')} to the socket path.`,
  });

  const bind = opts.env?.bind || '127.0.0.1';
  const running = dockerUp && existsSync(path.join(opts.dir, '.env')) && (await isRunning(opts.dir));
  if (!running) {
    add({ name: `Port 3000 is free on ${bind}`, required: false, ok: await portFree(3000, bind), hint: 'Something else uses port 3000. Stop it, or choose another address with --bind.' });
  }

  if (dockerUp && opts.env?.dataDir) {
    const probe = await run('docker', ['run', '--rm', '-v', `${opts.env.dataDir}:/probe`, postgresImage(opts.dir), 'sh', '-c', 'touch /probe/.doctor && rm /probe/.doctor']);
    add({ name: 'Docker can write to the data folder', required: true, ok: probe.code === 0, hint: `Docker cannot use ${opts.env.dataDir}. In Docker Desktop, Colima or OrbStack, share that path (Settings → Resources → File sharing).` });
  }

  try {
    const base = existsSync(opts.dir) ? opts.dir : path.dirname(opts.dir);
    const s = statfsSync(base);
    const free = s.bavail * s.bsize;
    add({ name: 'At least 10 GB free disk space', required: false, ok: free >= MIN_DISK_BYTES, detail: `${(free / 1024 ** 3).toFixed(1)} GB free`, hint: 'Images and workspaces need disk space; free some up.' });
  } catch {
    /* statfs is not available everywhere; skip */
  }

  const ok = checks.every((c) => c.ok || !c.required);
  return { ok, checks, dockerSock: sock.suggested ? sock.path : undefined };
}

export function printChecks(result: DoctorResult): void {
  for (const c of result.checks) {
    const mark = c.ok ? green('✔') : c.required ? red('✖') : yellow('!');
    out(`${mark} ${c.name}${c.detail ? dim(`  ${c.detail}`) : ''}`);
    if (!c.ok && c.hint) out(`    ${c.hint}`);
  }
}

/** Runs the checks, prints them, and reports whether the required ones passed. Skipped when SDLC_AGENT_SKIP_DOCTOR=1. */
export async function runDoctor(opts: DoctorOptions, quiet = false): Promise<DoctorResult> {
  if (process.env.SDLC_AGENT_SKIP_DOCTOR === '1') return { ok: true, checks: [] };
  const result = await doctor(opts);
  if (!quiet || !result.ok) printChecks(result);
  return result;
}
