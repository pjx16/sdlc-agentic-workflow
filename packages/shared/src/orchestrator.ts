import type { Move, MoveKind } from './moves';
import type { TicketStatus } from './enums';

/**
 * Where the orchestrator agent may be asked to choose (BUILD_PLAN v1 6.11). Everywhere else code takes the only legal move or the
 * default one. `thinking` switches on extended thinking, with a small budget, for that point only.
 */
export const DECISION_POINTS = {
  /** After a review round with nothing blocking: update the knowledge base, or skip it for a tiny change. */
  kb_update: { state: 'REVIEW', thinking: true, question: 'Is the knowledge-base update worth running for this change, or can it be skipped?' },
} as const satisfies Record<string, { state: TicketStatus; thinking: boolean; question: string }>;
export type DecisionPoint = keyof typeof DECISION_POINTS;

/** The point that applies in a state, if there is one. */
export function decisionPointOf(state: TicketStatus): DecisionPoint | null {
  return (Object.keys(DECISION_POINTS) as DecisionPoint[]).find((p) => DECISION_POINTS[p].state === state) ?? null;
}

/** The moves code or the orchestrator may take by itself: moving on. Approvals, holds, failures and reruns belong to people. */
export const automaticMoves = (moves: readonly Move[]): Move[] => moves.filter((m) => m.kind === 'advance');

export type MoveChoice = { kind: MoveKind | string; to: string };
export type DecisionVerdict = { ok: true; move: Move } | { ok: false; reason: string };

/** The orchestrator's answer must be one of the legal moves; anything else is replaced by the default move (and logged as a warning). */
export function validateDecision(choice: MoveChoice | null | undefined, legal: readonly Move[]): DecisionVerdict {
  if (!choice) return { ok: false, reason: 'no move was chosen' };
  const hit = legal.find((m) => m.kind === choice.kind && m.to === choice.to);
  return hit ? { ok: true, move: hit } : { ok: false, reason: `"${choice.kind} ${choice.to}" is not one of the legal moves (${legal.map((m) => `${m.kind} ${m.to}`).join(', ')})` };
}
