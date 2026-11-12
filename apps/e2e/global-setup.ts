import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { type Server, createServer } from 'node:http';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { SETUP_CODE } from './tests/constants.ts';
import { seed } from './seed.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const API_PORT = 4100;
const WEB_PORT = 3100;
const GITHUB_PORT = 4199;

/** A stand-in for api.github.com: GET /user answers for the one token the setup spec enters. */
function fakeGitHub(): Server {
  return createServer((req, res) => {
    const ok = req.method === 'GET' && req.url === '/user' && req.headers.authorization?.startsWith('Bearer ghp_');
    res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' }).end(JSON.stringify(ok ? { login: 'octo-e2e' } : { message: 'Bad credentials' }));
  }).listen(GITHUB_PORT, '127.0.0.1');
}

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

  const github = fakeGitHub();
  const children: ChildProcess[] = [];
  const start = (cmd: string, args: string[], cwd: string, env: Record<string, string>) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'inherit', 'inherit'] });
    children.push(child);
    return child;
  };
  start('node', ['dist/main.js'], path.join(ROOT, 'apps/api'), {
    PORT: String(API_PORT), DATABASE_URL: url, DATA_DIR: dataDir, // No DASHBOARD_PASSWORD: tests/0-setup.spec.ts creates the admin through the setup wizard with SETUP_CODE.
    SETUP_CODE, ENCRYPTION_KEY: randomBytes(32).toString('base64'), GITHUB_API_URL: `http://127.0.0.1:${GITHUB_PORT}`, COOKIE_SECURE: 'false', LOG_LEVEL: 'warn',
  });
  start('npx', ['next', 'dev', '-p', String(WEB_PORT), '-H', '127.0.0.1'], path.join(ROOT, 'apps/dashboard'), { API_URL: `http://127.0.0.1:${API_PORT}` });
  await waitFor(`http://127.0.0.1:${API_PORT}/health`, 'the API');
  await waitFor(`http://127.0.0.1:${WEB_PORT}/login`, 'the dashboard');

  return async () => {
    for (const c of children) c.kill('SIGTERM');
    github.close();
    await container.stop();
  };
}
