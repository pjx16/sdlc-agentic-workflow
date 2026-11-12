import { readdir, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { type Change, parsePorcelain } from '../git/changes';
import type { GitRunner } from '../git/git-runner';

/** Dependencies installed by the worker live inside the workspace; they are never part of a stage's changes. */
const IGNORED_PREFIXES = ['node_modules/', '.git/'];

/** Deleting an untracked file must not leave its now-empty directories behind. */
async function removeEmptyParents(workspace: string, rel: string): Promise<void> {
  let dir = path.dirname(path.join(workspace, rel));
  while (dir.startsWith(workspace + path.sep)) {
    if ((await readdir(dir).catch(() => ['x'])).length > 0) return;
    await rmdir(dir).catch(() => undefined);
    dir = path.dirname(dir);
  }
}

const within = (rel: string, dir: string) => {
  const clean = dir.replace(/^\.?\/+|\/+$/g, '');
  return rel === clean || rel.startsWith(`${clean}/`);
};

/** The changed paths in a workspace (porcelain v1, one entry per file), with their status codes. */
export async function changedPaths(git: GitRunner, workspace: string): Promise<Change[]> {
  return parsePorcelain((await git.run(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: workspace })).stdout);
}

/**
 * After kbBuild (and kbUpdate) only files under `kbDir` may have changed (F6). Anything else is reverted: tracked
 * changes are restored from HEAD, new files are deleted. Returns the reverted paths, to be logged as a warning.
 */
export async function revertOutsideDir(git: GitRunner, workspace: string, kbDir: string): Promise<string[]> {
  const reverted: string[] = [];
  for (const { status, path: rel } of await changedPaths(git, workspace)) {
    if (within(rel, kbDir) || IGNORED_PREFIXES.some((p) => rel.startsWith(p))) continue;
    if (status === '??') {
      await rm(path.join(workspace, rel), { recursive: true, force: true });
      await removeEmptyParents(workspace, rel);
    } else {
      // Staged and unstaged changes, including deletions and renames, go back to HEAD.
      await git.run(['restore', '--source=HEAD', '--staged', '--worktree', '--', rel], { cwd: workspace }).catch(async () => {
        await git.run(['rm', '-f', '--cached', '--ignore-unmatch', '--', rel], { cwd: workspace });
        await rm(path.join(workspace, rel), { recursive: true, force: true });
        await removeEmptyParents(workspace, rel);
      });
    }
    reverted.push(rel);
  }
  return reverted;
}

/** Throws away every change under `dir` too (used when a stage was not supposed to write anything there). */
export async function revertDir(git: GitRunner, workspace: string, dir: string): Promise<string[]> {
  const reverted: string[] = [];
  for (const { status, path: rel } of await changedPaths(git, workspace)) {
    if (!within(rel, dir)) continue;
    if (status === '??') {
      await rm(path.join(workspace, rel), { recursive: true, force: true });
      await removeEmptyParents(workspace, rel);
    } else await git.run(['restore', '--source=HEAD', '--staged', '--worktree', '--', rel], { cwd: workspace });
    reverted.push(rel);
  }
  return reverted;
}
