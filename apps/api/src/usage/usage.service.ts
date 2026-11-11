import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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
