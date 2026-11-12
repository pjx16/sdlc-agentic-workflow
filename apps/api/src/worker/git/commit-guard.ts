import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import { parsePorcelain } from './changes';
import { HARDENING_FLAGS, type GitRunner } from './git-runner';

export const MAX_FILE_BYTES = 1024 * 1024;

export interface GuardViolation {
  path: string;
  reason: string;
}

/** The commit was refused: the change includes something that must never be committed. The stage fails. */
export class CommitGuardError extends Error {
  constructor(readonly violations: readonly GuardViolation[]) {
    super(`The commit guard refused the change: ${violations.map((v) => `${v.path} (${v.reason})`).join(', ')}`);
    this.name = 'CommitGuardError';
  }
}

/** Why a path must not be committed, or null (F9): node_modules, `.env*`, key and certificate files. */
export function pathViolation(file: string): string | null {
  const segments = file.replace(/\\/g, '/').split('/');
  const base = (segments[segments.length - 1] as string).toLowerCase();
  if (segments.includes('node_modules')) return 'installed dependencies (node_modules)';
  if (base.startsWith('.env')) return 'an environment file (.env*)';
  if (base.endsWith('.pem') || base.endsWith('.key')) return 'a key or certificate file';
  return null;
}

/** Violations among files that were added or modified; `sizeOf` reports a file's size in bytes. */
export function findViolations(files: readonly string[], sizeOf: (file: string) => number): GuardViolation[] {
  const out: GuardViolation[] = [];
  for (const file of files) {
    const reason = pathViolation(file);
    if (reason) {
      out.push({ path: file, reason });
      continue;
    }
    const size = sizeOf(file);
    if (size > MAX_FILE_BYTES) out.push({ path: file, reason: `larger than 1 MB (${Math.ceil(size / 1024 / 1024)} MB)` });
  }
  return out;
}

/** The files staged for the next commit, excluding deletions (removing a file is always allowed). */
async function stagedFiles(git: GitRunner, workspace: string): Promise<string[]> {
  const out = (await git.run(['diff', '--cached', '--name-status', '-z', '--no-renames'], { cwd: workspace })).stdout;
  const parts = out.split('\0').filter(Boolean);
  const files: string[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i] !== 'D') files.push(parts[i + 1] as string);
  return files;
}

/**
 * Checks what is staged. On a violation the index is cleared (so nothing is left half-staged) and CommitGuardError is thrown.
 * Run before every orchestrator commit.
 */
export async function assertStagedChangeIsSafe(git: GitRunner, workspace: string): Promise<void> {
  const files = await stagedFiles(git, workspace);
  const violations = findViolations(files, (f) => {
    try {
      return lstatSync(path.join(workspace, f)).size;
    } catch {
      return 0;
    }
  });
  if (violations.length > 0) {
    await git.run(['reset', '-q'], { cwd: workspace });
    throw new CommitGuardError(violations);
  }
}

/**
 * If the agent made its own commits during a stage, `git reset --soft` back to the pre-stage HEAD so the orchestrator makes the
 * commit itself (F9). Returns how many agent commits were squashed back.
 */
export async function squashAgentCommits(git: GitRunner, workspace: string, preStageHead: string): Promise<number> {
  const head = await git.out(['rev-parse', 'HEAD'], { cwd: workspace });
  if (head === preStageHead) return 0;
  const count = Number(await git.out(['rev-list', '--count', `${preStageHead}..HEAD`], { cwd: workspace }).catch(() => '0'));
  await git.run(['reset', '--soft', preStageHead], { cwd: workspace });
  return Number.isFinite(count) ? count : 0;
}

/**
 * Violations among everything a stage changed or added in the working tree (installed dependencies included). Synchronous, so it can
 * be part of a stage's output validation: a stage that leaves a secret or a huge file behind fails its attempt (BUILD_PLAN 6.8).
 */
export function workspaceViolationsSync(workspace: string): GuardViolation[] {
  const out = execFileSync('git', [...HARDENING_FLAGS, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: workspace, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const files = parsePorcelain(out).filter((c) => !c.status.includes('D') && !c.path.startsWith('.git/')).map((c) => c.path);
  return findViolations(files, (f) => {
    try {
      return lstatSync(path.join(workspace, f)).size;
    } catch {
      return 0;
    }
  });
}

export const describeViolations = (violations: readonly GuardViolation[]): string => `the change includes files that must not be committed: ${violations.map((v) => `${v.path} (${v.reason})`).join(', ')}`;
