import type { Move, MoveKind } from './moves';
import type { TicketStatus } from './enums';

export interface DecisionSpec {
  /** The ticket state this point belongs to, when the choice is made as a ticket leaves that state (the move it takes is the answer). */
  state?: TicketStatus;
  thinking: boolean;
  question: string;
}

/**
 * Where the orchestrator agent may be asked to choose (BUILD_PLAN v1 6.11). Everywhere else code takes the only legal move or the
 * default one. `thinking` switches on extended thinking, with a small budget, for that point only. Each point has a default option, which
 * code takes when the orchestrator is off, fails, or answers outside the options.
 */
export const DECISION_POINTS = {
  /** After a review round with nothing blocking: update the knowledge base, or skip it for a tiny change. */
  kb_update: { state: 'REVIEW', thinking: true, question: 'Is the knowledge-base update worth running for this change, or can it be skipped?' },
  /** Blocking findings are open: send them to the fixer, or raise a support ticket (for example the findings contradict the plan). Default: fix. */
  review_findings: { thinking: true, question: 'Blocking review findings are open. Should the fixer try to resolve them, or do they need a person, for example because they contradict the plan?' },
  /** The review rounds are used up with blocking findings left: finish with them listed, one more fix round, or ask a person (a re-plan may be needed). Default: finish. */
  review_limit: { thinking: true, question: 'The review round limit is reached and blocking findings are still open. Finish and list them, run one more fix round, or raise a support ticket (a re-plan may be needed)?' },
  /** The code rules did not trigger the security review: add it anyway, or not. Default: not. */
  security_add: { thinking: false, question: 'The code rules did not trigger the security review. Does this change need it anyway?' },
  /** A chore with the plan gate off: skip the planning stage, or plan. Default: plan. */
  chore_plan: { thinking: false, question: 'This is a small chore and the plan gate is off. Can the planning stage be skipped, with the ticket body as the plan?' },
  /** CI failed with a flaky test for the second time: run the checks once more, or raise a support ticket. Default: support ticket. */
  ci_flaky: { thinking: true, question: 'CI was classified as a flaky test for the second time in a row. Run the checks once more, or raise a support ticket?' },
} as const satisfies Record<string, DecisionSpec>;
export type DecisionPoint = keyof typeof DECISION_POINTS;

/** The point that belongs to a state, if there is one. */
export function decisionPointOf(state: TicketStatus): DecisionPoint | null {
  return (Object.keys(DECISION_POINTS) as DecisionPoint[]).find((p) => (DECISION_POINTS[p] as DecisionSpec).state === state) ?? null;
}

/** One thing the orchestrator may choose: a legal move, or one of the options code offers at a point that is not a state move. */
export interface DecisionOption {
  kind: string;
  to: string;
  label: string;
}

/** The moves code or the orchestrator may take by itself: moving on. Approvals, holds, failures and reruns belong to people. */
export const automaticMoves = (moves: readonly Move[]): Move[] => moves.filter((m) => m.kind === 'advance');

export type MoveChoice = { kind: MoveKind | string; to: string };
export type DecisionVerdict<T extends { kind: string; to: string } = Move> = { ok: true; move: T } | { ok: false; reason: string };

/** The orchestrator's answer must be one of the legal moves; anything else is replaced by the default move (and logged as a warning). */
export function validateDecision<T extends { kind: string; to: string }>(choice: MoveChoice | null | undefined, legal: readonly T[]): DecisionVerdict<T> {
  if (!choice) return { ok: false, reason: 'no move was chosen' };
  const hit = legal.find((m) => m.kind === choice.kind && m.to === choice.to);
  return hit ? { ok: true, move: hit } : { ok: false, reason: `"${choice.kind} ${choice.to}" is not one of the legal moves (${legal.map((m) => `${m.kind} ${m.to}`).join(', ')})` };
}
