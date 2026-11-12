import type { HoldReason, TicketStatus } from '@sdlc/shared';
import type { Ticket } from '../../generated/prisma/client';

/** What one pipeline step decided (BUILD_PLAN 6.6 step 4). The loop applies it through the state machine. */
export type StepOutcome =
  | { kind: 'transition'; to: TicketStatus; reason?: string; stageRunId?: string }
  | { kind: 'hold'; reason: HoldReason; note?: string; stageRunId?: string }
  /** A step ran and its work is recorded, but the ticket's state does not change (for example one subtask step of IN_PROGRESS). */
  | { kind: 'continue' }
  /** Nothing to change now (for example the usage gate paused the pipeline); the loop waits before the next pick. */
  | { kind: 'stay' };

/**
 * One handler per actionable ticket state: runs exactly one step (one AI stage with its scripted checks, or one
 * scripted step) for a ticket in `status`. The handlers are added by milestones 5 to 8.
 */
export interface StepHandler {
  readonly status: TicketStatus;
  run(ticket: Ticket): Promise<StepOutcome>;
}

export const STEP_HANDLERS = Symbol('STEP_HANDLERS');
