import { Injectable } from '@nestjs/common';
import { errorSourceOf, events, type ErrorCode } from '@sdlc/shared';
import { logEvent } from '../../common/event-log';
import type { FixReason, Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { RateLimit, StageUsage } from './result-parser';

export type StageRunFinalStatus = 'succeeded' | 'failed' | 'needs_input' | 'killed';

export interface NewStageRun {
  projectId: string;
  ticketId?: string;
  subtaskId?: string;
  stage: string;
  model: string;
  attempt: number;
  round: number;
  reason?: FixReason;
}

export interface FinishStageRun {
  status: StageRunFinalStatus;
  usage?: StageUsage;
  resultJson?: unknown;
  logPath?: string;
  error?: string;
  errorCode?: ErrorCode;
  retryAt?: Date;
}

/** Persistence for StageRun records, behind an interface so the runner can be unit-tested without a database. */
export interface StageRunStore {
  create(run: NewStageRun): Promise<string>;
  markRunning(id: string, containerId: string): Promise<void>;
  isKillRequested(id: string): Promise<boolean>;
  finish(id: string, result: FinishStageRun): Promise<void>;
  saveRateLimit(limit: RateLimit): Promise<void>;
  /** When the next automatic retry of a failed run is due. */
  setRetryAt(id: string, at: Date): Promise<void>;
}

export const STAGE_RUN_STORE = Symbol('STAGE_RUN_STORE');

@Injectable()
export class PrismaStageRunStore implements StageRunStore {
  constructor(private readonly prisma: PrismaService) {}

  async create(run: NewStageRun): Promise<string> {
    const row = await this.prisma.stageRun.create({
      data: {
        projectId: run.projectId,
        ticketId: run.ticketId ?? null,
        subtaskId: run.subtaskId ?? null,
        stage: run.stage,
        model: run.model,
        attempt: run.attempt,
        round: run.round,
        reason: run.reason ?? null,
        status: 'queued',
      },
    });
    await this.startedEvent(row.id, run);
    return row.id;
  }

  private async startedEvent(id: string, run: NewStageRun): Promise<void> {
    const ctx = await this.context(run.ticketId, run.subtaskId);
    await logEvent(this.prisma, events.stageStarted({ stage: run.stage, ticketKey: ctx.ticketKey, subtask: ctx.seq, subtasks: ctx.of, model: run.model, attempt: run.attempt }), { ticketId: run.ticketId, stageRunId: id, subtaskId: run.subtaskId });
  }

  /** The ticket key and "subtask n of m", for the one-line event messages. */
  private async context(ticketId?: string | null, subtaskId?: string | null): Promise<{ ticketKey?: string; seq?: number; of?: number }> {
    if (!ticketId) return {};
    const ticket = await this.prisma.ticket.findUnique({ where: { id: ticketId }, select: { key: true } });
    if (!subtaskId) return { ticketKey: ticket?.key };
    const subtask = await this.prisma.subtask.findUnique({ where: { id: subtaskId }, select: { seq: true } });
    return { ticketKey: ticket?.key, seq: subtask?.seq, of: await this.prisma.subtask.count({ where: { ticketId } }) };
  }

  async markRunning(id: string, containerId: string): Promise<void> {
    await this.prisma.stageRun.update({ where: { id }, data: { status: 'running', startedAt: new Date(), containerId } });
  }

  async isKillRequested(id: string): Promise<boolean> {
    const row = await this.prisma.stageRun.findUnique({ where: { id }, select: { killRequested: true } });
    return row?.killRequested ?? false;
  }

  async finish(id: string, r: FinishStageRun): Promise<void> {
    await this.prisma.stageRun.update({
      where: { id },
      data: {
        status: r.status,
        endedAt: new Date(),
        error: r.error ?? null,
        errorCode: r.errorCode ?? null,
        errorSource: r.errorCode ? errorSourceOf(r.errorCode) : null,
        retryAt: r.retryAt ?? null,
        logPath: r.logPath ?? null,
        resultJson: r.resultJson === undefined ? undefined : (r.resultJson as Prisma.InputJsonValue),
        ...(r.usage
          ? {
              inputTokens: r.usage.inputTokens,
              outputTokens: r.usage.outputTokens,
              cacheReadTokens: r.usage.cacheReadTokens,
              cacheWriteTokens: r.usage.cacheWriteTokens,
              costUsd: r.usage.costUsd,
              numTurns: r.usage.numTurns,
              sessionId: r.usage.sessionId,
              cliVersion: r.usage.cliVersion,
            }
          : {}),
      },
    });
    await this.finishedEvents(id, r);
  }

  private async finishedEvents(id: string, r: FinishStageRun): Promise<void> {
    const run = await this.prisma.stageRun.findUnique({ where: { id } });
    if (!run) return;
    const ctx = await this.context(run.ticketId, run.subtaskId);
    const durationMs = run.startedAt && run.endedAt ? run.endedAt.getTime() - run.startedAt.getTime() : 0;
    const where = { ticketId: run.ticketId, stageRunId: id, subtaskId: run.subtaskId };
    await logEvent(this.prisma, events.stageFinished({ stage: run.stage, status: r.status, subtask: ctx.seq, subtasks: ctx.of, durationMs, turns: run.numTurns, costUsd: Number(run.costUsd) }), where);
    // A Claude API error that will be retried gets its event (with the retry time) from setRetryAt.
    if (r.status === 'failed' && r.errorCode && !(r.errorCode === 'CLAUDE_API_ERROR' && run.attempt <= 3)) {
      await logEvent(this.prisma, events.error({ code: r.errorCode, vars: { detail: (r.error ?? '').slice(0, 120), agent: run.stage, stage: run.stage, question: r.error ?? '', reason: r.error ?? '' } }), where);
    }
  }
  async setRetryAt(id: string, at: Date): Promise<void> {
    const run = await this.prisma.stageRun.update({ where: { id }, data: { retryAt: at } });
    // "Claude API error (529). Retry 1/3 at 14:32." (BUILD_PLAN v1 6.4)
    if (run.errorCode === 'CLAUDE_API_ERROR') {
      await logEvent(this.prisma, events.error({ code: 'CLAUDE_API_ERROR', vars: { detail: (run.error ?? '').slice(0, 80) }, retry: { n: run.attempt, of: 3 }, retryAt: at }), { ticketId: run.ticketId, stageRunId: id });
    }
  }

  /** Keeps the latest rate_limit_event for the usage gate (milestone 10). */
  async saveRateLimit(limit: RateLimit): Promise<void> {
    await this.prisma.usageSnapshot.create({
      data: { fiveHourPct: limit.fiveHourPct, sevenDayPct: limit.sevenDayPct, status: limit.status, resetsAt: limit.resetsAt, source: 'event' },
    });
  }
}
