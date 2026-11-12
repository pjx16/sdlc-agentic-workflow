import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitRunner } from '../git/git-runner';
import { DIFF_EXCLUDES, computeDiff } from './diff';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
const git = new GitRunner({ token: async () => '' });
let ws: string;
const write = (rel: string, content: string) => {
  mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
  writeFileSync(path.join(ws, rel), content);
};

beforeAll(() => {
  ws = mkdtempSync(path.join(tmpdir(), 'sdlc-diff-'));
  execFileSync('git', ['init', '-q', '-b', 'dev', ws]);
  write('src/app.ts', 'export const app = 1;\n');
  sh(ws, 'add', '.');
  sh(ws, 'commit', '-q', '-m', 'base');
  sh(ws, 'update-ref', 'refs/remotes/origin/dev', 'HEAD');
  sh(ws, 'checkout', '-q', '-b', 'feature/x');
});
afterAll(() => rmSync(ws, { recursive: true, force: true }));

describe('computeDiff (F10)', () => {
  it('shows real changes from the branch point, and leaves out lockfiles, build output, snapshots and generated files', async () => {
    write('src/feature.ts', 'export const feature = 2;\n');
    write('package-lock.json', '{"lock":1}\n');
    write('apps/web/yarn.lock', 'lock\n');
    write('pnpm-lock.yaml', 'lock: 1\n');
    write('dist/bundle.js', 'bundle\n');
    write('packages/a/dist/index.js', 'x\n');
    write('src/__snapshots__/a.test.ts.snap', 'snap\n');
    write('src/render.test.ts.snap', 'snap\n');
    write('src/schema.generated.ts', 'generated\n');
    write('src/generated/types.ts', 'generated\n');
    write('public/app.min.js', 'min\n');
    write('coverage/lcov.info', 'cov\n');
    sh(ws, 'add', '-A');
    sh(ws, 'commit', '-q', '-m', 'work');

    const d = await computeDiff(git, ws, { from: 'origin/dev', mergeBase: true });
    expect(d.patch).toContain('src/feature.ts');
    for (const excluded of ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'dist/', '__snapshots__', '.snap', '.generated.', 'generated/', '.min.js', 'coverage/']) expect(d.patch, excluded).not.toContain(excluded);
    expect(d.stat).toContain('src/feature.ts');
    expect(d.stat).not.toContain('package-lock.json');
    expect(d.lines).toBe(d.patch.split('\n').length - 1);
    expect(d.lines).toBeGreaterThan(3);
  });

  it('a range "since this commit" contains only what came after it (round 2)', async () => {
    const reviewed = sh(ws, 'rev-parse', 'HEAD');
    write('src/fix.ts', 'export const fix = 3;\n');
    sh(ws, 'add', '-A');
    sh(ws, 'commit', '-q', '-m', 'fix after review');
    const d = await computeDiff(git, ws, { from: reviewed, mergeBase: false });
    expect(d.patch).toContain('src/fix.ts');
    expect(d.patch).not.toContain('src/feature.ts');
  });

  it('an empty range gives an empty patch and zero lines', async () => {
    const head = sh(ws, 'rev-parse', 'HEAD');
    expect(await computeDiff(git, ws, { from: head })).toMatchObject({ patch: '', lines: 0, stat: '' });
  });

  it('lists every pathspec as an exclusion', () => {
    expect(DIFF_EXCLUDES.every((p) => p.startsWith(':(exclude,glob)'))).toBe(true);
    expect(DIFF_EXCLUDES.length).toBeGreaterThan(15);
  });
});
