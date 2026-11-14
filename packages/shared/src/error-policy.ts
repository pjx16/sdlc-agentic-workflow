/**
 * Error codes, who is responsible, and what to do about each (BUILD_PLAN v1 6.3). One table, used by the worker,
 * the API and the dashboard, so a failure reads the same everywhere.
 */

export const ERROR_SOURCES = ['claude', 'agent', 'workspace', 'integration', 'user'] as const;
export type ErrorSource = (typeof ERROR_SOURCES)[number];

/** Who the dashboard names on the badge. Integrations are split so the badge says Jira, GitHub, Git or Confluence. */
export type ErrorBadge = 'Claude' | 'Agent' | 'Workspace' | 'Jira' | 'Confluence' | 'GitHub' | 'Git' | 'User';

export const ERROR_CODES = [
  'CLAUDE_AUTH', 'CLAUDE_RATE_LIMIT', 'CLAUDE_USAGE_LIMIT', 'CLAUDE_API_ERROR', 'CLAUDE_CONTEXT_TOO_LONG',
  'TURN_LIMIT', 'INVALID_OUTPUT', 'NEEDS_INPUT', 'BLOCKED', 'GUARD_VIOLATION',
  'TESTS_STILL_FAILING', 'CONTAINER_ERROR', 'TIMEOUT',
  'GIT_ERROR', 'GITHUB_ERROR', 'JIRA_ERROR', 'CONFLUENCE_ERROR', 'KILLED',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export type Recovery =
  /** Pause every Claude stage until the credential works again; the ticket does not fail. */
  | { kind: 'pause_global' }
  /** Pause until Claude's reset time, then carry on. */
  | { kind: 'pause_until_reset' }
  /** Retry automatically, waiting `backoffMin[n]` minutes before attempt n+1, then do `then`. */
  | { kind: 'retry'; retries: number; backoffMin: readonly number[]; then: 'hold' | 'fail'; turnFactor?: number; withErrors?: boolean }
  | { kind: 'hold' }
  /** A write-back to an outside system: retry, log a warning, never block the ticket. */
  | { kind: 'retry_never_block'; retries: number; backoffMin: readonly number[] }
  | { kind: 'none' };

export interface ErrorPolicy {
  source: ErrorSource;
  badge: ErrorBadge;
  recovery: Recovery;
  /** Plain-English message. `{name}` placeholders are filled by `describeError`. */
  message: string;
  /** What the person can do about it, shown under the message. */
  action: string;
}

const hold: Recovery = { kind: 'hold' };

export const ERROR_POLICY: Record<ErrorCode, ErrorPolicy> = {
  CLAUDE_AUTH: { source: 'claude', badge: 'Claude', recovery: { kind: 'pause_global' }, message: 'Claude rejected the credential. Update it in Settings → Connections.', action: 'Update the Claude token in Settings → Connections. The pipeline resumes by itself.' },
  CLAUDE_RATE_LIMIT: { source: 'claude', badge: 'Claude', recovery: { kind: 'pause_until_reset' }, message: 'Claude rate limit reached. Resuming at {time}.', action: 'Nothing: the pipeline resumes at the reset time.' },
  CLAUDE_USAGE_LIMIT: { source: 'claude', badge: 'Claude', recovery: { kind: 'pause_until_reset' }, message: 'Claude usage limit reached. Resuming at {time}.', action: 'Nothing: the pipeline resumes at the reset time.' },
  CLAUDE_API_ERROR: { source: 'claude', badge: 'Claude', recovery: { kind: 'retry', retries: 3, backoffMin: [1, 4, 10], then: 'hold' }, message: 'Claude API error ({detail}). Retry {n}/3 at {time}.', action: 'Nothing while retries remain. After the third, resume the ticket when Claude is back.' },
  CLAUDE_CONTEXT_TOO_LONG: { source: 'claude', badge: 'Claude', recovery: hold, message: 'The input for {stage} was too large ({sizes}).', action: 'Shrink the input (a smaller plan or diff) and resume.' },
  TURN_LIMIT: { source: 'agent', badge: 'Agent', recovery: { kind: 'retry', retries: 1, backoffMin: [0], then: 'hold', turnFactor: 1.5 }, message: '{agent} ran out of turns.', action: 'Rerun with a note, or raise the stage turn limit in Advanced settings.' },
  INVALID_OUTPUT: { source: 'agent', badge: 'Agent', recovery: { kind: 'retry', retries: 1, backoffMin: [0], then: 'hold', withErrors: true }, message: '{agent} returned output that did not match the expected shape.', action: 'Resume to try again, or rerun the stage with a note.' },
  NEEDS_INPUT: { source: 'agent', badge: 'Agent', recovery: hold, message: '{question}', action: 'Answer the question.' },
  BLOCKED: { source: 'agent', badge: 'Agent', recovery: hold, message: '{reason}', action: 'Read the reason, fix what blocks the agent, then resume.' },
  GUARD_VIOLATION: { source: 'agent', badge: 'Agent', recovery: { kind: 'retry', retries: 1, backoffMin: [0], then: 'hold' }, message: '{agent} edited files it may not change: {files}.', action: 'Resume to try again, or rerun the stage with a note.' },
  TESTS_STILL_FAILING: { source: 'workspace', badge: 'Workspace', recovery: hold, message: 'Tests still fail after {n} fix rounds.', action: 'Read the failing output, then rerun the subtask with a note or fix it by hand.' },
  CONTAINER_ERROR: { source: 'workspace', badge: 'Workspace', recovery: { kind: 'retry', retries: 1, backoffMin: [0], then: 'fail' }, message: 'The agent container failed: {detail}.', action: 'Check that Docker is running and the agent image exists, then retry the ticket.' },
  TIMEOUT: { source: 'workspace', badge: 'Workspace', recovery: { kind: 'retry', retries: 1, backoffMin: [0], then: 'fail' }, message: '{stage} took longer than {limit}.', action: 'Raise the stage time limit in Settings, or split the work.' },
  GIT_ERROR: { source: 'integration', badge: 'Git', recovery: { kind: 'retry', retries: 3, backoffMin: [1, 4, 10], then: 'hold' }, message: 'Git failed: {detail}.', action: 'Check the repository and the GitHub token, then resume.' },
  GITHUB_ERROR: { source: 'integration', badge: 'GitHub', recovery: { kind: 'retry', retries: 3, backoffMin: [1, 4, 10], then: 'hold' }, message: 'GitHub failed: {detail}.', action: 'Check the GitHub token and its permissions, then resume.' },
  JIRA_ERROR: { source: 'integration', badge: 'Jira', recovery: { kind: 'retry_never_block', retries: 3, backoffMin: [1, 4, 10] }, message: 'Jira failed: {detail}.', action: 'Check the Atlassian credential. The ticket carries on without Jira.' },
  CONFLUENCE_ERROR: { source: 'integration', badge: 'Confluence', recovery: { kind: 'retry_never_block', retries: 3, backoffMin: [1, 4, 10] }, message: 'Confluence failed: {detail}. The plan was posted to Jira instead.', action: 'Check the Atlassian credential and the Confluence space.' },
  KILLED: { source: 'user', badge: 'User', recovery: { kind: 'none' }, message: 'Stopped from the dashboard.', action: 'Resume the ticket when you are ready.' },
};

export const isErrorCode = (v: unknown): v is ErrorCode => typeof v === 'string' && (ERROR_CODES as readonly string[]).includes(v);

export const errorSourceOf = (code: ErrorCode): ErrorSource => ERROR_POLICY[code].source;

/** Fills `{placeholders}`; one that has no value is left out together with its brackets. */
export function describeError(code: ErrorCode, vars: Record<string, string | number | undefined> = {}): string {
  return ERROR_POLICY[code].message.replace(/\{(\w+)\}/g, (_, k: string) => (vars[k] === undefined ? '' : String(vars[k]))).replace(/\s+\(\)/g, '').replace(/\s+([.,])/g, '$1').trim();
}

/** Backoff before retry number `attempt` (1-based), in minutes, or null when the policy has no more retries. */
export function nextBackoffMin(code: ErrorCode, attempt: number): number | null {
  const r = ERROR_POLICY[code].recovery;
  if (r.kind !== 'retry' && r.kind !== 'retry_never_block') return null;
  if (attempt > r.retries) return null;
  return r.backoffMin[Math.min(attempt - 1, r.backoffMin.length - 1)] ?? 0;
}

const AUTH = /authentication_error|invalid bearer token|oauth token (has )?(expired|revoked)|invalid api key|failed to authenticate|401 unauthorized/i;
const USAGE = /usage limit|limit reached|out of (extra )?usage|credit balance is too low/i;
const RATE = /rate.?limit|too many requests|\b429\b/i;
const CONTEXT = /prompt is too long|context (length|window)|maximum context|input is too long|too many tokens/i;
const API = /overloaded|\b529\b|\b5\d\d\b (error|internal)|internal server error|service unavailable|bad gateway|gateway timeout|econnreset|etimedout|enotfound|socket hang up|network error|fetch failed|api error/i;

/**
 * Names a Claude-side failure from the CLI's result text or stderr (and the HTTP status when the result had one).
 * Order matters: a usage limit also contains "limit", and an auth failure can be a 401.
 */
export function classifyClaudeError(text: string, status?: number | null): ErrorCode | null {
  if (status === 401 || AUTH.test(text)) return 'CLAUDE_AUTH';
  if (CONTEXT.test(text)) return 'CLAUDE_CONTEXT_TOO_LONG';
  if (USAGE.test(text)) return 'CLAUDE_USAGE_LIMIT';
  if (status === 429 || RATE.test(text)) return 'CLAUDE_RATE_LIMIT';
  if ((typeof status === 'number' && status >= 500) || API.test(text)) return 'CLAUDE_API_ERROR';
  return null;
}
