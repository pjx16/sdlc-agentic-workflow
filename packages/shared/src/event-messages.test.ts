import { describe, expect, it } from 'vitest';
import { duration, events } from './event-messages';

describe('event messages read as plain English', () => {
  it('formats durations', () => {
    expect([4000, 192_000, 3_900_000].map(duration)).toEqual(['4s', '3m12s', '1h05m']);
  });
  it('a finished stage names the agent, the work, time, turns and cost', () => {
    const e = events.stageFinished({ stage: 'implement', status: 'succeeded', subtask: 2, subtasks: 4, durationMs: 192_000, turns: 18, costUsd: 0.21, detail: '7 tests passing' });
    expect(e.message).toBe('Coder finished subtask 2/4 · 3m12s · 18 turns · $0.21 · 7 tests passing');
    expect(e).toMatchObject({ level: 'info', source: 'agent' });
  });
  it('a failed or stopped stage reads differently and a failure is a warning', () => {
    expect(events.stageFinished({ stage: 'plan', status: 'failed', durationMs: 1000, turns: 1, costUsd: 0 })).toMatchObject({ level: 'warn', message: expect.stringContaining('Planner failed') });
    expect(events.stageFinished({ stage: 'plan', status: 'killed', durationMs: 1000, turns: 1, costUsd: 0 }).message).toContain('was stopped');
  });
  it('a started stage says where and which attempt', () => {
    expect(events.stageStarted({ stage: 'fix', ticketKey: 'SDA-12', subtask: 1, subtasks: 3, attempt: 2 }).message).toBe('Fixer started subtask 1/3 on SDA-12 (attempt 2)');
  });
  it('an error uses the policy message, source and code, with the retry time', () => {
    const when = new Date(2026, 10, 14, 14, 32);
    const e = events.error({ code: 'CLAUDE_API_ERROR', vars: { detail: '529' }, retry: { n: 1, of: 3 }, retryAt: when });
    expect(e).toMatchObject({ level: 'error', source: 'claude', errorCode: 'CLAUDE_API_ERROR', message: 'Claude API error (529). Retry 1/3 at 14:32.' });
    expect(events.error({ code: 'JIRA_ERROR', vars: { detail: '503' } }).source).toBe('jira');
    expect(events.warning({ code: 'CONFLUENCE_ERROR', detail: 'x' })).toMatchObject({ level: 'warn', source: 'confluence' });
  });
  it('decisions, reruns and skipped Jira moves', () => {
    expect(events.decision({ chosen: 'fixer', over: ['re-plan'], reason: '2 high findings, both in cancel.service.ts' }).message).toBe('Orchestrator chose fixer over re-plan: 2 high findings, both in cancel.service.ts');
    expect(events.rerun({ stage: 'PLANNING', actor: 'user', note: 'use the existing booking repository' }).message).toBe('Rerun of PLANNING requested by user: "use the existing booking repository"');
    expect(events.jiraSkipped({ target: 'In Review', from: 'Blocked' }).message).toBe('Jira transition to "In Review" skipped: not available from "Blocked"');
  });
  it('a transition names the ticket and the move', () => {
    expect(events.transition({ ticketKey: 'SDA-1', from: 'KB', to: 'PLANNING', reason: 'KB ready', actor: 'system' }).message).toBe('SDA-1: KB -> PLANNING (KB ready)');
  });
});
