import { HttpStatus, Injectable } from '@nestjs/common';
import { ErrorCodes, PasteTicketSchema, ProjectSettingsSchema, TICKET_STATUSES, type TicketStatus } from '@sdlc/shared';
import { ApiException } from '../common/api-exception';
import { parseBody } from '../common/parse-body';
import { PrismaService } from '../prisma/prisma.service';
import { type TicketDto, toTicketDto } from './ticket.dto';

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export interface TicketListItem extends TicketDto {
  projectName: string;
}

export interface TransitionDto {
  id: string;
  at: string;
  fromStatus: string;
  toStatus: string;
  actor: string;
  reason: string | null;
  stageRunId: string | null;
  jiraStatusApplied: string | null;
  jiraSyncResult: 'none' | 'applied' | 'failed';
  jiraSyncError: string | null;
}

export interface TimelineBar {
  id: string;
  stage: string;
  attempt: number;
  round: number;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
}

const fieldError = (field: string, message: string) => new ApiException(HttpStatus.BAD_REQUEST, ErrorCodes.validation, 'Validation failed', { [field]: message });

@Injectable()
export class TicketsService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /tickets, newest activity first. Filters: `projectId`, `status`. */
  async list(query: { projectId?: string; status?: string }): Promise<TicketListItem[]> {
    if (query.status && !(TICKET_STATUSES as readonly string[]).includes(query.status)) throw fieldError('status', `must be one of ${TICKET_STATUSES.join(', ')}`);
    const rows = await this.prisma.ticket.findMany({
      where: { ...(query.projectId ? { projectId: query.projectId } : {}), ...(query.status ? { status: query.status as TicketStatus } : {}) },
      include: { project: { select: { name: true } } },
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map(({ project, ...ticket }) => ({ ...toTicketDto(ticket), projectName: project.name }));
  }

  private async findOr404(id: string) {
    const ticket = await this.prisma.ticket.findUnique({ where: { id }, include: { project: { select: { name: true } } } });
    if (!ticket) throw new ApiException(HttpStatus.NOT_FOUND, ErrorCodes.notFound, 'Ticket not found');
    return ticket;
  }

  /** GET /tickets/:id: the ticket with its subtasks, stage runs, findings and support queries. */
  async get(id: string) {
    await this.findOr404(id);
    const t = await this.prisma.ticket.findUniqueOrThrow({
      where: { id },
      include: {
        project: { select: { name: true } },
        subtasks: { orderBy: { seq: 'asc' } },
        stageRuns: { orderBy: [{ startedAt: 'asc' }, { id: 'asc' }] },
        findings: { orderBy: [{ round: 'asc' }, { id: 'asc' }] },
        queries: { orderBy: { createdAt: 'asc' } },
      },
    });
    const { project, subtasks, stageRuns, findings, queries, ...ticket } = t;
    return {
      ...toTicketDto(ticket),
      projectName: project.name,
      planMarkdown: ticket.planMarkdown,
      subtasks: subtasks.map((s) => ({ id: s.id, seq: s.seq, title: s.title, description: s.description, status: s.status, fixRounds: s.fixRounds, acceptanceCriteria: s.acceptanceCriteria, files: s.files, dependsOn: s.dependsOn })),
      stageRuns: stageRuns.map((r) => ({
        id: r.id, stage: r.stage, model: r.model, attempt: r.attempt, round: r.round, status: r.status, startedAt: iso(r.startedAt), endedAt: iso(r.endedAt),
        inputTokens: r.inputTokens, outputTokens: r.outputTokens, costUsd: Number(r.costUsd), numTurns: r.numTurns, error: r.error,
      })),
      findings: findings.map((f) => ({ id: f.id, round: f.round, severity: f.severity, file: f.file, line: f.line, issue: f.issue, rule: f.rule, fix: f.fix, status: f.status })),
      supportQueries: queries.map((q) => ({ id: q.id, stage: q.stage, question: q.question, answer: q.answer, status: q.status, createdAt: q.createdAt.toISOString(), answeredAt: iso(q.answeredAt) })),
    };
  }

  /** GET /tickets/:id/transitions: the state history, oldest first, with the Jira sync result of each step. */
  async transitions(id: string): Promise<TransitionDto[]> {
    await this.findOr404(id);
    const rows = await this.prisma.stateTransition.findMany({ where: { ticketId: id }, orderBy: [{ at: 'asc' }, { id: 'asc' }] });
    return rows.map((r) => ({
      id: r.id, at: r.at.toISOString(), fromStatus: r.fromStatus, toStatus: r.toStatus, actor: r.actor, reason: r.reason, stageRunId: r.stageRunId,
      jiraStatusApplied: r.jiraStatusApplied, jiraSyncResult: r.jiraSyncResult, jiraSyncError: r.jiraSyncError,
    }));
  }

  /** GET /tickets/:id/timeline: stage runs as bars (stage, start, end, outcome). */
  async timeline(id: string): Promise<TimelineBar[]> {
    await this.findOr404(id);
    const runs = await this.prisma.stageRun.findMany({ where: { ticketId: id }, orderBy: [{ startedAt: 'asc' }, { id: 'asc' }] });
    return runs.map((r) => ({ id: r.id, stage: r.stage, attempt: r.attempt, round: r.round, status: r.status, startedAt: iso(r.startedAt), endedAt: iso(r.endedAt) }));
  }

  /** POST /tickets: a pasted ticket with a local key `<localKeyPrefix>-<n>`, status NEW. Works in every Jira mode. */
  async paste(body: unknown): Promise<TicketDto> {
    const input = parseBody(PasteTicketSchema, body);
    const project = await this.prisma.project.findUnique({ where: { id: input.projectId } });
    if (!project) throw fieldError('projectId', 'unknown project');
    if (!project.enabled) throw fieldError('projectId', 'this project is disabled');
    if (!ProjectSettingsSchema.parse(project.settings).intake.paste) throw fieldError('projectId', 'pasting tickets is turned off for this project');
    // F2: a project accepts tickets only when its mirror is ready.
    if (project.mirrorStatus !== 'ok') {
      throw new ApiException(HttpStatus.CONFLICT, ErrorCodes.conflict, `The repository mirror is ${project.mirrorStatus === 'pending' ? 'still being cloned' : 'not ready (it failed)'}`);
    }

    const ticket = await this.prisma.$transaction(async (tx) => {
      // Atomic allocation: the increment returns the new counter, so concurrent pastes never share a number.
      const updated = await tx.project.update({ where: { id: project.id }, data: { nextLocalNumber: { increment: 1 } }, select: { nextLocalNumber: true, localKeyPrefix: true } });
      const key = `${updated.localKeyPrefix}-${updated.nextLocalNumber - 1}`;
      const created = await tx.ticket.create({
        data: { projectId: project.id, key, source: 'paste', type: input.type, title: input.title, body: input.body, featureKey: input.featureKey ?? null, status: 'NEW' },
      });
      await tx.event.create({ data: { ticketId: created.id, type: 'intake', message: `${key} pasted` } });
      return created;
    });
    return toTicketDto(ticket);
  }
}
