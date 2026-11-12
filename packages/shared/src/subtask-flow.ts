export const SUBTASK_STATUSES = ['PENDING', 'TESTS', 'VERIFY_RED', 'IMPLEMENT', 'VERIFY_GREEN', 'FIXING', 'DONE'] as const;
export type SubtaskStatus = (typeof SUBTASK_STATUSES)[number];

/**
 * Subtask states (BUILD_PLAN 6.6): PENDING -> TESTS -> VERIFY_RED -> IMPLEMENT -> VERIFY_GREEN -> DONE, with
 * VERIFY_GREEN -> FIXING -> VERIFY_GREEN as the fix loop. With `tests` off, PENDING -> IMPLEMENT.
 * VERIFY_RED -> TESTS is the one retry of the `tests` stage when the red check was invalid (F9).
 */
const FLOW: Readonly<Record<SubtaskStatus, readonly SubtaskStatus[]>> = {
  PENDING: ['TESTS', 'IMPLEMENT'],
  TESTS: ['VERIFY_RED'],
  VERIFY_RED: ['IMPLEMENT', 'TESTS'],
  IMPLEMENT: ['VERIFY_GREEN'],
  VERIFY_GREEN: ['DONE', 'FIXING'],
  FIXING: ['VERIFY_GREEN'],
  DONE: [],
};

export function isSubtaskTransitionAllowed(from: SubtaskStatus, to: SubtaskStatus, opts: { testsEnabled: boolean }): boolean {
  if (from === 'PENDING' && to === 'IMPLEMENT') return !opts.testsEnabled; // only when the tests stage is off
  if (from === 'PENDING' && to === 'TESTS') return opts.testsEnabled;
  return FLOW[from].includes(to);
}

/** The first subtask that is not DONE, in `seq` order (subtasks are processed in order), or null when all are done. */
export function nextSubtask<T extends { seq: number; status: string }>(subtasks: readonly T[]): T | null {
  return [...subtasks].sort((a, b) => a.seq - b.seq).find((s) => s.status !== 'DONE') ?? null;
}

export type SubtaskStep = 'tests' | 'verify_red' | 'implement' | 'verify_green' | 'fix';

/** Which step runs next for a subtask in this state. PENDING starts with `tests`, or `implement` when tests are off. */
export function stepFor(status: SubtaskStatus, opts: { testsEnabled: boolean }): SubtaskStep | null {
  switch (status) {
    case 'PENDING':
      return opts.testsEnabled ? 'tests' : 'implement';
    case 'TESTS':
      return 'tests'; // a tests stage that was interrupted runs again
    case 'VERIFY_RED':
      return 'verify_red';
    case 'IMPLEMENT':
      return 'implement';
    case 'VERIFY_GREEN':
      return 'verify_green';
    case 'FIXING':
      return 'fix';
    case 'DONE':
      return null;
  }
}
