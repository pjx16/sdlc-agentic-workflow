import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Used when GIT_ASKPASS is not set (local development); the worker image sets it. */
export const DEFAULT_ASKPASS = path.resolve(__dirname, '../../../../../docker/worker/git-askpass-token');

/**
 * Prepended to every worker git call. The workspace is written by agents, so nothing in its git config is trusted:
 * no hooks (including pre-commit, commit-msg and pre-push), no fsmonitor, no credential helpers, and only https
 * (remote) and file (the mirror to workspace clone) transports.
 */
export const HARDENING_FLAGS: readonly string[] = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'credential.helper=',
  '-c', 'protocol.allow=never',
  '-c', 'protocol.https.allow=always',
  '-c', 'protocol.file.allow=always',
];

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
  /** The GitHub token, looked up on every call so a token entered in the dashboard takes effect without a restart. */
  token: () => Promise<string>;
}

/**
 * Runs the git CLI. The GitHub token only ever reaches git through the GIT_ASKPASS helper's environment:
 * never in a URL, never in a git config file (BUILD_PLAN 6.2).
 */
export class GitRunner {
  constructor(private readonly config: GitRunnerConfig) {}

  async run(args: readonly string[], opts: GitRunOptions = {}): Promise<{ stdout: string; stderr: string }> {
    const token = await this.config.token();
    const full = opts.hooks ? [...args] : [...HARDENING_FLAGS, ...args];
    try {
      const { stdout, stderr } = await exec('git', full, {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 10 * 60 * 1000,
        maxBuffer: 20 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_ASKPASS: process.env.GIT_ASKPASS ?? DEFAULT_ASKPASS,
          GITHUB_TOKEN: token,
          GIT_TERMINAL_PROMPT: '0',
          ...opts.env,
        },
      });
      return { stdout, stderr };
    } catch (err) {
      const e = err as { stderr?: string; code?: number | string; killed?: boolean; message?: string };
      let stderr = (e.stderr ?? e.message ?? '').toString().trim();
      if (token) stderr = stderr.split(token).join('***');
      const first = stderr.split('\n').find((l) => /^(fatal|error|remote):/i.test(l.trim())) ?? stderr.split('\n')[0] ?? 'git failed';
      throw new GitError(e.killed ? 'git timed out' : first.slice(0, 500), args, stderr, typeof e.code === 'number' ? e.code : null);
    }
  }

  async out(args: readonly string[], opts: GitRunOptions = {}): Promise<string> {
    return (await this.run(args, opts)).stdout.trim();
  }
}
