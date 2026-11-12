import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { PASSWORD } from './tests/constants.ts';
import { seed } from './seed.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const API_PORT = 4100;
const WEB_PORT = 3100;

async function waitFor(url: string, what: string, ms = 120_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${what} did not come up at ${url}`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const container = await new PostgreSqlContainer('postgres:17').start();
  const url = container.getConnectionUri();
  const dataDir = mkdtempSync(path.join(tmpdir(), 'sdlc-e2e-'));
  mkdirSync(path.join(dataDir, 'logs'), { recursive: true });

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: path.join(ROOT, 'apps/api'), env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
  process.env.E2E_DATABASE_URL = url;
  await seed(url);

  const children: ChildProcess[] = [];
  const start = (cmd: string, args: string[], cwd: string, env: Record<string, string>) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'inherit', 'inherit'] });
    children.push(child);
    return child;
  };
  start('node', ['dist/main.js'], path.join(ROOT, 'apps/api'), {
    PORT: String(API_PORT), DATABASE_URL: url, DATA_DIR: dataDir, DASHBOARD_PASSWORD: PASSWORD, SESSION_SECRET: 'e2e-session-secret-0123456789abcdef', COOKIE_SECURE: 'false', LOG_LEVEL: 'warn',
  });
  start('npx', ['next', 'dev', '-p', String(WEB_PORT), '-H', '127.0.0.1'], path.join(ROOT, 'apps/dashboard'), { API_URL: `http://127.0.0.1:${API_PORT}` });
  await waitFor(`http://127.0.0.1:${API_PORT}/health`, 'the API');
  await waitFor(`http://127.0.0.1:${WEB_PORT}/login`, 'the dashboard');

  return async () => {
    for (const c of children) c.kill('SIGTERM');
    await container.stop();
  };
}
