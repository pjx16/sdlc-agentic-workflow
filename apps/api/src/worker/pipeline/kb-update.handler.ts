import { Injectable } from '@nestjs/common';
import type { Ticket } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { KbUpdateService } from './kb-update.service';
import type { StepHandler, StepOutcome } from './step-handler';

/** KB_UPDATE -> AWAITING_CI (row 13): update the feature doc from the ticket's diff, then wait for CI. */
@Injectable()
export class KbUpdateHandler implements StepHandler {
  readonly status = 'KB_UPDATE' as const;
  constructor(private readonly service: KbUpdateService) {}

  async run(ticket: Ticket): Promise<StepOutcome> {
    const result = await this.service.run(ticket);
    if (result.kind === 'outcome') return result.outcome;
    return { kind: 'transition', to: 'AWAITING_CI', reason: `KB update: ${result.note}` };
  }
}

/**
 * IN_HUMAN_REVIEW, only for a ticket with a pending "re-run KB update" request: runs kbUpdate once on the current branch and
 * clears the request. The ticket stays in IN_HUMAN_REVIEW.
 */
@Injectable()
export class HumanReviewHandler implements StepHandler {
  readonly status = 'IN_HUMAN_REVIEW' as const;
  constructor(
    private readonly prisma: PrismaService,
    private readonly service: KbUpdateService,
  ) {}

  async run(ticket: Ticket): Promise<StepOutcome> {
    if (!ticket.kbUpdatePending) return { kind: 'stay' };
    const result = await this.service.run(ticket);
    if (result.kind === 'outcome') {
      await this.prisma.ticket.update({ where: { id: ticket.id }, data: { kbUpdatePending: false } });
      return result.outcome;
    }
    await this.prisma.ticket.update({ where: { id: ticket.id }, data: { kbUpdatePending: false } });
    await this.prisma.event.create({ data: { ticketId: ticket.id, type: 'git', message: `KB update re-run: ${result.note}` } });
    return { kind: 'continue' };
  }
}
