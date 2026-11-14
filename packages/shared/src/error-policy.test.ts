import { describe, expect, it } from 'vitest';
import { ERROR_CODES, ERROR_POLICY, classifyClaudeError, describeError, errorSourceOf, nextBackoffMin } from './error-policy';

describe('error policy table', () => {
  it.each(ERROR_CODES)('%s has a source, a message and an action', (code) => {
    const p = ERROR_POLICY[code];
    expect(p.message.length).toBeGreaterThan(5);
    expect(p.action.length).toBeGreaterThan(5);
    expect(['claude', 'agent', 'workspace', 'integration', 'user']).toContain(errorSourceOf(code));
  });

  it('fills placeholders and drops empty ones', () => {
    expect(describeError('CLAUDE_RATE_LIMIT', { time: '14:32' })).toBe('Claude rate limit reached. Resuming at 14:32.');
    expect(describeError('CLAUDE_API_ERROR', { detail: '529', n: 1, time: '14:32' })).toBe('Claude API error (529). Retry 1/3 at 14:32.');
    expect(describeError('TURN_LIMIT', { agent: 'coder' })).toBe('coder ran out of turns.');
    expect(describeError('GIT_ERROR', { detail: 'push rejected' })).toBe('Git failed: push rejected.');
  });

  it('retries the Claude API error three times with 1, 4 and 10 minutes, then stops', () => {
    expect([1, 2, 3, 4].map((n) => nextBackoffMin('CLAUDE_API_ERROR', n))).toEqual([1, 4, 10, null]);
    expect(nextBackoffMin('TURN_LIMIT', 1)).toBe(0);
    expect(nextBackoffMin('TURN_LIMIT', 2)).toBeNull();
    expect(nextBackoffMin('CLAUDE_AUTH', 1)).toBeNull();
  });

  it('recovery rules follow BUILD_PLAN 6.3', () => {
    expect(ERROR_POLICY.CLAUDE_AUTH.recovery.kind).toBe('pause_global');
    expect(ERROR_POLICY.CLAUDE_RATE_LIMIT.recovery.kind).toBe('pause_until_reset');
    expect(ERROR_POLICY.CLAUDE_USAGE_LIMIT.recovery.kind).toBe('pause_until_reset');
    expect(ERROR_POLICY.CONTAINER_ERROR.recovery).toMatchObject({ kind: 'retry', retries: 1, then: 'fail' });
    expect(ERROR_POLICY.TIMEOUT.recovery).toMatchObject({ kind: 'retry', retries: 1, then: 'fail' });
    expect(ERROR_POLICY.TURN_LIMIT.recovery).toMatchObject({ turnFactor: 1.5 });
    expect(ERROR_POLICY.INVALID_OUTPUT.recovery).toMatchObject({ withErrors: true });
    expect(ERROR_POLICY.JIRA_ERROR.recovery.kind).toBe('retry_never_block');
    expect(ERROR_POLICY.CONFLUENCE_ERROR.recovery.kind).toBe('retry_never_block');
    expect(ERROR_POLICY.KILLED.recovery.kind).toBe('none');
  });
});

describe('classifyClaudeError', () => {
  it.each([
    ['Invalid bearer token', undefined, 'CLAUDE_AUTH'],
    ['OAuth token has expired', undefined, 'CLAUDE_AUTH'],
    ['anything', 401, 'CLAUDE_AUTH'],
    ['Claude usage limit reached|1731600000', undefined, 'CLAUDE_USAGE_LIMIT'],
    ['rate limit exceeded', undefined, 'CLAUDE_RATE_LIMIT'],
    ['anything', 429, 'CLAUDE_RATE_LIMIT'],
    ['API Error: 529 overloaded_error', undefined, 'CLAUDE_API_ERROR'],
    ['anything', 503, 'CLAUDE_API_ERROR'],
    ['read ECONNRESET', undefined, 'CLAUDE_API_ERROR'],
    ['Prompt is too long', undefined, 'CLAUDE_CONTEXT_TOO_LONG'],
  ] as const)('%s (%s) -> %s', (text, status, code) => {
    expect(classifyClaudeError(text, status)).toBe(code);
  });
  it('returns null for text that is not a Claude-side failure', () => {
    expect(classifyClaudeError('The stage exited with code 1')).toBeNull();
    expect(classifyClaudeError('')).toBeNull();
  });
});
