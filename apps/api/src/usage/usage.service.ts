import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { usageByModel, usageRate, type ModelUsage, type RateSeries } from './usage-analytics';

export interface UsageSnapshotDto {
  id: string;
  at: string;
  fiveHourPct: number | null;
  sevenDayPct: number | null;
  status: string | null;
  resetsAt: string | null;
  source: string;
  windowTokens: number;
}

export interface UsageSummaryDto {
  /** Tokens (input + output + cache write) per stage and model, most first. */
  tokens: { stage: string; model: string; tokens: number; runs: number }[];
  /** `windowTokens` at the last `rejected` snapshot: a good `calibratedWindowTokens` (BUILD_PLAN 6.7). Null if there was none. */
  suggestedCalibration: number | null;
}

const MAX_ROWS = 2000;

const parseDate = (v?: string): Date | undefined => {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

@Injectable()
export class UsageService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /usage/snapshots: oldest first, optionally limited to `from` and `to` (ISO dates). */
  async snapshots(query: { from?: string; to?: string }): Promise<UsageSnapshotDto[]> {
    const from = parseDate(query.from);
    const to = parseDate(query.to);
    const rows = await this.prisma.usageSnapshot.findMany({
      where: from || to ? { at: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {},
      orderBy: { at: 'desc' },
      take: MAX_ROWS,
    });
    return rows.reverse().map((r) => ({ id: r.id, at: r.at.toISOString(), fiveHourPct: r.fiveHourPct, sevenDayPct: r.sevenDayPct, status: r.status, resetsAt: r.resetsAt?.toISOString() ?? null, source: r.source, windowTokens: r.windowTokens }));
  }

  /** GET /usage/models: tokens by kind, cost, runs and share per model, the split by stage and day, and the estimated share of each window (BUILD_PLAN v1 6.4). */
  async models(query: { from?: string; to?: string }): Promise<{ from: string; to: string; models: ModelUsage[]; estimateNote: string }> {
    const to = parseDate(query.to) ?? new Date();
    const from = parseDate(query.from) ?? new Date(to.getTime() - 7 * 86_400_000);
    const [runs, snaps] = await Promise.all([
      this.prisma.stageRun.findMany({ where: { startedAt: { gte: from, lte: to } } }),
      // One snapshot before the period, so the first rise inside it has something to start from.
      this.snapshotsAround(from, to),
    ]);
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      models: usageByModel(runs.map((r) => ({ ...r, costUsd: Number(r.costUsd) })), snaps),
      estimateNote: 'Tokens, cost and runs are exact. The share of the 5-hour and weekly percentage is an estimate: each rise between two snapshots is split across the runs in that interval by their tokens.',
    };
  }

  /** GET /usage/rate: how fast the 5-hour (points per hour) and weekly (points per day) percentages rise, with a projection to the thresholds. */
  async rate(query: { from?: string; to?: string }): Promise<{ thresholds: { fiveHourPct: number; weeklyPct: number }; fiveHour: RateSeries; weekly: RateSeries }> {
    const to = parseDate(query.to) ?? new Date();
    const from = parseDate(query.from) ?? new Date(to.getTime() - 7 * 86_400_000);
    const settings = await this.prisma.globalSettings.findUnique({ where: { id: 'global' } });
    const thresholds = { fiveHourPct: settings?.usageThresholdPct ?? 50, weeklyPct: settings?.usageThresholdWeeklyPct ?? 80 };
    return { thresholds, ...usageRate(await this.snapshotsAround(from, to), thresholds, new Date()) };
  }

  private async snapshotsAround(from: Date, to: Date) {
    const inside = await this.prisma.usageSnapshot.findMany({ where: { at: { gte: from, lte: to } }, orderBy: { at: 'asc' }, take: MAX_ROWS });
    const before = await this.prisma.usageSnapshot.findFirst({ where: { at: { lt: from } }, orderBy: { at: 'desc' } });
    return (before ? [before, ...inside] : inside).map((s) => ({ at: s.at, fiveHourPct: s.fiveHourPct, sevenDayPct: s.sevenDayPct, resetsAt: s.resetsAt }));
  }

  /** GET /usage/summary: tokens by stage and model over the last 30 days, and the suggested calibration. */
  async summary(): Promise<UsageSummaryDto> {
    const since = new Date(Date.now() - 30 * 86_400_000);
    const groups = await this.prisma.stageRun.groupBy({
      by: ['stage', 'model'],
      where: { startedAt: { gte: since } },
      _sum: { inputTokens: true, outputTokens: true, cacheWriteTokens: true },
      _count: true,
    });
    const tokens = groups
      .map((g) => ({ stage: g.stage, model: g.model, tokens: (g._sum.inputTokens ?? 0) + (g._sum.outputTokens ?? 0) + (g._sum.cacheWriteTokens ?? 0), runs: g._count }))
      .sort((a, b) => b.tokens - a.tokens);
    const rejected = await this.prisma.usageSnapshot.findFirst({ where: { status: 'rejected', windowTokens: { gt: 0 } }, orderBy: { at: 'desc' } });
    return { tokens, suggestedCalibration: rejected?.windowTokens ?? null };
  }
}
