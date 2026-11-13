import { Injectable } from '@nestjs/common';
import { errorSourceOf, type ErrorCode } from '@sdlc/shared';
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
    return row.id;
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
  }

  async setRetryAt(id: string, at: Date): Promise<void> {
    await this.prisma.stageRun.update({ where: { id }, data: { retryAt: at } });
  }

  /** Keeps the latest rate_limit_event for the usage gate (milestone 10). */
  async saveRateLimit(limit: RateLimit): Promise<void> {
    await this.prisma.usageSnapshot.create({
      data: { fiveHourPct: limit.fiveHourPct, sevenDayPct: limit.sevenDayPct, status: limit.status, resetsAt: limit.resetsAt, source: 'event' },
    });
  }
}
