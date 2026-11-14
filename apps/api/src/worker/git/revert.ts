import { commitAll, type GitIdentity } from './commit';
import { type GitRunner } from './git-runner';

export type RevertResult =
  | { status: 'nothing' }
  | { status: 'reverted'; sha: string; commits: number }
  /** A commit in the range was not made by the orchestrator (a person pushed to the branch): nothing was touched. */
  | { status: 'human'; shas: string[] }
  /** A revert conflicts with later changes: nothing was touched. */
  | { status: 'conflict'; files: string[] };

/**
 * Removes stale work with a revert commit, never a reset or a force-push (BUILD_PLAN v1 D1): history is append-only.
 * `range` is a git revision range such as `<sha>..HEAD`. The orchestrator is the only author of the commits it may revert:
 * if anyone else committed in the range, nothing is touched. A conflict aborts cleanly and names the files.
 */
export async function revertRange(git: GitRunner, workspace: string, range: string, message: string, identity: GitIdentity): Promise<RevertResult> {
  const log = (await git.out(['log', '--format=%H%x09%ae', range], { cwd: workspace })).split('\n').filter(Boolean);
  if (log.length === 0) return { status: 'nothing' };
  const others = log.map((l) => l.split('\t') as [string, string]).filter(([, email]) => email.trim().toLowerCase() !== identity.email.trim().toLowerCase());
  if (others.length > 0) return { status: 'human', shas: others.map(([sha]) => sha.slice(0, 8)) };

  // Uncommitted leftovers of the stale attempt go first. This rewrites no history; the workspace is the agent's, not a person's.
  await git.run(['reset', '--hard', 'HEAD'], { cwd: workspace });
  await git.run(['clean', '-fd', '-e', 'node_modules'], { cwd: workspace });
  try {
    await git.run(['revert', '--no-commit', range], { cwd: workspace });
  } catch {
    const files = (await git.out(['diff', '--name-only', '--diff-filter=U'], { cwd: workspace }).catch(() => '')).split('\n').filter(Boolean);
    // Leave the workspace exactly as it was.
    await git.run(['revert', '--abort'], { cwd: workspace }).catch(() => undefined);
    await git.run(['reset', '--hard', 'HEAD'], { cwd: workspace }).catch(() => undefined);
    return { status: 'conflict', files };
  }
  let result;
  try {
    result = await commitAll(git, workspace, message, identity);
  } catch (err) {
    // A refused message or a guard failure must not leave the staged revert in the workspace.
    await git.run(['reset', '--hard', 'HEAD'], { cwd: workspace }).catch(() => undefined);
    throw err;
  }
  return result.committed ? { status: 'reverted', sha: result.sha, commits: log.length } : { status: 'nothing' };
}
