import { HttpStatus, Injectable } from '@nestjs/common';
import { ErrorCodes } from '@sdlc/shared';
import { z } from 'zod';
import { ApiException } from '../common/api-exception';
import { parseBody } from '../common/parse-body';
import { PrismaService } from '../prisma/prisma.service';
import { StateMachine } from '../state/state-machine.service';

const AnswerSchema = z.object({ answer: z.string().trim().min(1, 'is required').max(10_000, 'must be at most 10000 characters') });

export interface SupportQueryDto {
  id: string;
  ticketId: string;
  ticketKey: string;
  ticketTitle: string;
  stage: string;
  question: string;
  answer: string | null;
  status: 'open' | 'answered';
  createdAt: string;
  answeredAt: string | null;
}

@Injectable()
export class SupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly states: StateMachine,
  ) {}

  /** Open questions first (oldest first), then answered ones (newest first). */
  async list(query: { status?: string } = {}): Promise<SupportQueryDto[]> {
    const status = query.status === 'open' || query.status === 'answered' ? query.status : undefined;
    const rows = await this.prisma.supportQuery.findMany({ where: status ? { status } : {}, include: { ticket: { select: { key: true, title: true } } } });
    const dtos = rows.map((q) => ({
      id: q.id,
      ticketId: q.ticketId,
      ticketKey: q.ticket.key,
      ticketTitle: q.ticket.title,
      stage: q.stage,
      question: q.question,
      answer: q.answer,
      status: q.status,
      createdAt: q.createdAt.toISOString(),
      answeredAt: q.answeredAt?.toISOString() ?? null,
    }));
    const open = dtos.filter((d) => d.status === 'open').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const answered = dtos.filter((d) => d.status === 'answered').sort((a, b) => (b.answeredAt ?? '').localeCompare(a.answeredAt ?? ''));
    return [...open, ...answered];
  }

  /**
   * POST /support-queries/:id/answer (F13): stores the answer and, if the ticket is waiting for it, resumes the ticket so the same
   * stage runs again with the question and answer in its prompt. 409 if the question was already answered.
   */
  async answer(id: string, body: unknown): Promise<SupportQueryDto> {
    const { answer } = parseBody(AnswerSchema, body);
    const found = await this.prisma.supportQuery.findUnique({ where: { id } });
    if (!found) throw new ApiException(HttpStatus.NOT_FOUND, ErrorCodes.notFound, 'Support query not found');
    // Only the first answer wins: the update is conditional on the question still being open.
    const { count } = await this.prisma.supportQuery.updateMany({ where: { id, status: 'open' }, data: { answer, status: 'answered', answeredAt: new Date() } });
    if (count === 0) throw new ApiException(HttpStatus.CONFLICT, ErrorCodes.conflict, 'This question was already answered');

    const ticket = await this.prisma.ticket.findUniqueOrThrow({ where: { id: found.ticketId } });
    await this.prisma.event.create({ data: { ticketId: ticket.id, type: 'system', message: `Answered the ${found.stage} question` } });
    // Resume only when this was the question the ticket is waiting on; with other questions open it keeps waiting for them.
    const stillOpen = await this.prisma.supportQuery.count({ where: { ticketId: ticket.id, status: 'open' } });
    if (ticket.status === 'ON_HOLD' && ticket.holdReason === 'awaiting_answer' && stillOpen === 0) {
      await this.states.resume(ticket.id, 'user', 'Question answered');
    }
    const [dto] = (await this.list()).filter((d) => d.id === id);
    return dto as SupportQueryDto;
  }
}
