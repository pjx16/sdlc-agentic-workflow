import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitRunner } from './git-runner';
import { makeWritableForAgent, prepareWorkspace, type WorkspaceSpec } from './workspace';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

let tmp: string;
let source: string;
let mirror: string;
const git = new GitRunner({ token: async () => '' });

const spec = (name: string, over: Partial<WorkspaceSpec> = {}): WorkspaceSpec => ({
  mirrorPath: mirror, repoUrl: 'https://github.com/acme/billing', baseBranch: 'dev', workspacePath: path.join(tmp, 'workspaces', name), branch: `feature/KEY-1-${name}`, ...over,
});

beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'sdlc-ws-'));
  source = path.join(tmp, 'source');
  execFileSync('git', ['init', '-q', '-b', 'dev', source]);
  writeFileSync(path.join(source, 'README.md'), 'v1');
  writeFileSync(path.join(source, 'package.json'), '{}');
  sh(source, 'add', '.');
  sh(source, 'commit', '-q', '-m', 'init');
  sh(source, 'branch', 'other');
  mirror = path.join(tmp, 'mirror.git');
  execFileSync('git', ['clone', '-q', '--mirror', source, mirror]);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('prepareWorkspace (BUILD_PLAN 6.2)', () => {
  it('clones the mirror, checks out a new branch from origin/<baseBranch>, and points origin at the real URL', async () => {
    const s = spec('a');
    const res = await prepareWorkspace(git, s);
    expect(res).toEqual({ path: s.workspacePath, branch: s.branch, created: true });
    expect(sh(s.workspacePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(s.branch);
    expect(readFileSync(path.join(s.workspacePath, 'README.md'), 'utf8')).toBe('v1');
    expect(sh(s.workspacePath, 'remote', 'get-url', 'origin')).toBe('https://github.com/acme/billing');
    expect(sh(s.workspacePath, 'rev-parse', 'HEAD')).toBe(sh(source, 'rev-parse', 'dev'));
  });

  it('is a standalone clone: no alternates and no hardlinks to the mirror', async () => {
    const s = spec('b');
    await prepareWorkspace(git, s);
    expect(existsSync(path.join(s.workspacePath, '.git', 'objects', 'info', 'alternates'))).toBe(false);
    expect(statSync(path.join(s.workspacePath, '.git')).isDirectory()).toBe(true);
    const objects = execFileSync('find', [path.join(s.workspacePath, '.git', 'objects'), '-type', 'f', '-links', '+1'], { encoding: 'utf8' }).trim();
    expect(objects).toBe('');
  });

  it('branches from the project base branch, whatever it is', async () => {
    const s = spec('c', { baseBranch: 'other', branch: 'tech/KEY-2-c' });
    await prepareWorkspace(git, s);
    expect(sh(s.workspacePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('tech/KEY-2-c');
  });

  it('reuses an existing workspace and keeps its commits, but still refreshes the mirror first', async () => {
    const s = spec('d');
    await prepareWorkspace(git, s);
    writeFileSync(path.join(s.workspacePath, 'work.txt'), 'in progress');
    sh(s.workspacePath, 'add', '.');
    sh(s.workspacePath, 'commit', '-q', '-m', 'ticket work');
    const head = sh(s.workspacePath, 'rev-parse', 'HEAD');

    writeFileSync(path.join(source, 'later.txt'), 'new upstream commit');
    sh(source, 'add', '.');
    sh(source, 'commit', '-q', '-m', 'later');
    const second = await prepareWorkspace(git, s);
    expect(second.created).toBe(false);
    expect(sh(s.workspacePath, 'rev-parse', 'HEAD')).toBe(head); // the ticket branch is untouched
    expect(sh('.', '--git-dir', mirror, 'rev-parse', 'dev')).toBe(sh(source, 'rev-parse', 'dev')); // the mirror was updated
  });

  it('switches back to the ticket branch if the workspace was left on another one', async () => {
    const s = spec('e');
    await prepareWorkspace(git, s);
    sh(s.workspacePath, 'checkout', '-q', '-b', 'detour');
    await prepareWorkspace(git, s);
    expect(sh(s.workspacePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(s.branch);
  });

  it('fails clearly when the base branch does not exist', async () => {
    await expect(prepareWorkspace(git, spec('f', { baseBranch: 'nope', branch: 'x/KEY-9-f' }))).rejects.toThrow(/origin\/nope|not a commit|did not match/i);
  });

  it('fails when the mirror is missing', async () => {
    await expect(prepareWorkspace(git, spec('g', { mirrorPath: path.join(tmp, 'missing.git') }))).rejects.toThrow();
  });
});

describe('makeWritableForAgent', () => {
  it('leaves the workspace writable by the agent user (chown, or open permissions without root)', async () => {
    const s = spec('h');
    await prepareWorkspace(git, s);
    const how = await makeWritableForAgent(s.workspacePath);
    expect(['chown', 'chmod']).toContain(how);
    if (how === 'chmod') expect(statSync(path.join(s.workspacePath, 'README.md')).mode & 0o006).toBe(0o006);
  });
});
