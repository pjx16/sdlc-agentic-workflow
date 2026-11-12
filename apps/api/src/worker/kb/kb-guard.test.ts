import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GitRunner } from '../git/git-runner';
import { changedPaths, revertDir, revertOutsideDir } from './kb-guard';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
const git = new GitRunner({ token: async () => '' });
let ws: string;
const write = (rel: string, content = 'x') => {
  mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
  writeFileSync(path.join(ws, rel), content);
};

beforeAll(() => {
  ws = mkdtempSync(path.join(tmpdir(), 'sdlc-guard-'));
  execFileSync('git', ['init', '-q', '-b', 'dev', ws]);
  write('src/app.ts', 'original');
  write('src/keep.ts', 'keep');
  write('README.md', 'readme');
  write('docs/kb/existing.md', 'existing doc');
  sh(ws, 'add', '.');
  sh(ws, 'commit', '-q', '-m', 'init');
});
afterAll(() => rmSync(ws, { recursive: true, force: true }));
beforeEach(() => {
  sh(ws, 'reset', '-q', '--hard');
  sh(ws, 'clean', '-fdq');
});

describe('revertOutsideDir (F6)', () => {
  it('keeps changes under the KB directory and reverts everything else, tracked or new', async () => {
    write('docs/kb/new-doc.md', 'new doc');
    write('docs/kb/existing.md', 'edited doc');
    write('src/app.ts', 'EDITED');
    write('src/brand-new.ts', 'oops');
    write('deep/nested/file.txt', 'oops');
    rmSync(path.join(ws, 'README.md'));
    const reverted = await revertOutsideDir(git, ws, 'docs/kb');
    expect(reverted.sort()).toEqual(['README.md', 'deep/nested/file.txt', 'src/app.ts', 'src/brand-new.ts']);
    expect(readFileSync(path.join(ws, 'src/app.ts'), 'utf8')).toBe('original');
    expect(readFileSync(path.join(ws, 'README.md'), 'utf8')).toBe('readme');
    expect(existsSync(path.join(ws, 'src/brand-new.ts'))).toBe(false);
    expect(existsSync(path.join(ws, 'deep'))).toBe(false);
    expect(readFileSync(path.join(ws, 'docs/kb/new-doc.md'), 'utf8')).toBe('new doc');
    expect(readFileSync(path.join(ws, 'docs/kb/existing.md'), 'utf8')).toBe('edited doc');
    expect((await changedPaths(git, ws)).map((e) => e.path).sort()).toEqual(['docs/kb/existing.md', 'docs/kb/new-doc.md']);
  });

  it('reverts staged changes, renames and staged new files too', async () => {
    write('src/staged.ts', 'staged');
    sh(ws, 'add', 'src/staged.ts');
    sh(ws, 'mv', 'src/keep.ts', 'src/renamed.ts');
    const reverted = await revertOutsideDir(git, ws, 'docs/kb');
    expect(reverted.length).toBeGreaterThanOrEqual(2);
    expect(existsSync(path.join(ws, 'src/staged.ts'))).toBe(false);
    expect(existsSync(path.join(ws, 'src/keep.ts'))).toBe(true);
    expect(existsSync(path.join(ws, 'src/renamed.ts'))).toBe(false);
    expect(sh(ws, 'status', '--porcelain')).toBe('');
  });

  it('does nothing when only the KB directory changed', async () => {
    write('docs/kb/a.md', 'a');
    expect(await revertOutsideDir(git, ws, 'docs/kb')).toEqual([]);
    expect(await revertOutsideDir(git, ws, './docs/kb/')).toEqual([]); // the directory may be written differently
  });

  it('never touches node_modules, even when the repository does not ignore it', async () => {
    write('node_modules/pkg/index.js', 'dependency');
    write('src/oops.ts', 'oops');
    const reverted = await revertOutsideDir(git, ws, 'docs/kb');
    expect(reverted).toEqual(['src/oops.ts']);
    expect(existsSync(path.join(ws, 'node_modules/pkg/index.js'))).toBe(true);
  });

  it('does not treat a sibling with the same prefix as the KB directory', async () => {
    write('docs/kb-other/x.md', 'not the kb dir');
    expect(await revertOutsideDir(git, ws, 'docs/kb')).toEqual(['docs/kb-other/x.md']);
  });

  it('handles file names with spaces and unusual characters', async () => {
    write('src/with space.ts', 'x');
    write('src/ünïcode.ts', 'x');
    expect((await revertOutsideDir(git, ws, 'docs/kb')).sort()).toEqual(['src/with space.ts', 'src/ünïcode.ts']);
  });
});

describe('revertDir', () => {
  it('discards every change under a directory and leaves the rest', async () => {
    write('docs/kb/new.md', 'n');
    write('docs/kb/existing.md', 'edited');
    write('src/app.ts', 'EDITED');
    expect((await revertDir(git, ws, 'docs/kb')).sort()).toEqual(['docs/kb/existing.md', 'docs/kb/new.md']);
    expect(readFileSync(path.join(ws, 'docs/kb/existing.md'), 'utf8')).toBe('existing doc');
    expect(readFileSync(path.join(ws, 'src/app.ts'), 'utf8')).toBe('EDITED');
  });
});
