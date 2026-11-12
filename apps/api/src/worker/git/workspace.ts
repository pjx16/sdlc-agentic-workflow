import { existsSync } from 'node:fs';
import { chmod, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { GitRunner } from './git-runner';

const exec = promisify(execFile);

export interface WorkspaceSpec {
  /** Bare mirror of the repository. */
  mirrorPath: string;
  /** The real repository URL; origin is reset to it so pushes go there, not to the mirror. */
  repoUrl: string;
  baseBranch: string;
  /** Where the ticket's clone lives. */
  workspacePath: string;
  branch: string;
}

export interface PreparedWorkspace {
  path: string;
  branch: string;
  /** False when an existing workspace was reused (a resumed ticket keeps its commits). */
  created: boolean;
}

/**
 * Creates (or reuses) the ticket's workspace (BUILD_PLAN 6.2): refresh the mirror, standalone clone with no hardlinks,
 * origin reset to the real URL, branch created from `origin/<baseBranch>`. A standalone clone is used, not a worktree,
 * because worktrees break when mounted alone.
 */
export async function prepareWorkspace(git: GitRunner, spec: WorkspaceSpec): Promise<PreparedWorkspace> {
  await git.run(['--git-dir', spec.mirrorPath, 'remote', 'update', '--prune']);

  if (existsSync(path.join(spec.workspacePath, '.git'))) {
    const current = await git.out(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: spec.workspacePath });
    if (current !== spec.branch) await git.run(['checkout', spec.branch], { cwd: spec.workspacePath });
    return { path: spec.workspacePath, branch: spec.branch, created: false };
  }

  await mkdir(path.dirname(spec.workspacePath), { recursive: true });
  await git.run(['clone', '--no-hardlinks', '--', spec.mirrorPath, spec.workspacePath]);
  await git.run(['remote', 'set-url', 'origin', spec.repoUrl], { cwd: spec.workspacePath });
  await git.run(['checkout', '-b', spec.branch, `origin/${spec.baseBranch}`], { cwd: spec.workspacePath });
  return { path: spec.workspacePath, branch: spec.branch, created: true };
}

/**
 * The agent runs as uid 1000, so before a read-write stage the workspace must belong to it (`chown -R 1000:1000`).
 * Where chown is not permitted (a developer running the worker without root), fall back to open permissions.
 */
export async function makeWritableForAgent(workspacePath: string): Promise<'chown' | 'chmod'> {
  try {
    await exec('chown', ['-R', '1000:1000', workspacePath]);
    return 'chown';
  } catch {
    // Not root. Only entries owned by this user can be chmod-ed: the agent (uid 1000) owns what it created, and on Linux another user's
    // files cannot be changed (chmod -R would fail on them). The agent scripts use umask 000, so those are already open to everyone.
    await exec('find', [workspacePath, '-user', String(process.getuid?.() ?? 0), '-exec', 'chmod', 'a+rwX', '{}', '+']);
    await chmod(workspacePath, 0o777).catch(() => undefined);
    return 'chmod';
  }
}
