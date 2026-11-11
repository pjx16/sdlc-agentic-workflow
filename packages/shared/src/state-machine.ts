import type { TicketStatus } from './enums';

export const HOLD_REASONS = ['awaiting_answer', 'needs_help', 'manual', 'pr_closed'] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

export const ACTORS = ['system', 'user', 'jira'] as const;
export type Actor = (typeof ACTORS)[number];

/**
 * The fixed transitions of BUILD_PLAN 6.6 (rows 1 to 15). Anything not listed here, and not one of the
 * hold/resume/fail rules below, is rejected.
 */
export const TRANSITIONS: Readonly<Record<TicketStatus, readonly TicketStatus[]>> = {
  NEW: ['KB'],
  KB: ['PLANNING'],
  PLANNING: ['AWAITING_PLAN_APPROVAL', 'BREAKDOWN'],
  AWAITING_PLAN_APPROVAL: ['BREAKDOWN', 'PLANNING'],
  BREAKDOWN: ['AWAITING_BREAKDOWN_APPROVAL', 'IN_PROGRESS'],
  AWAITING_BREAKDOWN_APPROVAL: ['IN_PROGRESS', 'BREAKDOWN'],
  IN_PROGRESS: ['REVIEW', 'KB_UPDATE'],
  REVIEW: ['KB_UPDATE', 'AWAITING_CI'],
  KB_UPDATE: ['AWAITING_CI'],
  AWAITING_CI: ['IN_HUMAN_REVIEW'],
  IN_HUMAN_REVIEW: ['DONE'],
  DONE: [],
  ON_HOLD: [], // resume only: to holdFromStatus (row 17)
  FAILED: [], // retry only: to holdFromStatus (row 18)
};

/** States a ticket can be put on hold from (row 16): everything except DONE, FAILED and ON_HOLD itself. */
export const HOLDABLE: ReadonlySet<TicketStatus> = new Set(
  (Object.keys(TRANSITIONS) as TicketStatus[]).filter((s) => s !== 'DONE' && s !== 'FAILED' && s !== 'ON_HOLD'),
);

export interface TransitionContext {
  /** The state a held or failed ticket returns to. */
  holdFromStatus?: TicketStatus | null;
}

export type TransitionVerdict = { ok: true } | { ok: false; reason: string };

/** Is `from -> to` allowed by BUILD_PLAN 6.6? Pure; used by the worker, the API and the dashboard. */
export function checkTransition(from: TicketStatus, to: TicketStatus, ctx: TransitionContext = {}): TransitionVerdict {
  if (from === to) return { ok: false, reason: `A ticket cannot move from ${from} to itself` };
  if (to === 'ON_HOLD') {
    return HOLDABLE.has(from) ? { ok: true } : { ok: false, reason: `A ticket in ${from} cannot be put on hold` };
  }
  if (to === 'FAILED') {
    return from === 'DONE' ? { ok: false, reason: 'A DONE ticket cannot fail' } : { ok: true };
  }
  if (from === 'ON_HOLD' || from === 'FAILED') {
    if (!ctx.holdFromStatus) return { ok: false, reason: `${from} ticket has no state to return to` };
    return to === ctx.holdFromStatus ? { ok: true } : { ok: false, reason: `A ${from} ticket can only return to ${ctx.holdFromStatus}, not ${to}` };
  }
  return TRANSITIONS[from].includes(to) ? { ok: true } : { ok: false, reason: `Transition ${from} -> ${to} is not allowed` };
}

/** States the worker can pick up (BUILD_PLAN 6.6 step 3). AWAITING_CI only with a pending CI fix. */
export const ACTIONABLE_STATUSES: readonly TicketStatus[] = ['NEW', 'KB', 'PLANNING', 'BREAKDOWN', 'IN_PROGRESS', 'REVIEW', 'KB_UPDATE'];
