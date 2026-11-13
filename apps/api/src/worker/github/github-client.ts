import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { GithubFacts } from '@sdlc/shared';

const exec = promisify(execFile);

export type CheckBucket = 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel';

export interface PrCheck {
  name: string;
  bucket: CheckBucket;
}

export interface PrState {
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  mergedAt: string | null;
  /** Size of the PR; present when GitHub reports it. */
  additions?: number | null;
  deletions?: number | null;
  changedFiles?: number | null;
}

export interface OpenedPr {
  number: number;
  url: string;
}

/** What the pipeline needs from GitHub (BUILD_PLAN 8 Worker interfaces). `repo` is `owner/name`. */
export interface GitHubClient {
  openDraftPr(args: { repo: string; base: string; head: string; title: string; body: string }): Promise<OpenedPr>;
  markReady(repo: string, number: number): Promise<void>;
  comment(repo: string, number: number, body: string): Promise<void>;
  checks(repo: string, number: number): Promise<PrCheck[]>;
  /** The last 60 lines of the failing log of the branch's latest failed run, or '' if there is none. */
  failingLogTail(repo: string, branch: string): Promise<string>;
  prState(repo: string, number: number): Promise<PrState>;
  editBody(repo: string, number: number, body: string): Promise<void>;
  /** Default branch and languages of a repository, which also proves the token can reach it (onboarding). */
  repoFacts(repo: string): Promise<GithubFacts>;
}

export const GITHUB_CLIENT = Symbol('GITHUB_CLIENT');

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

/** `https://github.com/owner/repo(.git)` -> `owner/repo`. Anything else is not a GitHub repository. */
export function parseRepo(repoUrl: string): string {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(repoUrl.trim());
  if (!m) throw new GitHubError(`"${repoUrl}" is not a github.com repository URL`, []);
  return `${m[1]}/${m[2]}`;
}

const FAILED_LOG_LINES = 60;

export interface GhCliOptions {
  /** Looked up on every call. */
  token: () => Promise<string>;
  /** The gh executable (replaced by a stub in tests). */
  binary?: string;
  /** Where temporary body files go. */
  tmpDir?: string;
}

/** GitHub through the `gh` CLI with `GH_TOKEN` (BUILD_PLAN 6.3). Bodies are passed as files, never on the command line. */
export class GhCliClient implements GitHubClient {
  private readonly binary: string;

  constructor(private readonly opts: GhCliOptions) {
    this.binary = opts.binary ?? 'gh';
  }

  private async gh(args: readonly string[], opts: { allowFailure?: boolean } = {}): Promise<string> {
    const token = await this.opts.token();
    try {
      const { stdout } = await exec(this.binary, [...args], { env: { ...process.env, GH_TOKEN: token, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' }, timeout: 120_000, maxBuffer: 20 * 1024 * 1024 });
      return stdout;
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      // `gh pr checks` exits non-zero while checks are pending or failing, but still prints the JSON.
      if (opts.allowFailure && e.stdout && e.stdout.trim()) return e.stdout;
      let text = (e.stderr || e.message || 'gh failed').trim();
      if (token) text = text.split(token).join('***');
      throw new GitHubError(text.split('\n')[0]?.slice(0, 300) ?? 'gh failed', args);
    }
  }

  private async withBodyFile<T>(body: string, fn: (file: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(path.join(this.opts.tmpDir ?? tmpdir(), 'sdlc-gh-'));
    const file = path.join(dir, 'body.md');
    await writeFile(file, body, 'utf8');
    try {
      return await fn(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async openDraftPr(a: { repo: string; base: string; head: string; title: string; body: string }): Promise<OpenedPr> {
    const out = await this.withBodyFile(a.body, (file) => this.gh(['pr', 'create', '--draft', '-R', a.repo, '--base', a.base, '--head', a.head, '--title', a.title, '--body-file', file]));
    const url = out.split('\n').map((l) => l.trim()).find((l) => /\/pull\/\d+/.test(l));
    const number = url ? Number(/\/pull\/(\d+)/.exec(url)?.[1]) : Number.NaN;
    if (!url || !Number.isInteger(number)) throw new GitHubError(`could not read the pull request URL from: ${out.trim().slice(0, 200)}`, ['pr', 'create']);
    return { number, url };
  }

  async markReady(repo: string, number: number): Promise<void> {
    await this.gh(['pr', 'ready', String(number), '-R', repo]);
  }

  async comment(repo: string, number: number, body: string): Promise<void> {
    await this.withBodyFile(body, (file) => this.gh(['pr', 'comment', String(number), '-R', repo, '--body-file', file]));
  }

  async checks(repo: string, number: number): Promise<PrCheck[]> {
    // A PR with no checks counts as passing: gh reports "no checks reported", which is an empty list here.
    let out: string;
    try {
      out = await this.gh(['pr', 'checks', String(number), '-R', repo, '--json', 'name,bucket'], { allowFailure: true });
    } catch (err) {
      if (err instanceof GitHubError && /no checks reported/i.test(err.message)) return [];
      throw err;
    }
    const parsed = JSON.parse(out) as { name: string; bucket: CheckBucket }[];
    return parsed.map((c) => ({ name: c.name, bucket: c.bucket }));
  }

  async repoFacts(repo: string): Promise<GithubFacts> {
    const info = JSON.parse(await this.gh(['api', `repos/${repo}`])) as { default_branch?: string };
    const languages = JSON.parse(await this.gh(['api', `repos/${repo}/languages`])) as Record<string, number>;
    if (!info.default_branch) throw new GitHubError(`GitHub did not report a default branch for ${repo}`, ['api', `repos/${repo}`]);
    return { defaultBranch: info.default_branch, languages: Object.entries(languages).sort((a, b) => b[1] - a[1]).map(([name]) => name) };
  }

  async failingLogTail(repo: string, branch: string): Promise<string> {
    const runs = JSON.parse(await this.gh(['run', 'list', '-R', repo, '--branch', branch, '--json', 'databaseId,conclusion', '--limit', '5'])) as { databaseId: number; conclusion: string }[];
    const failed = runs.find((r) => r.conclusion === 'failure');
    if (!failed) return '';
    const log = await this.gh(['run', 'view', String(failed.databaseId), '-R', repo, '--log-failed']);
    return log.trimEnd().split('\n').slice(-FAILED_LOG_LINES).join('\n');
  }

  async prState(repo: string, number: number): Promise<PrState> {
    const parsed = JSON.parse(await this.gh(['pr', 'view', String(number), '-R', repo, '--json', 'state,mergedAt,additions,deletions,changedFiles'])) as {
      state: PrState['state'];
      mergedAt: string | null;
      additions?: number;
      deletions?: number;
      changedFiles?: number;
    };
    return { state: parsed.state, mergedAt: parsed.mergedAt ?? null, additions: parsed.additions ?? null, deletions: parsed.deletions ?? null, changedFiles: parsed.changedFiles ?? null };
  }

  async editBody(repo: string, number: number, body: string): Promise<void> {
    await this.withBodyFile(body, (file) => this.gh(['pr', 'edit', String(number), '-R', repo, '--body-file', file]));
  }
}
