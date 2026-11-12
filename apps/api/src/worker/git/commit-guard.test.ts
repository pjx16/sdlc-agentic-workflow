import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CommitGuardError, MAX_FILE_BYTES, findViolations, pathViolation, squashAgentCommits } from './commit-guard';
import { commitAll } from './commit';
import { GitRunner } from './git-runner';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=agent', '-c', 'user.email=agent@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
const git = new GitRunner({ githubToken: '' });
const identity = { name: 'Dev Bot', email: 'bot@example.com' };
let ws: string;
const write = (rel: string, content: string | Buffer = 'x') => {
  mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
  writeFileSync(path.join(ws, rel), content);
};

beforeAll(() => {
  ws = mkdtempSync(path.join(tmpdir(), 'sdlc-cg-'));
  execFileSync('git', ['init', '-q', '-b', 'dev', ws]);
  write('README.md', 'readme');
  sh(ws, 'add', '.');
  sh(ws, 'commit', '-q', '-m', 'init');
});
afterAll(() => rmSync(ws, { recursive: true, force: true }));
beforeEach(() => {
  sh(ws, 'reset', '-q', '--hard', 'dev');
  sh(ws, 'clean', '-fdq');
});

describe('pathViolation (F9 commit guard)', () => {
  it('refuses node_modules at any depth', () => {
    for (const f of ['node_modules/x/index.js', 'apps/web/node_modules/y.js', 'a/node_modules/b/node_modules/c.js']) expect(pathViolation(f), f).toContain('node_modules');
  });
  it('refuses every .env* file, anywhere', () => {
    for (const f of ['.env', '.env.local', '.env.production', 'apps/api/.env', 'config/.env.test', '.ENV', '.env.example', '.environment-notes']) expect(pathViolation(f), f).toContain('.env');
  });
  it('refuses key and certificate files', () => {
    for (const f of ['server.pem', 'certs/ca.PEM', 'id_rsa.key', 'keys/signing.KEY']) expect(pathViolation(f), f).toContain('key or certificate');
  });
  it('allows look-alikes', () => {
    for (const f of ['src/key.ts', 'src/environment.ts', 'src/env.ts', 'docs/keyboard.md', 'src/monkey', 'src/node_modules_notes.md', 'src/pem.ts', 'a/keys.json']) expect(pathViolation(f), f).toBeNull();
  });
});

describe('findViolations', () => {
  it('flags files over 1 MB but not exactly 1 MB', () => {
    const sizes: Record<string, number> = { 'big.bin': MAX_FILE_BYTES + 1, 'edge.bin': MAX_FILE_BYTES, 'small.txt': 10 };
    expect(findViolations(Object.keys(sizes), (f) => sizes[f] as number).map((v) => v.path)).toEqual(['big.bin']);
  });
  it('reports each file once, with the path reason taking priority', () => {
    const v = findViolations(['.env'], () => MAX_FILE_BYTES * 5);
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toContain('.env');
  });
});

describe('commitAll with the guard', () => {
  const refused = async (setup: () => void, text: RegExp) => {
    setup();
    const err = await commitAll(git, ws, 'feat: x', identity).catch((e) => e);
    expect(err).toBeInstanceOf(CommitGuardError);
    expect(err.message).toMatch(text);
    expect(sh(ws, 'log', '-1', '--format=%s')).toBe('init'); // nothing was committed
    expect(sh(ws, 'diff', '--cached', '--name-only')).toBe(''); // and nothing is left staged
    return err as CommitGuardError;
  };

  it('refuses node_modules', async () => {
    await refused(() => write('node_modules/pkg/index.js', 'x'), /node_modules/);
  });
  it('refuses an .env file even next to harmless changes, and names only the offenders', async () => {
    const err = await refused(() => {
      write('src/ok.ts', 'fine');
      write('.env.local', 'SECRET=1');
    }, /\.env\.local/);
    expect(err.violations.map((v) => v.path)).toEqual(['.env.local']);
  });
  it('refuses key and certificate files', async () => {
    await refused(() => write('certs/server.pem', '-----BEGIN PRIVATE KEY-----'), /server\.pem/);
    await refused(() => write('signing.key', 'k'), /signing\.key/);
  });
  it('refuses a file over 1 MB', async () => {
    await refused(() => write('data/dump.sql', Buffer.alloc(MAX_FILE_BYTES + 10, 97)), /larger than 1 MB/);
  });
  it('allows a normal change, a deletion, and a file at exactly 1 MB', async () => {
    write('src/a.ts', 'ok');
    write('data/edge.bin', Buffer.alloc(MAX_FILE_BYTES, 97));
    expect((await commitAll(git, ws, 'feat: ok', identity)).committed).toBe(true);
    sh(ws, 'rm', '-q', 'src/a.ts');
    expect((await commitAll(git, ws, 'chore: remove', identity)).committed).toBe(true);
  });
  it('deleting an .env file is allowed (removing a secret is never refused)', async () => {
    write('.env.bak', 'x');
    sh(ws, 'add', '-f', '.env.bak');
    sh(ws, 'commit', '-q', '-m', 'oops');
    sh(ws, 'rm', '-q', '.env.bak');
    expect((await commitAll(git, ws, 'chore: drop the env file', identity)).committed).toBe(true);
  });
  it('the guard also covers path-limited commits', async () => {
    write('docs/kb/key.pem', 'x');
    await expect(commitAll(git, ws, 'docs: x', identity, { paths: ['docs/kb'] })).rejects.toBeInstanceOf(CommitGuardError);
  });
});

describe('squashAgentCommits (F9)', () => {
  it('puts agent-made commits back as uncommitted changes, so the orchestrator commits them', async () => {
    const pre = sh(ws, 'rev-parse', 'HEAD');
    write('src/one.ts', '1');
    sh(ws, 'add', '.');
    sh(ws, 'commit', '-q', '-m', 'agent commit 1');
    write('src/two.ts', '2');
    sh(ws, 'add', '.');
    sh(ws, 'commit', '-q', '-m', 'agent commit 2');

    expect(await squashAgentCommits(git, ws, pre)).toBe(2);
    expect(sh(ws, 'rev-parse', 'HEAD')).toBe(pre);
    expect(sh(ws, 'status', '--porcelain').split('\n').sort()).toEqual(['A  src/one.ts', 'A  src/two.ts']);

    const res = await commitAll(git, ws, 'feat(KEY-1): one and two', identity);
    expect(res.committed).toBe(true);
    expect(sh(ws, 'log', '--format=%an|%s', `${pre}..HEAD`)).toBe('Dev Bot|feat(KEY-1): one and two');
    expect(sh(ws, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual(['src/one.ts', 'src/two.ts']);
  });

  it('does nothing when the agent made no commits', async () => {
    const pre = sh(ws, 'rev-parse', 'HEAD');
    write('src/x.ts', 'x');
    expect(await squashAgentCommits(git, ws, pre)).toBe(0);
    expect(sh(ws, 'status', '--porcelain')).toBe('?? src/x.ts');
  });

  it('a guarded file hidden inside an agent commit is still caught after squashing', async () => {
    const pre = sh(ws, 'rev-parse', 'HEAD');
    write('.env', 'SECRET=1');
    sh(ws, 'add', '-f', '.env');
    sh(ws, 'commit', '-q', '-m', 'agent sneaks a secret in');
    await squashAgentCommits(git, ws, pre);
    await expect(commitAll(git, ws, 'feat: x', identity)).rejects.toBeInstanceOf(CommitGuardError);
  });
});
