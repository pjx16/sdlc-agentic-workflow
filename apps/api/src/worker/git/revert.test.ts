import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commitAll } from './commit';
import { GitRunner } from './git-runner';
import { revertRange } from './revert';

const bot = { name: 'Dev Bot', email: 'bot@example.com' };
let tmp: string;
let n = 0;
const git = new GitRunner({ token: async () => '' });

const raw = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const personCommit = (cwd: string, message: string) => {
  raw(cwd, 'add', '-A');
  execFileSync('git', ['commit', '-q', '-m', message], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 'Pat', GIT_AUTHOR_EMAIL: 'pat@example.com', GIT_COMMITTER_NAME: 'Pat', GIT_COMMITTER_EMAIL: 'pat@example.com' } });
};

/** A repository with one base commit by a person. */
function repo(): string {
  const dir = path.join(tmp, `r${++n}`);
  execFileSync('git', ['init', '-q', '-b', 'dev', dir]);
  writeFileSync(path.join(dir, 'README.md'), 'hello');
  personCommit(dir, 'init');
  return dir;
}
const write = (dir: string, file: string, text: string) => writeFileSync(path.join(dir, file), text);

beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'sdlc-revert-'));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('revertRange (BUILD_PLAN v1 6.8, D1)', () => {
  it('removes the work of several commits with one revert commit and keeps history', async () => {
    const dir = repo();
    const start = raw(dir, 'rev-parse', 'HEAD');
    write(dir, 'a.ts', 'one');
    const first = await commitAll(git, dir, 'feat: a', bot);
    write(dir, 'b.ts', 'two');
    await commitAll(git, dir, 'feat: b', bot);
    const result = await revertRange(git, dir, `${start}..HEAD`, 'revert: drop work superseded by rerun of PLANNING (K-1)', bot);
    expect(result).toMatchObject({ status: 'reverted', commits: 2 });
    expect(existsSync(path.join(dir, 'a.ts'))).toBe(false);
    expect(existsSync(path.join(dir, 'b.ts'))).toBe(false);
    expect(raw(dir, 'log', '--format=%s')).toBe('revert: drop work superseded by rerun of PLANNING (K-1)\nfeat: b\nfeat: a\ninit');
    expect(raw(dir, 'log', '--format=%H')).toContain((first as { sha: string }).sha); // the old commits are still there
    expect(raw(dir, 'diff', '--stat', start, 'HEAD')).toBe(''); // the tree is the start's again
    expect(raw(dir, 'log', '-1', '--format=%ae')).toBe('bot@example.com');
  });

  it('is a no-op when the range is empty', async () => {
    const dir = repo();
    expect(await revertRange(git, dir, 'HEAD..HEAD', 'revert: nothing', bot)).toEqual({ status: 'nothing' });
  });

  it('touches nothing when a person committed in the range, and names their commits', async () => {
    const dir = repo();
    const start = raw(dir, 'rev-parse', 'HEAD');
    write(dir, 'a.ts', 'one');
    await commitAll(git, dir, 'feat: a', bot);
    write(dir, 'human.ts', 'a hotfix by a person');
    personCommit(dir, 'fix: by hand');
    const humanSha = raw(dir, 'rev-parse', 'HEAD').slice(0, 8);
    const head = raw(dir, 'rev-parse', 'HEAD');
    const result = await revertRange(git, dir, `${start}..HEAD`, 'revert: x', bot);
    expect(result).toEqual({ status: 'human', shas: [humanSha] });
    expect(raw(dir, 'rev-parse', 'HEAD')).toBe(head);
    expect(existsSync(path.join(dir, 'a.ts'))).toBe(true);
  });

  it('compares the author address without caring about case', async () => {
    const dir = repo();
    const start = raw(dir, 'rev-parse', 'HEAD');
    write(dir, 'a.ts', 'one');
    await commitAll(git, dir, 'feat: a', bot);
    expect((await revertRange(git, dir, `${start}..HEAD`, 'revert: x', { ...bot, email: 'BOT@Example.com' })).status).toBe('reverted');
  });

  it('on a conflict aborts cleanly, leaves the work as it was and names the files', async () => {
    const dir = repo();
    const start = raw(dir, 'rev-parse', 'HEAD');
    write(dir, 'shared.ts', 'line 1\n');
    await commitAll(git, dir, 'feat: add shared', bot);
    write(dir, 'shared.ts', 'line 1\nline 2 from the second commit\n');
    await commitAll(git, dir, 'feat: extend shared', bot);
    // Reverting only the FIRST commit conflicts with the second one's change.
    const first = raw(dir, 'rev-list', '--reverse', `${start}..HEAD`).split('\n')[0] as string;
    const head = raw(dir, 'rev-parse', 'HEAD');
    const result = await revertRange(git, dir, `${first}^..${first}`, 'revert: x', bot);
    expect(result).toMatchObject({ status: 'conflict', files: ['shared.ts'] });
    expect(raw(dir, 'rev-parse', 'HEAD')).toBe(head);
    expect(raw(dir, 'status', '--porcelain')).toBe('');
    expect(readFileSync(path.join(dir, 'shared.ts'), 'utf8')).toContain('line 2 from the second commit');
  });

  it('drops uncommitted leftovers of the stale attempt, which rewrites no history', async () => {
    const dir = repo();
    const start = raw(dir, 'rev-parse', 'HEAD');
    write(dir, 'a.ts', 'one');
    await commitAll(git, dir, 'feat: a', bot);
    write(dir, 'leftover.ts', 'half done'); // untracked
    write(dir, 'a.ts', 'one, edited but not committed');
    expect((await revertRange(git, dir, `${start}..HEAD`, 'revert: x', bot)).status).toBe('reverted');
    expect(existsSync(path.join(dir, 'leftover.ts'))).toBe(false);
    expect(existsSync(path.join(dir, 'a.ts'))).toBe(false);
    expect(raw(dir, 'status', '--porcelain')).toBe('');
  });

  it('refuses an attribution in the message, like every commit (the guard still applies)', async () => {
    const dir = repo();
    const start = raw(dir, 'rev-parse', 'HEAD');
    write(dir, 'a.ts', 'one');
    await commitAll(git, dir, 'feat: a', bot);
    await expect(revertRange(git, dir, `${start}..HEAD`, 'revert: x\n\nCo-Authored-By: Someone <a@b.c>', bot)).rejects.toThrow('commits carry no AI attribution');
    expect(raw(dir, 'status', '--porcelain')).toBe(''); // the staged revert did not stay behind
    expect(existsSync(path.join(dir, 'a.ts'))).toBe(true);
  });
});
