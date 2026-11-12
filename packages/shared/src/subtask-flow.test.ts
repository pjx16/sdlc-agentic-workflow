import { describe, expect, it } from 'vitest';
import { SUBTASK_STATUSES, isSubtaskTransitionAllowed, nextSubtask, stepFor, type SubtaskStatus } from './subtask-flow';

const allowed = (testsEnabled: boolean) => {
  const out: string[] = [];
  for (const a of SUBTASK_STATUSES) for (const b of SUBTASK_STATUSES) if (isSubtaskTransitionAllowed(a, b, { testsEnabled })) out.push(`${a}>${b}`);
  return out.sort();
};

describe('subtask states (BUILD_PLAN 6.6)', () => {
  it('with tests on: PENDING > TESTS > VERIFY_RED > IMPLEMENT > VERIFY_GREEN > DONE, the fix loop, and the one tests retry', () => {
    expect(allowed(true)).toEqual(['FIXING>VERIFY_GREEN', 'IMPLEMENT>VERIFY_GREEN', 'PENDING>TESTS', 'TESTS>VERIFY_RED', 'VERIFY_GREEN>DONE', 'VERIFY_GREEN>FIXING', 'VERIFY_RED>IMPLEMENT', 'VERIFY_RED>TESTS'].sort());
  });
  it('with tests off: PENDING goes straight to IMPLEMENT and never to TESTS', () => {
    const a = allowed(false);
    expect(a).toContain('PENDING>IMPLEMENT');
    expect(a).not.toContain('PENDING>TESTS');
    expect(allowed(true)).not.toContain('PENDING>IMPLEMENT');
  });
  it('DONE is final and nothing skips ahead', () => {
    for (const to of SUBTASK_STATUSES) expect(isSubtaskTransitionAllowed('DONE', to, { testsEnabled: true })).toBe(false);
    expect(isSubtaskTransitionAllowed('IMPLEMENT', 'DONE', { testsEnabled: true })).toBe(false);
    expect(isSubtaskTransitionAllowed('PENDING', 'VERIFY_GREEN', { testsEnabled: false })).toBe(false);
  });
});

describe('processing order', () => {
  const s = (seq: number, status: string) => ({ seq, status });
  it('picks the first subtask that is not DONE, in seq order', () => {
    expect(nextSubtask([s(2, 'PENDING'), s(1, 'DONE'), s(3, 'PENDING')])?.seq).toBe(2);
    expect(nextSubtask([s(1, 'VERIFY_GREEN'), s(2, 'PENDING')])?.seq).toBe(1);
  });
  it('returns null when every subtask is DONE or there are none', () => {
    expect(nextSubtask([s(1, 'DONE'), s(2, 'DONE')])).toBeNull();
    expect(nextSubtask([])).toBeNull();
  });
});

describe('stepFor', () => {
  const steps = (testsEnabled: boolean) => Object.fromEntries(SUBTASK_STATUSES.map((st: SubtaskStatus) => [st, stepFor(st, { testsEnabled })]));
  it('maps each state to the step that runs next', () => {
    expect(steps(true)).toEqual({ PENDING: 'tests', TESTS: 'tests', VERIFY_RED: 'verify_red', IMPLEMENT: 'implement', VERIFY_GREEN: 'verify_green', FIXING: 'fix', DONE: null });
  });
  it('with tests off a PENDING subtask starts with implement', () => {
    expect(steps(false).PENDING).toBe('implement');
  });
});
