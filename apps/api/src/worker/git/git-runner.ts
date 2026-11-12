import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Used when GIT_ASKPASS is not set (local development); the worker image sets it. */
export const DEFAULT_ASKPASS = path.resolve(__dirname, '../../../../../docker/worker/git-askpass-token');

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export interface GitRunOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Extra environment (for example the commit identity). */
  env?: Record<string, string>;
  /** Run repository hooks. Always false for the worker: hooks of a target repository never run there (F5, 6.2). */
  hooks?: boolean;
}

export interface GitRunnerConfig {
  githubToken: string;
}

/**
 * Runs the git CLI. The GitHub token only ever reaches git through the GIT_ASKPASS helper's environment:
 * never in a URL, never in a git config file (BUILD_PLAN 6.2).
 */
export class GitRunner {
  constructor(private readonly config: GitRunnerConfig) {}

  async run(args: readonly string[], opts: GitRunOptions = {}): Promise<{ stdout: string; stderr: string }> {
    // `core.hooksPath=/dev/null` disables every hook, including pre-commit, commit-msg and pre-push.
    const full = opts.hooks ? [...args] : ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args];
    try {
      const { stdout, stderr } = await exec('git', full, {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 10 * 60 * 1000,
        maxBuffer: 20 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_ASKPASS: process.env.GIT_ASKPASS ?? DEFAULT_ASKPASS,
          GITHUB_TOKEN: this.config.githubToken,
          GIT_TERMINAL_PROMPT: '0',
          ...opts.env,
        },
      });
      return { stdout, stderr };
    } catch (err) {
      const e = err as { stderr?: string; code?: number | string; killed?: boolean; message?: string };
      let stderr = (e.stderr ?? e.message ?? '').toString().trim();
      if (this.config.githubToken) stderr = stderr.split(this.config.githubToken).join('***');
      const first = stderr.split('\n').find((l) => /^(fatal|error|remote):/i.test(l.trim())) ?? stderr.split('\n')[0] ?? 'git failed';
      throw new GitError(e.killed ? 'git timed out' : first.slice(0, 500), args, stderr, typeof e.code === 'number' ? e.code : null);
    }
  }

  async out(args: readonly string[], opts: GitRunOptions = {}): Promise<string> {
    return (await this.run(args, opts)).stdout.trim();
  }
}
