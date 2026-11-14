import { HttpStatus, Injectable } from '@nestjs/common';
import { ErrorCodes, SUPPORT_ACTIONS, countsForBadge, inboxGroup, type InboxGroup, type SupportAction, type SupportKind, type SupportPriority, type SupportStatus } from '@sdlc/shared';
import { z } from 'zod';
import { ApiException } from '../common/api-exception';
import { logEvent } from '../common/event-log';
import { parseBody } from '../common/parse-body';
import type { SupportTicket } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StateMachine } from '../state/state-machine.service';
import { TicketsService } from '../tickets/tickets.service';
import { events } from '@sdlc/shared';
import { SupportRaiser } from './support-raiser';

const ActionBody = z.object({
  action: z.enum(['approve', 'reject', 'answer', 'rerun_with_answers', 'resume', 'retry', 'fail', 'fixed', 'hold', 'dismiss']),
  note: z.string().trim().max(2000, 'must be at most 2000 characters').optional(),
  answer: z.string().trim().min(1, 'is required').max(10_000, 'must be at most 10000 characters').optional(),
  /** Approve with an edited plan (an assistant draft, or an edit in the inbox). */
  planMarkdown: z.string().trim().min(1, 'must not be empty').max(100_000, 'must be at most 100000 characters').optional(),
});

export interface SupportTicketDto {
  id: string;
  kind: SupportKind;
  title: string;
  body: string;
  priority: SupportPriority;
  status: SupportStatus;
  group: InboxGroup;
  projectId: string | null;
  ticketId: string | null;
  ticketKey: string | null;
  ticketTitle: string | null;
  stage: string;
  defaultAnswer: string | null;
  response: string | null;
  resolvedBy: string | null;
  createdAt: string;
  resolvedAt: string | null;
  /** What a person can do with it now. Empty once it is closed. */
  actions: readonly SupportAction[];
}

export interface InboxCounts {
  /** What the sidebar badge shows: open blocking and approval items. */
  badge: number;
  groups: Record<InboxGroup, number>;
}

type Row = SupportTicket & { ticket: { key: string; title: string } | null };

const toDto = (q: Row): SupportTicketDto => {
  const status = q.status as SupportStatus;
  const kind = q.kind as SupportKind;
  const priority = q.priority as SupportPriority;
  return {
    id: q.id, kind, title: q.title, body: q.body, priority, status, group: inboxGroup({ kind, priority }),
    projectId: q.projectId, ticketId: q.ticketId, ticketKey: q.ticket?.key ?? null, ticketTitle: q.ticket?.title ?? null, stage: q.stage,
    defaultAnswer: q.defaultAnswer, response: q.response, resolvedBy: q.resolvedBy, createdAt: q.createdAt.toISOString(), resolvedAt: q.resolvedAt?.toISOString() ?? null,
    actions: status === 'open' || (status === 'answered' && kind === 'open_question') ? SUPPORT_ACTIONS[kind] : [],
  };
};

@Injectable()
export class SupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly states: StateMachine,
    private readonly tickets: TicketsService,
    private readonly raiser: SupportRaiser,
  ) {}

  /** GET /support-tickets: `tab=open` (default) or `tab=history`; oldest first among the open ones, newest first in history. */
  async list(query: { tab?: string; kind?: string; ticketId?: string } = {}): Promise<SupportTicketDto[]> {
    const history = query.tab === 'history';
    const rows = await this.prisma.supportTicket.findMany({
      where: {
        status: history ? { in: ['resolved', 'dismissed', 'answered'] } : { in: ['open', 'answered'] },
        ...(query.kind ? { kind: query.kind as SupportKind } : {}),
        ...(query.ticketId ? { ticketId: query.ticketId } : {}),
      },
      include: { ticket: { select: { key: true, title: true } } },
      orderBy: { createdAt: 'asc' },
    });
    // An answered open_question stays in the inbox until it is used; an answered question is history.
    const shown = rows.filter((r) => (history ? !(r.status === 'answered' && r.kind === 'open_question') : !(r.status === 'answered' && r.kind !== 'open_question')));
    const dtos = shown.map(toDto);
    return history ? dtos.sort((a, b) => (b.resolvedAt ?? b.createdAt).localeCompare(a.resolvedAt ?? a.createdAt)) : dtos;
  }

  async get(id: string): Promise<SupportTicketDto> {
    return toDto(await this.find(id));
  }

  /** GET /support-tickets/counts: the sidebar badge and the size of each inbox group. */
  async counts(): Promise<InboxCounts> {
    const open = await this.prisma.supportTicket.findMany({ where: { status: 'open' }, select: { kind: true, priority: true, status: true } });
    const groups: Record<InboxGroup, number> = { blocking: 0, approvals: 0, questions: 0, fyi: 0 };
    let badge = 0;
    for (const t of open) {
      const x = { kind: t.kind as SupportKind, priority: t.priority as SupportPriority, status: t.status as SupportStatus };
      groups[inboxGroup(x)]++;
      if (countsForBadge(x)) badge++;
    }
    return { badge, groups };
  }

  private async find(id: string): Promise<Row> {
    const found = await this.prisma.supportTicket.findUnique({ where: { id }, include: { ticket: { select: { key: true, title: true } } } });
    if (!found) throw new ApiException(HttpStatus.NOT_FOUND, ErrorCodes.notFound, 'Support ticket not found');
    return found;
  }

  /** POST /support-tickets/:id/action: one endpoint for every action in the plan's table (BUILD_PLAN v1 6.5). */
  async act(id: string, body: unknown): Promise<SupportTicketDto> {
    const { action, note, answer, planMarkdown } = parseBody(ActionBody, body);
    const q = await this.find(id);
    const kind = q.kind as SupportKind;
    if (q.status !== 'open' && !(q.status === 'answered' && kind === 'open_question')) throw new ApiException(HttpStatus.CONFLICT, ErrorCodes.conflict, `This ticket is already ${q.status}`);
    if (!SUPPORT_ACTIONS[kind].includes(action)) throw new ApiException(HttpStatus.BAD_REQUEST, ErrorCodes.validation, `A ${kind.replace('_', ' ')} ticket cannot be ${action}`, { action: 'not allowed for this kind' });
    const needTicket = () => {
      if (!q.ticketId) throw new ApiException(HttpStatus.CONFLICT, ErrorCodes.conflict, 'This ticket is not about a pipeline ticket');
      return q.ticketId;
    };

    switch (action) {
      case 'approve':
        if (q.stage === 'breakdown') await this.tickets.approveBreakdown(needTicket(), {});
        else await this.tickets.approvePlan(needTicket(), planMarkdown ? { planMarkdown } : {});
        break;
      case 'reject':
        if (!note) throw new ApiException(HttpStatus.BAD_REQUEST, ErrorCodes.validation, 'Validation failed', { note: 'required' });
        if (q.stage === 'breakdown') await this.tickets.rejectBreakdown(needTicket(), { note });
        else await this.tickets.rejectPlan(needTicket(), { note });
        break;
      case 'answer':
        if (!answer) throw new ApiException(HttpStatus.BAD_REQUEST, ErrorCodes.validation, 'Validation failed', { answer: 'is required' });
        await this.answer(q, answer);
        break;
      case 'rerun_with_answers':
        await this.rerunWithAnswers(q, needTicket());
        break;
      case 'resume':
        await this.tickets.resumeTicket(needTicket());
        break;
      case 'retry':
        await this.tickets.retryTicket(needTicket());
        break;
      case 'fail':
        await this.states.fail(needTicket(), note ? `Marked failed from the inbox: ${note}` : 'Marked failed from the inbox');
        break;
      case 'fixed': {
        // "Fixed, re-run CI": the hold ends and the CI poller looks again.
        const ticket = await this.prisma.ticket.findUniqueOrThrow({ where: { id: needTicket() } });
        await this.raiser.close({ ticketId: ticket.id, kind: 'ci_infra' }, 'resolved', 'user', note ?? 'Marked as fixed');
        if (ticket.status === 'ON_HOLD' || ticket.status === 'FAILED') await this.tickets.resumeTicket(ticket.id);
        break;
      }
      case 'hold':
        await this.tickets.holdTicket(needTicket()).catch(() => undefined);
        await this.raiser.close({ ticketId: needTicket(), kind: 'ci_infra' }, 'resolved', 'user', 'Put on hold');
        break;
      case 'dismiss':
        await this.prisma.supportTicket.update({ where: { id }, data: { status: 'dismissed', resolvedBy: 'user', resolvedAt: new Date(), ...(note ? { response: note } : {}) } });
        break;
    }
    // Make sure the ticket the person acted on is closed, even if no transition did it (an open_question answered, a fixed CI).
    const after = await this.find(id);
    return toDto(after);
  }

  private async answer(q: Row, answer: string): Promise<void> {
    // Only the first answer wins: the update is conditional on the ticket still being open.
    const { count } = await this.prisma.supportTicket.updateMany({ where: { id: q.id, status: q.kind === 'open_question' ? { in: ['open', 'answered'] } : 'open' }, data: { response: answer, status: 'answered', resolvedBy: 'user', resolvedAt: new Date() } });
    if (count === 0) throw new ApiException(HttpStatus.CONFLICT, ErrorCodes.conflict, 'This question was already answered');
    if (!q.ticketId) return;
    const ticket = await this.prisma.ticket.findUniqueOrThrow({ where: { id: q.ticketId } });
    await logEvent(this.prisma, events.note({ source: 'user', type: 'support', message: `Answered the ${q.stage || 'pipeline'} question` }), { ticketId: ticket.id });
    if (q.kind !== 'question') return; // an open question does not block: the plan went ahead with its default
    // Resume only when this was the question the ticket is waiting on; with other questions open it keeps waiting for them.
    const stillOpen = await this.prisma.supportTicket.count({ where: { ticketId: ticket.id, kind: 'question', status: 'open' } });
    if (ticket.status === 'ON_HOLD' && ticket.holdReason === 'awaiting_answer' && stillOpen === 0) await this.states.resume(ticket.id, 'user', 'Question answered');
  }

  /** "Rerun plan with answers": the answers to the plan's open questions go back to the plan stage as the rejection note. */
  private async rerunWithAnswers(q: Row, ticketId: string): Promise<void> {
    const answered = await this.prisma.supportTicket.findMany({ where: { ticketId, kind: 'open_question', status: 'answered' }, orderBy: { createdAt: 'asc' } });
    const list = answered.length > 0 ? answered : [q];
    if (!q.response && answered.length === 0) throw new ApiException(HttpStatus.CONFLICT, ErrorCodes.conflict, 'Answer at least one open question first');
    const note = `Answers to your open questions:\n${list.map((a, i) => `${i + 1}. ${a.title}\n   ${a.response ?? a.defaultAnswer ?? ''}`).join('\n')}`.slice(0, 2000);
    await this.tickets.rejectPlan(ticketId, { note });
    await this.prisma.supportTicket.updateMany({ where: { id: { in: list.map((a) => a.id) } }, data: { status: 'resolved', resolvedBy: 'user', resolvedAt: new Date() } });
  }
}
