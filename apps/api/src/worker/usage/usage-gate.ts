import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { RateLimit } from '../agent-runner/result-parser';
import { evaluateUsage } from './usage-rules';

export const USAGE_GATE = Symbol('USAGE_GATE');

const FIVE_HOURS_MS = 5 * 3600_000;

export interface UsageGatePort {
  afterStage(args: { limit: RateLimit | null; rateLimitError?: boolean; stageRunId?: string; ownTokens?: number }): Promise<void>;
}

/**
 * After every AI stage run, however it ended (F14, v1 6.2): stores a UsageSnapshot and evaluates the gate. On a pause it sets `pipelinePaused`, `pausedReason` and
 * `resetsAt` and writes the audit log; the pipeline never resumes by itself.
 */
@Injectable()
export class UsageGate implements UsageGatePort {
  private readonly logger = new Logger(UsageGate.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Input, output and cache-write tokens of the stage runs started in the last 5 hours, plus the run that just ended. */
  async windowTokens(ownTokens = 0): Promise<number> {
    const since = new Date(this.now().getTime() - FIVE_HOURS_MS);
    const sum = await this.prisma.stageRun.aggregate({ where: { startedAt: { gte: since } }, _sum: { inputTokens: true, outputTokens: true, cacheWriteTokens: true } });
    return (sum._sum.inputTokens ?? 0) + (sum._sum.outputTokens ?? 0) + (sum._sum.cacheWriteTokens ?? 0) + ownTokens;
  }

  async afterStage(args: { limit: RateLimit | null; rateLimitError?: boolean; stageRunId?: string; ownTokens?: number }): Promise<void> {
    const row = await this.prisma.globalSettings.upsert({ where: { id: 'global' }, update: {}, create: { id: 'global' } });
    const decision = evaluateUsage({
      limit: args.limit,
      rateLimitError: args.rateLimitError,
      windowTokens: await this.windowTokens(args.ownTokens),
      calibratedWindowTokens: row.calibratedWindowTokens === null ? null : Number(row.calibratedWindowTokens),
      thresholdPct: row.usageThresholdPct,
      thresholdWeeklyPct: row.usageThresholdWeeklyPct,
      ignoredUntil: row.usageIgnoredUntil,
      now: this.now(),
    });
    const s = decision.snapshot;
    // Every run that ends leaves one snapshot (BUILD_PLAN v1 6.2). With no event and no calibration the percentages stay empty.
    const run = args.stageRunId ? await this.prisma.stageRun.findUnique({ where: { id: args.stageRunId }, select: { model: true } }) : null;
    await this.prisma.usageSnapshot.create({
      data: {
        at: this.now(), fiveHourPct: s.fiveHourPct, sevenDayPct: s.sevenDayPct, status: s.status, resetsAt: s.resetsAt, source: s.source, windowTokens: s.windowTokens,
        stageRunId: args.stageRunId ?? null, model: run?.model ?? null, windows: (s.windows ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
    if (!decision.pause) return;
    this.logger.warn(`Pipeline paused: ${decision.reason}`);
    if (!row.pipelinePaused) {
      await this.prisma.globalSettings.update({ where: { id: 'global' }, data: { pipelinePaused: true, pausedReason: decision.reason.slice(0, 300), pausedCode: s.status === 'rejected' ? 'CLAUDE_USAGE_LIMIT' : null, resetsAt: decision.resetsAt } });
      await this.prisma.event.create({ data: { type: 'usage', message: `Pipeline paused: ${decision.reason}`.slice(0, 500) } });
    }
  }
}
