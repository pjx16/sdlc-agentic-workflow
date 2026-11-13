import { HttpStatus, Injectable } from '@nestjs/common';
import { ErrorCodes, FORWARD_ORDER, ProjectSettingsSchema, RERUNNABLE_STATES, checkMove, loopLimitMessage, orderOf, rerunCount, type MoveRecord, type TicketStatus } from '@sdlc/shared';
import { z } from 'zod';
import { ApiException } from '../common/api-exception';
import { parseBody } from '../common/parse-body';
import { JiraClients } from '../jira/jira-clients';
import { jiraMarker } from '../jira/jira-client';
import type { Ticket } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StateMachine } from '../state/state-machine.service';
import { SupportRaiser } from '../support/support-raiser';
import { type TicketDto, toTicketDto } from './ticket.dto';
import { logEvent } from '../common/event-log';
import { events } from '@sdlc/shared';

const RerunBody = z.object({
  stage: z.enum(RERUNNABLE_STATES as unknown as [TicketStatus, ...TicketStatus[]], { error: 'must be a stage that can be rerun' }),
  note: z.string().trim().max(2000, 'must be at most 2000 characters').optional(),
});

const SubtaskRerunBody = z.object({
  part: z.enum(['tests', 'implementation'], { error: 'must be tests or implementation' }),
  note: z.string().trim().max(2000, 'must be at most 2000 characters').optional(),
});

/** Which runs and outputs belong to each rerunnable state. `fix` runs belong to the state their reason names. */
const OWNS: Record<string, { stages: string[]; fixReasons: string[]; artifacts: string[] }> = {
  KB: { stages: ['kbBuild'], fixReasons: [], artifacts: ['kb'] },
  PLANNING: { stages: ['plan'], fixReasons: [], artifacts: ['plan'] },
  BREAKDOWN: { stages: ['breakdown'], fixReasons: [], artifacts: ['breakdown'] },
  IN_PROGRESS: { stages: ['tests', 'implement'], fixReasons: ['tests'], artifacts: [] },
  REVIEW: { stages: ['review'], fixReasons: ['review'], artifacts: ['review'] },
  KB_UPDATE: { stages: ['kbUpdate'], fixReasons: ['ci'], artifacts: [] },
};

/**
 * Sends a ticket back to a stage that already finished (BUILD_PLAN v1 6.8). Everything after that stage becomes stale, always
 * (D4): the runs and outputs are kept and marked, never deleted. Stale code is removed later by the worker with a revert commit,
 * because only the worker can touch the workspace; this service records where that revert starts.
 */
@Injectable()
export class RerunService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly states: StateMachine,
    private readonly raiser: SupportRaiser,
    private readonly jira: JiraClients,
  ) {}

  private async ticket(id: string) {
    const t = await this.prisma.ticket.findUnique({ where: { id }, include: { project: true } });
    if (!t) throw new ApiException(HttpStatus.NOT_FOUND, ErrorCodes.notFound, 'Ticket not found');
    return t;
  }

  private moves(ticketId: string): Promise<MoveRecord[]> {
    return this.prisma.stateTransition.findMany({ where: { ticketId }, orderBy: [{ at: 'asc' }, { id: 'asc' }], select: { fromStatus: true, toStatus: true, kind: true } }) as Promise<MoveRecord[]>;
  }

  /** Step 1 of the rerun: a stage that is running must be killed first. The assistant does not count. */
  private async refuseWhileRunning(ticketId: string): Promise<void> {
    const running = await this.prisma.stageRun.count({ where: { ticketId, status: { in: ['queued', 'running'] }, stage: { not: 'assist' } } });
    if (running > 0) throw new ApiException(HttpStatus.CONFLICT, ErrorCodes.conflict, 'A stage is running for this ticket. Stop it first, then rerun.');
  }

  /** POST /tickets/:id/rerun */
  async rerun(id: string, body: unknown, actor: 'user' | 'system' = 'user'): Promise<TicketDto> {
    const { stage, note } = parseBody(RerunBody, body);
    const ticket = await this.ticket(id);
    await this.refuseWhileRunning(id);

    const moves = await this.moves(id);
    const verdict = checkMove({ status: ticket.status, holdFromStatus: ticket.holdFromStatus, moves }, 'rerun', stage);
    if (!verdict.ok) throw new ApiException(HttpStatus.CONFLICT, ErrorCodes.conflict, verdict.reason);

    // The loop guard: a person can send the same stage back only so often.
    const limit = ProjectSettingsSchema.parse(ticket.project.settings).loopLimits.userRerun;
    if (rerunCount(moves, stage) >= limit) {
      const message = loopLimitMessage('userRerun', limit, stage);
      if (ticket.status === 'ON_HOLD') {
        await this.raiser.raise({ kind: 'hold', ticketId: id, projectId: ticket.projectId, stage, dedupeKey: `loop:${id}:${stage}`, title: `${ticket.key}: rerun limit reached`, body: message });
      } else if (ticket.status !== 'FAILED') {
        await this.states.hold(id, 'loop_limit', 'system', message);
      }
      throw new ApiException(HttpStatus.CONFLICT, ErrorCodes.conflict, `${message} The ticket needs a decision from you in the inbox.`);
    }

    // Where the stale code starts, before the runs are marked: the earliest run that wrote code and is about to become stale.
    const stale = await this.staleRuns(id, stage);
    const earliestCode = stale.filter((r) => r.startSha).sort((a, b) => (a.startedAt?.getTime() ?? 0) - (b.startedAt?.getTime() ?? 0))[0];

    const { transition } = await this.states.transition(id, stage, actor, `Rerun of ${stage}`, undefined, { kind: 'rerun', note });
    const now = new Date();
    await this.prisma.stageRun.updateMany({ where: { id: { in: stale.map((r) => r.id) } }, data: { supersededAt: now, supersededByTransitionId: transition.id } });
    const owned = FORWARD_ORDER.filter((s) => orderOf(s) >= orderOf(stage)).flatMap((s) => OWNS[s]?.artifacts ?? []);
    await this.prisma.stageArtifact.updateMany({ where: { ticketId: id, stage: { in: owned }, supersededAt: null }, data: { supersededAt: now } });

    await this.resetFor(ticket, stage, note, earliestCode?.startSha ?? null);
    // What was waiting for a person about the stale work is no longer needed: the new run raises its own.
    const dismissed = await this.raiser.close({ ticketId: id, kind: ['approval', 'question', 'open_question', 'ci_infra', 'pr_ready', 'hold'] }, 'dismissed', 'system', 'The ticket was sent back to an earlier stage');
    if (dismissed > 0) await logEvent(this.prisma, events.note({ source: 'system', type: 'support', message: `${dismissed} open item${dismissed === 1 ? '' : 's'} about the stale work ${dismissed === 1 ? 'was' : 'were'} dismissed` }), { ticketId: id });

    await this.tellJira(ticket, stage, note);
    return toTicketDto(await this.prisma.ticket.findUniqueOrThrow({ where: { id } }));
  }

  /** The runs a rerun to `stage` makes obsolete: everything of that stage and after it that is not stale already. */
  private async staleRuns(ticketId: string, stage: TicketStatus) {
    const states = FORWARD_ORDER.filter((s) => orderOf(s) >= orderOf(stage));
    const stages = new Set(states.flatMap((s) => OWNS[s]?.stages ?? []));
    const fixReasons = new Set(states.flatMap((s) => OWNS[s]?.fixReasons ?? []));
    const runs = await this.prisma.stageRun.findMany({ where: { ticketId, supersededAt: null, stage: { not: 'assist' } } });
    return runs.filter((r) => stages.has(r.stage) || (r.stage === 'fix' && r.reason !== null && fixReasons.has(r.reason)) || (r.stage === 'fix' && r.reason === null && fixReasons.has('tests')));
  }

  /** The state the rerun leaves behind: what the stage's own bookkeeping must forget. */
  private async resetFor(ticket: Ticket, stage: TicketStatus, note: string | undefined, revertFromSha: string | null): Promise<void> {
    const common = { ciFixPending: false, ciFixDone: false, ciWaitStartedAt: null, kbUpdatePending: false };
    const pending = ticket.revertFromSha ?? revertFromSha; // an earlier revert that has not run yet starts earlier or at the same point
    await this.prisma.ticket.update({
      where: { id: ticket.id },
      data: {
        ...common,
        ...(pending ? { revertFromSha: pending, revertStage: stage } : {}),
        ...(orderOf(stage) <= orderOf('REVIEW') ? { reviewRound: 0, lastReviewedSha: null } : {}),
      },
    });
    // Findings of the stale review no longer describe the code: they are closed, not deleted.
    if (orderOf(stage) <= orderOf('REVIEW')) await this.prisma.reviewFinding.updateMany({ where: { ticketId: ticket.id, status: 'open' }, data: { status: 'fixed' } });
    if (stage === 'BREAKDOWN') await this.prisma.subtask.deleteMany({ where: { ticketId: ticket.id } });
    if (stage === 'IN_PROGRESS') {
      const lastFailure = note ? `The implementation is being redone. Developer note: ${note}` : null;
      await this.prisma.subtask.updateMany({ where: { ticketId: ticket.id }, data: { status: 'PENDING', fixRounds: 0, lastFailure, testCommit: null, featCommit: null, testFiles: [], redoTests: false, rerunPart: null, retriedAt: new Date() } });
    }
  }

  /** Outbound only (BUILD_PLAN v1 D3): the Jira status follows the transition, and one marker comment says why. A Jira problem never blocks. */
  private async tellJira(ticket: Ticket & { project: { jiraMode: string; settings: unknown } }, stage: TicketStatus, note: string | undefined): Promise<void> {
    const settings = ProjectSettingsSchema.parse(ticket.project.settings);
    if (ticket.source !== 'jira' || !ticket.externalKey || ticket.project.jiraMode !== 'rest' || !settings.jiraWriteBack.comments) return;
    const text = `Rerun of ${stage} requested${note ? `: ${note}` : '.'}`;
    try {
      await (await this.jira.forRest()).comment(ticket.externalKey, text, jiraMarker(ticket.key, `rerun-${stage}`, `${Date.now()}`));
    } catch (err) {
      await logEvent(this.prisma, events.warning({ code: 'JIRA_ERROR', detail: err instanceof Error ? err.message : String(err) }), { ticketId: ticket.id });
    }
  }

  /**
   * POST /tickets/:id/subtasks/:seq/rerun: inside implementation, one subtask's tests or implementation again. It replaces `redo-tests`.
   * The ticket must be held or failed (the worker is not working on it); the worker discards that part first (the API cannot touch the workspace).
   */
  async rerunSubtask(id: string, seq: number, body: unknown): Promise<TicketDto> {
    const { part, note } = parseBody(SubtaskRerunBody, body);
    const ticket = await this.ticket(id);
    if (ticket.status !== 'ON_HOLD' && ticket.status !== 'FAILED') {
      throw new ApiException(HttpStatus.CONFLICT, ErrorCodes.conflict, `A subtask can be rerun when its ticket is on hold or failed (it is ${ticket.status})`);
    }
    await this.refuseWhileRunning(id);
    const subtask = await this.prisma.subtask.findUnique({ where: { ticketId_seq: { ticketId: id, seq } } });
    if (!subtask) throw new ApiException(HttpStatus.NOT_FOUND, ErrorCodes.notFound, 'Subtask not found');
    if (subtask.status === 'DONE') throw new ApiException(HttpStatus.CONFLICT, ErrorCodes.conflict, 'This subtask is already done. Rerun the implementation stage of the ticket instead.');
    if (part === 'implementation' && !subtask.testCommit) throw new ApiException(HttpStatus.CONFLICT, ErrorCodes.conflict, 'This subtask has no tests of its own, so only its tests can be rerun.');
    if (part === 'tests' && !subtask.testCommit) throw new ApiException(HttpStatus.CONFLICT, ErrorCodes.conflict, 'There are no tests of this subtask to redo. Use Retry instead.');

    const why = await this.prisma.stateTransition.findFirst({ where: { ticketId: id, toStatus: ticket.status }, orderBy: [{ at: 'desc' }, { id: 'desc' }] });
    const lastFailure = [
      part === 'tests' ? 'The previous tests for this subtask are being written again from scratch.' : 'The previous implementation of this subtask is being written again against the same tests.',
      why?.reason ? `What went wrong: ${why.reason}` : null,
      note ? `Developer note: ${note}` : null,
      'Do not require a particular code style unless an acceptance criterion says so.',
    ].filter(Boolean).join('\n\n');
    await this.prisma.$transaction([
      this.prisma.subtask.update({ where: { id: subtask.id }, data: { status: part === 'tests' ? 'TESTS' : 'IMPLEMENT', fixRounds: 0, lastFailure, retriedAt: new Date(), redoTests: part === 'tests', rerunPart: part } }),
      this.prisma.ticket.update({ where: { id }, data: { ciFixPending: false, ciFixDone: false, ciWaitStartedAt: null, kbUpdatePending: false } }),
    ]);
    await logEvent(this.prisma, events.note({ source: 'user', type: 'state', message: `Rerun of the ${part} of subtask ${seq} requested by user${note ? `: "${note}"` : ''}` }), { ticketId: id, subtaskId: subtask.id });
    await this.states.resume(id, 'user', `Rerun of the ${part} of subtask ${seq}${note ? `: ${note}` : ''}`.slice(0, 500));
    return toTicketDto(await this.prisma.ticket.findUniqueOrThrow({ where: { id } }));
  }
}
