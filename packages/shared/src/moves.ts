import type { TicketStatus } from './enums';
import { HOLDABLE, TRANSITIONS, checkTransition, type TransitionVerdict } from './state-machine';

/**
 * Moves and reruns (BUILD_PLAN v1 6.8). The state table of v0 says which moves are legal; here every move also has a kind, and a
 * ticket can be sent back to a stage that already finished. One pure function, `legalMoves`, lists every legal move, and the
 * worker, the API, the dashboard and the orchestrator all use it.
 */

export const MOVE_KINDS = ['advance', 'rerun', 'hold', 'resume', 'fail', 'retry', 'approve', 'reject'] as const;
export type MoveKind = (typeof MOVE_KINDS)[number];

/** The forward order of the states a ticket passes through. */
export const FORWARD_ORDER: readonly TicketStatus[] = [
  'NEW', 'KB', 'PLANNING', 'AWAITING_PLAN_APPROVAL', 'BREAKDOWN', 'AWAITING_BREAKDOWN_APPROVAL',
  'IN_PROGRESS', 'REVIEW', 'KB_UPDATE', 'AWAITING_CI', 'IN_HUMAN_REVIEW', 'DONE',
];

/** The states where a stage runs, so the ones a person can send a ticket back to. */
export const RERUNNABLE_STATES: readonly TicketStatus[] = ['KB', 'PLANNING', 'BREAKDOWN', 'IN_PROGRESS', 'REVIEW', 'KB_UPDATE'];

/** What the person sees for each rerunnable state. */
export const STATE_LABEL: Partial<Record<TicketStatus, string>> = {
  KB: 'Knowledge base', PLANNING: 'Planning', BREAKDOWN: 'Breakdown', IN_PROGRESS: 'Implementation', REVIEW: 'Review', KB_UPDATE: 'KB update',
};

/** Position in the forward order, or -1 for ON_HOLD and FAILED (which sit outside it). */
export const orderOf = (s: TicketStatus): number => FORWARD_ORDER.indexOf(s);

export interface MoveRecord {
  fromStatus: TicketStatus;
  toStatus: TicketStatus;
  kind?: MoveKind | string | null;
}

/**
 * The states that have finished for a ticket, from its moves in time order. A forward advance or approval completes the state it
 * leaves; a rerun or a rejection un-completes the target and everything after it (BUILD_PLAN v1 D4: everything after the rerun
 * stage is stale, always). Pure.
 */
export function completedStates(moves: readonly MoveRecord[]): Set<TicketStatus> {
  const done = new Set<TicketStatus>();
  for (const m of moves) {
    const kind = m.kind ?? 'advance';
    const from = orderOf(m.fromStatus);
    const to = orderOf(m.toStatus);
    if ((kind === 'advance' || kind === 'approve') && from >= 0 && to > from) {
      done.add(m.fromStatus);
    } else if ((kind === 'rerun' || kind === 'reject') && to >= 0) {
      for (const s of FORWARD_ORDER) if (orderOf(s) >= to) done.delete(s);
    }
  }
  return done;
}

export interface Move {
  kind: MoveKind;
  to: TicketStatus;
  /** Plain English for a button or a log line. */
  label: string;
}

export interface LegalMovesInput {
  status: TicketStatus;
  holdFromStatus?: TicketStatus | null;
  /** The ticket's moves so far, oldest first. */
  moves: readonly MoveRecord[];
  /** Which approval gates are on. A gate that is off is not a legal stop. */
  gates?: { plan: boolean; breakdown: boolean };
}

/** Where the ticket is in the forward order: its own state, or the one a held or failed ticket will return to. */
export const positionOf = (t: Pick<LegalMovesInput, 'status' | 'holdFromStatus'>): TicketStatus | null =>
  t.status === 'ON_HOLD' || t.status === 'FAILED' ? (t.holdFromStatus ?? null) : t.status;

/**
 * Every legal move for a ticket, with its kind. A pure helper: it looks at the state table, the gates and the history, and does no
 * I/O. When it returns one move, code takes it; when it returns several, the orchestrator chooses (BUILD_PLAN v1 6.11).
 */
export function legalMoves(t: LegalMovesInput): Move[] {
  const gates = t.gates ?? { plan: true, breakdown: true };
  const out: Move[] = [];
  const pos = positionOf(t);

  if (t.status === 'DONE') return out;
  if (t.status === 'ON_HOLD') {
    if (t.holdFromStatus) out.push({ kind: 'resume', to: t.holdFromStatus, label: `Resume at ${t.holdFromStatus}` });
    out.push({ kind: 'fail', to: 'FAILED', label: 'Mark the ticket failed' });
  } else if (t.status === 'FAILED') {
    if (t.holdFromStatus) out.push({ kind: 'retry', to: t.holdFromStatus, label: `Retry at ${t.holdFromStatus}` });
  } else {
    for (const to of TRANSITIONS[t.status]) {
      if (t.status === 'PLANNING' && ((to === 'AWAITING_PLAN_APPROVAL') !== gates.plan)) continue;
      if (t.status === 'BREAKDOWN' && ((to === 'AWAITING_BREAKDOWN_APPROVAL') !== gates.breakdown)) continue;
      const gate = t.status === 'AWAITING_PLAN_APPROVAL' || t.status === 'AWAITING_BREAKDOWN_APPROVAL';
      // At a gate the way on is an approval, and the way back is a rejection.
      const kind: MoveKind = gate ? (orderOf(to) > orderOf(t.status) ? 'approve' : 'reject') : 'advance';
      out.push({ kind, to, label: `${kind === 'advance' ? 'Move on to' : kind === 'approve' ? 'Approve and move on to' : 'Reject and go back to'} ${to}` });
    }
    if (HOLDABLE.has(t.status)) out.push({ kind: 'hold', to: 'ON_HOLD', label: 'Put the ticket on hold' });
    out.push({ kind: 'fail', to: 'FAILED', label: 'Mark the ticket failed' });
  }

  // A rerun goes to a stage that finished and lies before where the ticket is now.
  if (pos) {
    const completed = completedStates(t.moves);
    for (const to of RERUNNABLE_STATES) {
      if (completed.has(to) && orderOf(to) < orderOf(pos)) out.push({ kind: 'rerun', to, label: `Rerun ${STATE_LABEL[to] ?? to}` });
    }
  }
  return out;
}

/** Is this particular move legal right now? */
export const isLegalMove = (t: LegalMovesInput, kind: MoveKind, to: TicketStatus): boolean => legalMoves(t).some((m) => m.kind === kind && m.to === to);

/** Back-edges with a limit per ticket (BUILD_PLAN v1 6.8). Going over one raises a hold with the reason `loop_limit`. */
export const LOOP_EDGES = ['testFix', 'reviewFix', 'ciFix', 'userRerun', 'orchestratorReplan'] as const;
export type LoopEdge = (typeof LOOP_EDGES)[number];
export const DEFAULT_LOOP_LIMITS: Record<LoopEdge, number> = { testFix: 2, reviewFix: 2, ciFix: 1, userRerun: 5, orchestratorReplan: 1 };

export const LOOP_EDGE_LABEL: Record<LoopEdge, string> = {
  testFix: 'fixing failing tests of a subtask', reviewFix: 'fixing review findings', ciFix: 'fixing a failed CI run', userRerun: 'rerunning the same stage', orchestratorReplan: 're-planning on the orchestrator\'s advice',
};

/** How many times the same stage was rerun by a person, from the moves. */
export function rerunCount(moves: readonly MoveRecord[], to: TicketStatus): number {
  return moves.filter((m) => m.kind === 'rerun' && m.toStatus === to).length;
}

/** The plain-English reason shown when a limit is reached. */
export const loopLimitMessage = (edge: LoopEdge, limit: number, what?: string): string =>
  `The limit of ${limit} ${limit === 1 ? 'round' : 'rounds'} for ${LOOP_EDGE_LABEL[edge]}${what ? ` (${what})` : ''} was reached.`;

/**
 * Whether `from -> to` of this kind is allowed. A rerun goes by the history (only to a stage that finished, and only backwards);
 * every other kind goes by the v0 state table, so nothing that was legal before becomes illegal.
 */
export function checkMove(t: LegalMovesInput, kind: MoveKind, to: TicketStatus): TransitionVerdict {
  if (kind !== 'rerun') return checkTransition(t.status, to, { holdFromStatus: t.holdFromStatus });
  if (t.status === 'DONE') return { ok: false, reason: 'A DONE ticket cannot be rerun' };
  if (!RERUNNABLE_STATES.includes(to)) return { ok: false, reason: `${to} is not a stage that can be rerun` };
  const pos = positionOf(t);
  if (!pos) return { ok: false, reason: `A ${t.status} ticket has no state to go back from` };
  if (orderOf(to) >= orderOf(pos)) return { ok: false, reason: `${to} is not before ${pos}, so it cannot be rerun from there` };
  if (!completedStates(t.moves).has(to)) return { ok: false, reason: `${to} has not finished for this ticket yet, so there is nothing to rerun` };
  return { ok: true };
}
