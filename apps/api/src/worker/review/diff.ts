import type { GitRunner } from '../git/git-runner';

/**
 * Files that are left out of the diff the review stages see (F10): lockfiles, build output, snapshots and other generated
 * files. They are noise for a reviewer and can be enormous.
 */
export const DIFF_EXCLUDES: readonly string[] = [
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'Cargo.lock', 'poetry.lock', 'Gemfile.lock', 'composer.lock',
  '**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml',
  '**/dist/**', '**/build/**', '**/coverage/**', '**/.next/**', '**/out/**',
  '**/__snapshots__/**', '**/*.snap', '**/*.min.js', '**/*.min.css', '**/*.map',
  '**/*.generated.*', '**/generated/**', '**/*.lock',
].map((p) => `:(exclude,glob)${p}`);

export interface DiffResult {
  /** The unified diff, with excluded files left out. */
  patch: string;
  lines: number;
  /** `git diff --stat` for the same range. */
  stat: string;
}

/** Diff between two refs (`from...to` for a branch point, `from..to` for "since this commit"), without excluded files. */
export async function computeDiff(git: GitRunner, workspace: string, range: { from: string; to?: string; mergeBase?: boolean }): Promise<DiffResult> {
  const spec = `${range.from}${range.mergeBase ? '...' : '..'}${range.to ?? 'HEAD'}`;
  const args = ['--no-pager', 'diff', '--no-color', '--no-ext-diff', spec, '--', '.', ...DIFF_EXCLUDES];
  const patch = (await git.run(args, { cwd: workspace })).stdout;
  const stat = (await git.run(['--no-pager', 'diff', '--no-color', '--stat', spec, '--', '.', ...DIFF_EXCLUDES], { cwd: workspace })).stdout.trim();
  return { patch, lines: patch === '' ? 0 : patch.split('\n').length - (patch.endsWith('\n') ? 1 : 0), stat };
}

/** The paths a range changes, for the security reviewer's trigger. */
export async function computeChangedPaths(git: GitRunner, workspace: string, range: { from: string; to?: string; mergeBase?: boolean }): Promise<string[]> {
  const spec = `${range.from}${range.mergeBase ? '...' : '..'}${range.to ?? 'HEAD'}`;
  const out = (await git.run(['--no-pager', 'diff', '--no-color', '--name-only', spec, '--', '.', ...DIFF_EXCLUDES], { cwd: workspace })).stdout;
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}
