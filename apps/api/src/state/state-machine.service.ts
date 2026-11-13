import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ErrorCodes, checkTransition, events, type Actor, type HoldReason, type TicketStatus } from '@sdlc/shared';
import { ApiException } from '../common/api-exception';
import { writeEvent } from '../common/event-log';
import type { StateTransition, Ticket } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Thrown for any pair BUILD_PLAN 6.6 does not allow. The API answers it with 409. */
export class InvalidTransitionError extends ApiException {
  constructor(
    readonly from: TicketStatus,
    readonly to: TicketStatus,
    reason: string,
  ) {
    super(HttpStatus.CONFLICT, ErrorCodes.invalidTransition, reason);
  }
}

export interface TransitionResult {
  ticket: Ticket;
  transition: StateTransition;
}

/** Called after a transition is committed (for example to apply the Jira status mapping). Must never block the pipeline. */
export interface TransitionListener {
  onTransition(result: TransitionResult): Promise<void>;
}

export const TRANSITION_LISTENERS = Symbol('TRANSITION_LISTENERS');

export interface TransitionOptions {
  /** Required when moving to ON_HOLD. */
  holdReason?: HoldReason;
}

/**
 * The only way a ticket's status changes (F15, BUILD_PLAN 8 Worker interfaces).
 * Validates against the 6.6 table, then changes the status and writes the StateTransition row in one transaction.
 */
@Injectable()
export class StateMachine {
  private readonly logger = new Logger(StateMachine.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(TRANSITION_LISTENERS) private readonly listeners: TransitionListener[] = [],
  ) {}

  async transition(
    ticketId: string,
    to: TicketStatus,
    actor: Actor,
    reason?: string,
    stageRunId?: string,
    options: TransitionOptions = {},
  ): Promise<TransitionResult> {
    const result = await this.prisma.$transaction(async (tx) => {
      const ticket = await tx.ticket.findUnique({ where: { id: ticketId } });
      if (!ticket) throw new ApiException(HttpStatus.NOT_FOUND, ErrorCodes.notFound, 'Ticket not found');
      const from = ticket.status as TicketStatus;

      const verdict = checkTransition(from, to, { holdFromStatus: ticket.holdFromStatus as TicketStatus | null });
      if (!verdict.ok) throw new InvalidTransitionError(from, to, verdict.reason);
      if (to === 'ON_HOLD' && !options.holdReason) {
        throw new ApiException(HttpStatus.BAD_REQUEST, ErrorCodes.validation, 'A hold needs a reason', { holdReason: 'required' });
      }

      // Held and failed tickets remember where to return to; resuming clears it.
      const bookkeeping =
        to === 'ON_HOLD'
          ? { holdReason: options.holdReason, holdFromStatus: from }
          : to === 'FAILED'
            ? // A ticket that fails while on hold keeps the state it was held from, so a retry does not land back on hold.
              { holdReason: null, holdFromStatus: from === 'ON_HOLD' ? ticket.holdFromStatus : from }
            : from === 'ON_HOLD' || from === 'FAILED'
              ? { holdReason: null, holdFromStatus: null }
              : {};

      // Optimistic lock: the update only applies if the status is still the one we validated.
      const { count } = await tx.ticket.updateMany({ where: { id: ticketId, status: from }, data: { status: to, ...bookkeeping } });
      if (count === 0) throw new ApiException(HttpStatus.CONFLICT, ErrorCodes.conflict, 'The ticket changed while it was being updated');

      const transition = await tx.stateTransition.create({ data: { ticketId, fromStatus: from, toStatus: to, actor, reason: reason ?? null, stageRunId: stageRunId ?? null } });
      await writeEvent(tx, events.transition({ ticketKey: ticket.key, from, to, reason, actor }), { ticketId, stageRunId });
      return { ticket: await tx.ticket.findUniqueOrThrow({ where: { id: ticketId } }), transition };
    });

    for (const listener of this.listeners) {
      try {
        await listener.onTransition(result);
      } catch (err) {
        this.logger.warn(`Transition listener failed for ${result.ticket.key}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return result;
  }

  hold(ticketId: string, holdReason: HoldReason, actor: Actor, note?: string, stageRunId?: string): Promise<TransitionResult> {
    return this.transition(ticketId, 'ON_HOLD', actor, note ?? holdReason, stageRunId, { holdReason });
  }

  /** Resume from a hold, or retry after a failure: back to the state the ticket was in (rows 17 and 18). */
  async resume(ticketId: string, actor: Actor, note?: string): Promise<TransitionResult> {
    const ticket = await this.prisma.ticket.findUnique({ where: { id: ticketId }, select: { status: true, holdFromStatus: true } });
    if (!ticket) throw new ApiException(HttpStatus.NOT_FOUND, ErrorCodes.notFound, 'Ticket not found');
    if (ticket.status !== 'ON_HOLD' && ticket.status !== 'FAILED') {
      throw new InvalidTransitionError(ticket.status, ticket.status, `A ${ticket.status} ticket is not on hold or failed`);
    }
    return this.transition(ticketId, ticket.holdFromStatus as TicketStatus, actor, note ?? 'resumed');
  }

  fail(ticketId: string, reason: string, stageRunId?: string): Promise<TransitionResult> {
    return this.transition(ticketId, 'FAILED', 'system', reason, stageRunId);
  }
}
