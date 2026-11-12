import { describe, expect, it } from 'vitest';
import { holdGuidance } from './hold-guidance';
import type { HoldInfo } from './types';

const info = (over: Partial<HoldInfo> = {}): HoldInfo => ({
  status: 'ON_HOLD', holdReason: 'needs_help', holdFromStatus: 'IN_PROGRESS', note: 'The fix stage failed twice: the test cannot pass', at: null,
  failedRun: { id: 'r9', stage: 'fix', attempt: 2, round: 1, error: 'blocked' }, subtask: { seq: 1, title: 'Add a purpose section', status: 'FIXING', fixRounds: 1 }, canRedoTests: true, ...over,
});
const ids = (g: ReturnType<typeof holdGuidance>) => g.actions.map((a) => a.id);

describe('holdGuidance', () => {
  it('needs_help in the subtask loop: says what happened, quotes the reason, and recommends Redo tests, Retry, Resume', () => {
    const g = holdGuidance(info());
    expect(g.title).toBe('Needs your help');
    expect(g.happened).toBe('The fix stage on subtask 1 (“Add a purpose section”) could not finish after 2 attempts, so the pipeline stopped and is waiting for you.');
    expect(g.detail).toBe('The fix stage failed twice: the test cannot pass');
    expect(ids(g)).toEqual(['redo-tests', 'retry', 'resume']);
    expect(g.steps.some((s) => s.includes('Redo tests') && s.includes('too strict'))).toBe(true);
    expect(g.steps.some((s) => s.includes('press Retry'))).toBe(true);
    expect(g.links).toEqual([{ href: '/runs/r9', text: 'Open the log of the failed fix run' }]);
  });

  it('does not offer Redo tests when there are no tests to redo', () => {
    const g = holdGuidance(info({ canRedoTests: false, failedRun: { id: 'r1', stage: 'kbBuild', attempt: 1, round: 0, error: 'x' }, subtask: null }));
    expect(ids(g)).toEqual(['retry', 'resume']);
    expect(g.happened).toBe('The knowledge-base build stage could not finish, so the pipeline stopped and is waiting for you.');
    expect(g.steps.join(' ')).not.toContain('Redo tests');
  });

  it('falls back to the failed run’s error when there is no recorded reason, and copes with no run at all', () => {
    expect(holdGuidance(info({ note: null })).detail).toBe('blocked');
    const g = holdGuidance(info({ note: null, failedRun: null, subtask: null, canRedoTests: false }));
    expect(g.detail).toBeNull();
    expect(g.links).toEqual([]);
    expect(g.happened).toContain('got stuck');
  });

  it('awaiting_answer points to Support and has no buttons', () => {
    const g = holdGuidance(info({ holdReason: 'awaiting_answer', canRedoTests: false }));
    expect(g.title).toBe('Waiting for your answer');
    expect(g.actions).toEqual([]);
    expect(g.links).toEqual([{ href: '/support', text: 'Go to Support' }]);
  });

  it('a manual hold only needs Resume', () => {
    const g = holdGuidance(info({ holdReason: 'manual', note: null }));
    expect(g.title).toBe('Paused by you');
    expect(ids(g)).toEqual(['resume']);
  });

  it('a closed pull request explains the decision to take, and offers Resume and Retry', () => {
    const g = holdGuidance(info({ holdReason: 'pr_closed' }));
    expect(g.title).toBe('Pull request closed');
    expect(ids(g)).toEqual(['resume', 'retry']);
    expect(g.steps[0]).toContain('reopen the pull request');
  });

  it('a failed ticket offers Retry (and Redo tests when it applies)', () => {
    expect(ids(holdGuidance(info({ status: 'FAILED', holdReason: null, canRedoTests: false })))).toEqual(['retry']);
    expect(ids(holdGuidance(info({ status: 'FAILED', holdReason: null })))).toEqual(['retry', 'redo-tests']);
    expect(holdGuidance(info({ status: 'FAILED', holdReason: null })).title).toBe('Failed');
  });

  it('every action has a label and a description', () => {
    for (const reason of ['needs_help', 'manual', 'pr_closed', 'awaiting_answer']) {
      for (const a of holdGuidance(info({ holdReason: reason })).actions) {
        expect(a.label).toBeTruthy();
        expect(a.description.length).toBeGreaterThan(10);
      }
    }
  });
});
