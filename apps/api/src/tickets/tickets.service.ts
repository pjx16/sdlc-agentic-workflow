import { HttpStatus, Injectable } from '@nestjs/common';
import { ErrorCodes, legalMoves, PasteTicketSchema, ProjectSettingsSchema, TICKET_STATUSES, kindOfType, typeOfKind, validateBreakdown, type Move, type SubtaskDraft, type TicketStatus } from '@sdlc/shared';
import { ApiException } from '../common/api-exception';
import { allArtifacts, writeArtifact } from '../common/artifacts';
import { parseBody } from '../common/parse-body';
import { z } from 'zod';
import { JiraClients } from '../jira/jira-clients';
import { PrismaService } from '../prisma/prisma.service';
import { StateMachine } from '../state/state-machine.service';
import { SubtasksService } from '../subtasks/subtasks.service';
import type { Prisma } from '../generated/prisma/client';
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
  /** advance | rerun | hold | resume | fail | retry | approve | reject */
  kind: string;
  note: string | null;
  jiraStatusApplied: string | null;
  jiraSyncResult: 'none' | 'applied' | 'failed';
  jiraSyncError: string | null;
}

export interface ArtifactDto {
  id: string;
  stage: string;
  version: number;
  data: unknown;
  /** Superseded by a rerun: kept, shown greyed out. */
  stale: boolean;
  supersededAt: string | null;
  stageRunId: string | null;
  createdAt: string;
  externalUrl: string | null;
}

export interface TicketEventDto {
  id: string;
  at: string;
  level: 'info' | 'warn' | 'error';
  source: string;
  type: string;
  message: string;
  errorCode: string | null;
  stageRunId: string | null;
  subtaskId: string | null;
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


/** Everything the ticket page needs to explain a hold: what happened and what can be done about it. */
export interface HoldInfo {
  status: string;
  holdReason: string | null;
  holdFromStatus: string | null;
  /** Why the ticket went on hold or failed (the reason of that transition), and when. */
  note: string | null;
  at: string | null;
  /** The latest stage run of this ticket that failed. */
  failedRun: { id: string; stage: string; attempt: number; round: number; error: string | null } | null;
  /** The subtask being worked on (the first that is not done). */
  subtask: { seq: number; title: string; status: string; fixRounds: number } | null;
  /** True when this subtask's tests can be discarded and written again. */
  canRedoTests: boolean;
}

const ApproveBody = z.object({ planMarkdown: z.string().trim().min(1, 'must not be empty').max(100_000, 'must be at most 100000 characters').optional() });
const BreakdownApproveBody = z.object({ subtasks: z.array(z.unknown()).optional() });
const RejectBody = z.object({ note: z.string({ error: 'required' }).trim().min(1, 'required').max(2000, 'must be at most 2000 characters') });

const fieldError = (field: string, message: string) => new ApiException(HttpStatus.BAD_REQUEST, ErrorCodes.validation, 'Validation failed', { [field]: message });

@Injectable()
export class TicketsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly states: StateMachine,
    private readonly jira: JiraClients,
    private readonly subtasks: SubtasksService,
  ) {}

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
        project: { select: { name: true, settings: true } },
        subtasks: { orderBy: { seq: 'asc' } },
        stageRuns: { orderBy: [{ startedAt: 'asc' }, { id: 'asc' }] },
        findings: { orderBy: [{ round: 'asc' }, { id: 'asc' }] },
        supportTickets: { where: { kind: 'question' }, orderBy: { createdAt: 'asc' } },
      },
    });
    const { project, subtasks, stageRuns, findings, supportTickets, ...ticket } = t;
    return {
      ...toTicketDto(ticket),
      projectName: project.name,
      maxSubtasks: ProjectSettingsSchema.parse(project.settings).limits.maxSubtasks,
      planMarkdown: ticket.planMarkdown,
      breakdownDraft: ticket.breakdownDraft,
      subtasks: subtasks.map((s) => ({ id: s.id, seq: s.seq, title: s.title, description: s.description, status: s.status, fixRounds: s.fixRounds, acceptanceCriteria: s.acceptanceCriteria, files: s.files, dependsOn: s.dependsOn })),
      stageRuns: stageRuns.map((r) => ({
        id: r.id, stage: r.stage, model: r.model, attempt: r.attempt, round: r.round, status: r.status, startedAt: iso(r.startedAt), endedAt: iso(r.endedAt),
        inputTokens: r.inputTokens, outputTokens: r.outputTokens, costUsd: Number(r.costUsd), numTurns: r.numTurns, error: r.error, errorCode: r.errorCode, errorSource: r.errorSource, retryAt: r.retryAt?.toISOString() ?? null,
        supersededAt: r.supersededAt?.toISOString() ?? null, trigger: r.trigger, startSha: r.startSha, endSha: r.endSha,
      })),
      findings: findings.map((f) => ({ id: f.id, round: f.round, severity: f.severity, file: f.file, line: f.line, issue: f.issue, rule: f.rule, fix: f.fix, status: f.status })),
      supportQueries: supportTickets.map((q) => ({ id: q.id, stage: q.stage, question: q.body, answer: q.response, status: q.status === 'open' ? ('open' as const) : ('answered' as const), createdAt: q.createdAt.toISOString(), answeredAt: iso(q.resolvedAt) })),
    };
  }

  /** GET /tickets/:id/transitions: the state history, oldest first, with the Jira sync result of each step. */
  async transitions(id: string): Promise<TransitionDto[]> {
    await this.findOr404(id);
    const rows = await this.prisma.stateTransition.findMany({ where: { ticketId: id }, orderBy: [{ at: 'asc' }, { id: 'asc' }] });
    return rows.map((r) => ({
      id: r.id, at: r.at.toISOString(), fromStatus: r.fromStatus, toStatus: r.toStatus, actor: r.actor, reason: r.reason, stageRunId: r.stageRunId,
      kind: r.kind, note: r.note, jiraStatusApplied: r.jiraStatusApplied, jiraSyncResult: r.jiraSyncResult, jiraSyncError: r.jiraSyncError,
    }));
  }

  /** GET /tickets/:id/moves: every legal move right now (BUILD_PLAN v1 6.8). The dashboard offers reruns from it. */
  async moves(id: string): Promise<Move[]> {
    const t = await this.prisma.ticket.findUnique({ where: { id }, include: { project: true } });
    if (!t) throw new ApiException(HttpStatus.NOT_FOUND, ErrorCodes.notFound, 'Ticket not found');
    const history = await this.prisma.stateTransition.findMany({ where: { ticketId: id }, orderBy: [{ at: 'asc' }, { id: 'asc' }], select: { fromStatus: true, toStatus: true, kind: true } });
    const gates = ProjectSettingsSchema.parse(t.project.settings).gates;
    return legalMoves({ status: t.status, holdFromStatus: t.holdFromStatus, moves: history as never, gates });
  }

  /** GET /tickets/:id/artifacts: every version of the plan, breakdown, review rounds and KB pointer, stale ones included. */
  async artifacts(id: string): Promise<ArtifactDto[]> {
    await this.findOr404(id);
    return (await allArtifacts(this.prisma, id)).map((a) => ({ id: a.id, stage: a.stage, version: a.version, data: a.data, stale: a.supersededAt !== null, supersededAt: a.supersededAt?.toISOString() ?? null, stageRunId: a.stageRunId, createdAt: a.createdAt.toISOString(), externalUrl: a.externalUrl }));
  }

  /** GET /tickets/:id/events: the plain-English stream of everything that happened to the ticket, oldest first (BUILD_PLAN v1 6.4). */
  async events(id: string): Promise<TicketEventDto[]> {
    await this.findOr404(id);
    const rows = await this.prisma.event.findMany({ where: { ticketId: id }, orderBy: [{ at: 'asc' }, { id: 'asc' }], take: 1000 });
    return rows.map((e) => ({ id: e.id, at: e.at.toISOString(), level: e.level as TicketEventDto['level'], source: e.source, type: e.type, message: e.message, errorCode: e.errorCode, stageRunId: e.stageRunId, subtaskId: e.subtaskId }));
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
    // A pasted ticket carries a kind (BUILD_PLAN v1 6.7). The older `type` field still works and the two stay consistent.
    const kind = input.kind ?? kindOfType(input.type ?? 'story');
    const type = input.type && !input.kind ? input.type : typeOfKind(kind);
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
        data: { projectId: project.id, key, source: 'paste', type, kind, title: input.title, body: input.body, featureKey: input.featureKey ?? null, status: 'NEW' },
      });
      await tx.event.create({ data: { ticketId: created.id, type: 'intake', message: `${key} pasted` } });
      return created;
    });
    return toTicketDto(ticket);
  }

  /** The plan gate only exists while a ticket is awaiting plan approval (409 otherwise). */
  private async awaitingPlan(id: string) {
    const ticket = await this.prisma.ticket.findUnique({ where: { id }, include: { project: true } });
    if (!ticket) throw new ApiException(HttpStatus.NOT_FOUND, ErrorCodes.notFound, 'Ticket not found');
    if (ticket.status !== 'AWAITING_PLAN_APPROVAL') {
      throw new ApiException(HttpStatus.CONFLICT, ErrorCodes.conflict, `The ticket is not awaiting plan approval (it is ${ticket.status})`);
    }
    return ticket;
  }

  /**
   * POST /tickets/:id/plan/approve: stores the edited plan if one is sent, and in REST mode re-reads the issue's title and
   * description so edits made in Jira reach the breakdown stage (F7). Then BREAKDOWN (row 5).
   */
  async approvePlan(id: string, body: unknown): Promise<TicketDto> {
    const { planMarkdown } = parseBody(ApproveBody, body ?? {});
    const ticket = await this.awaitingPlan(id);

    if (planMarkdown !== undefined && planMarkdown !== ticket.planMarkdown) {
      const { count } = await this.prisma.ticket.updateMany({ where: { id, status: 'AWAITING_PLAN_APPROVAL' }, data: { planMarkdown } });
      if (count === 0) throw new ApiException(HttpStatus.CONFLICT, ErrorCodes.conflict, 'The ticket changed while it was being updated');
      await writeArtifact(this.prisma, id, 'plan', { planMarkdown, editedBy: 'user' }).catch(() => undefined);
    }
    if (ticket.source === 'jira' && ticket.externalKey && ticket.project.jiraMode === 'rest') await this.refreshFromJira(ticket.id, ticket.key, ticket.externalKey);

    const { ticket: updated } = await this.states.transition(id, 'BREAKDOWN', 'user', planMarkdown !== undefined && planMarkdown !== ticket.planMarkdown ? 'Plan approved with edits' : 'Plan approved', undefined, { kind: 'approve' });
    return toTicketDto(updated);
  }

  /** POST /tickets/:id/plan/reject: the note goes back to the plan stage with the previous plan (row 6). */
  async rejectPlan(id: string, body: unknown): Promise<TicketDto> {
    const { note } = parseBody(RejectBody, body ?? {});
    await this.awaitingPlan(id);
    const { ticket } = await this.states.transition(id, 'PLANNING', 'user', note, undefined, { kind: 'reject', note });
    return toTicketDto(ticket);
  }

  /** Developer edits made in Jira reach the next stages. A Jira problem is recorded and never blocks the approval. */
  private async refreshFromJira(ticketId: string, key: string, externalKey: string): Promise<void> {
    try {
      const issue = await (await this.jira.forRest()).readStatus(externalKey);
      await this.prisma.ticket.update({ where: { id: ticketId }, data: { title: issue.summary || undefined, body: issue.description } });
    } catch (err) {
      await this.prisma.event.create({ data: { ticketId, type: 'jira', message: `${key}: could not re-read the Jira issue: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500) } });
    }
  }

  /** POST /tickets/:id/kb-update/rerun: queues one more kbUpdate on the current branch. Only in IN_HUMAN_REVIEW. */
  async rerunKbUpdate(id: string): Promise<TicketDto> {
    const ticket = await this.findOr404(id);
    if (ticket.status !== 'IN_HUMAN_REVIEW') {
      throw new ApiException(HttpStatus.CONFLICT, ErrorCodes.conflict, `The KB update can only be re-run in IN_HUMAN_REVIEW (the ticket is ${ticket.status})`);
    }
    const { count } = await this.prisma.ticket.updateMany({ where: { id, status: 'IN_HUMAN_REVIEW' }, data: { kbUpdatePending: true } });
    if (count === 0) throw new ApiException(HttpStatus.CONFLICT, ErrorCodes.conflict, 'The ticket is no longer in IN_HUMAN_REVIEW');
    await this.prisma.event.create({ data: { ticketId: id, type: 'system', message: 'KB update re-run requested' } });
    return toTicketDto(await this.prisma.ticket.findUniqueOrThrow({ where: { id } }));
  }

  /** POST /tickets/:id/hold: puts the ticket on hold (`manual`) from any state a hold is allowed from (row 16). */
  async holdTicket(id: string): Promise<TicketDto> {
    const ticket = await this.findOr404(id);
    if (['DONE', 'FAILED', 'ON_HOLD'].includes(ticket.status)) {
      throw new ApiException(HttpStatus.CONFLICT, ErrorCodes.conflict, `A ${ticket.status} ticket cannot be put on hold`);
    }
    await this.states.hold(id, 'manual', 'user', 'Put on hold by the developer');
    return toTicketDto(await this.prisma.ticket.findUniqueOrThrow({ where: { id } }));
  }

  private async heldOrFailed(id: string, what: string) {
    const ticket = await this.findOr404(id);
    if (ticket.status !== 'ON_HOLD' && ticket.status !== 'FAILED') {
      throw new ApiException(HttpStatus.CONFLICT, ErrorCodes.conflict, `${what} needs a ticket that is on hold or failed (it is ${ticket.status})`);
    }
    return ticket;
  }

  /** POST /tickets/:id/resume: back to the state the ticket was held from (row 17); the work carries on where it was. */
  async resumeTicket(id: string): Promise<TicketDto> {
    await this.heldOrFailed(id, 'Resume');
    await this.states.resume(id, 'user', 'Resumed by the developer');
    return toTicketDto(await this.prisma.ticket.findUniqueOrThrow({ where: { id } }));
  }

  /**
   * POST /tickets/:id/retry: like resume, but the stage that was in progress runs again fresh: the fix-round, CI-fix and verify-red
   * counters of the work in progress are reset (BUILD_PLAN 6.8). Works on held and failed tickets.
   */
  async retryTicket(id: string): Promise<TicketDto> {
    await this.heldOrFailed(id, 'Retry');
    await this.prisma.$transaction([
      this.prisma.subtask.updateMany({ where: { ticketId: id, status: { not: 'DONE' } }, data: { fixRounds: 0, lastFailure: null, retriedAt: new Date() } }),
      this.prisma.ticket.update({ where: { id }, data: { ciFixPending: false, ciFixDone: false, ciWaitStartedAt: null, kbUpdatePending: false } }),
    ]);
    await this.states.resume(id, 'user', 'Retried by the developer');
    return toTicketDto(await this.prisma.ticket.findUniqueOrThrow({ where: { id } }));
  }

  /** GET /tickets/:id/hold: what happened to a held or failed ticket, and which recovery actions apply. */
  async holdInfo(id: string): Promise<HoldInfo> {
    const ticket = await this.findOr404(id);
    const held = ticket.status === 'ON_HOLD' || ticket.status === 'FAILED';
    const transition = held ? await this.prisma.stateTransition.findFirst({ where: { ticketId: id, toStatus: ticket.status }, orderBy: { at: 'desc' } }) : null;
    const failedRun = held ? await this.prisma.stageRun.findFirst({ where: { ticketId: id, status: 'failed' }, orderBy: { startedAt: 'desc' } }) : null;
    const subtask = await this.prisma.subtask.findFirst({ where: { ticketId: id, status: { not: 'DONE' } }, orderBy: { seq: 'asc' } });
    return {
      status: ticket.status,
      holdReason: ticket.holdReason,
      holdFromStatus: ticket.holdFromStatus,
      note: transition?.reason ?? null,
      at: iso(transition?.at ?? null),
      failedRun: failedRun && { id: failedRun.id, stage: failedRun.stage, attempt: failedRun.attempt, round: failedRun.round, error: failedRun.error },
      subtask: subtask && { seq: subtask.seq, title: subtask.title, status: subtask.status, fixRounds: subtask.fixRounds },
      canRedoTests: held && Boolean(subtask?.testCommit) && (ticket.holdFromStatus === 'IN_PROGRESS' || ticket.status === 'FAILED'),
    };
  }

  private async awaitingBreakdown(id: string) {
    const ticket = await this.prisma.ticket.findUnique({ where: { id }, include: { project: true } });
    if (!ticket) throw new ApiException(HttpStatus.NOT_FOUND, ErrorCodes.notFound, 'Ticket not found');
    if (ticket.status !== 'AWAITING_BREAKDOWN_APPROVAL') {
      throw new ApiException(HttpStatus.CONFLICT, ErrorCodes.conflict, `The ticket is not awaiting breakdown approval (it is ${ticket.status})`);
    }
    return ticket;
  }

  /**
   * POST /tickets/:id/breakdown/approve: the edited list (or, without one, the proposed list) is validated with the same
   * rules as the stage output (400 with field-level errors if invalid), stored, turned into ordered Subtask rows, and the
   * ticket moves to IN_PROGRESS (row 9).
   */
  async approveBreakdown(id: string, body: unknown): Promise<TicketDto> {
    const { subtasks: edited } = parseBody(BreakdownApproveBody, body ?? {});
    const ticket = await this.awaitingBreakdown(id);
    const maxSubtasks = ProjectSettingsSchema.parse(ticket.project.settings).limits.maxSubtasks;

    const verdict = validateBreakdown(edited ?? ticket.breakdownDraft, { maxSubtasks });
    if (!verdict.ok) {
      const fields: Record<string, string> = {};
      for (const issue of verdict.issues) if (!(issue.field in fields)) fields[issue.field] = issue.message;
      throw new ApiException(HttpStatus.BAD_REQUEST, ErrorCodes.validation, 'The breakdown is not valid', fields);
    }
    const changed = edited !== undefined && JSON.stringify(verdict.subtasks) !== JSON.stringify(ticket.breakdownDraft);
    if (changed) {
      const { count } = await this.prisma.ticket.updateMany({ where: { id, status: 'AWAITING_BREAKDOWN_APPROVAL' }, data: { breakdownDraft: verdict.subtasks as unknown as Prisma.InputJsonValue } });
      if (count === 0) throw new ApiException(HttpStatus.CONFLICT, ErrorCodes.conflict, 'The ticket changed while it was being updated');
      await writeArtifact(this.prisma, id, 'breakdown', { subtasks: verdict.subtasks, editedBy: 'user' }).catch(() => undefined);
    }
    await this.subtasks.create(id, verdict.subtasks as SubtaskDraft[]);
    await this.subtasks.publishToJira(id); // Jira sub-tasks when write-back is on; a Jira problem never blocks
    const { ticket: updated } = await this.states.transition(id, 'IN_PROGRESS', 'user', changed ? 'Breakdown approved with edits' : 'Breakdown approved', undefined, { kind: 'approve' });
    return toTicketDto(updated);
  }

  /** POST /tickets/:id/breakdown/reject: the note goes back to the breakdown stage with the previous list (row 10). */
  async rejectBreakdown(id: string, body: unknown): Promise<TicketDto> {
    const { note } = parseBody(RejectBody, body ?? {});
    await this.awaitingBreakdown(id);
    const { ticket } = await this.states.transition(id, 'BREAKDOWN', 'user', note, undefined, { kind: 'reject', note });
    return toTicketDto(ticket);
  }
}
