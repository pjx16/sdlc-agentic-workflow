/** Pure helpers for the /metrics endpoints (BUILD_PLAN 8 Metrics), kept apart from the queries so they can be tested on their own. */

export const RANGES = { '24h': 24 * 3600_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 } as const;
export type RangeName = keyof typeof RANGES;

/** `range` is `24h`, `7d` or `30d`; anything else is the default `7d`. */
export function parseRange(value: unknown, now: Date): { range: RangeName; since: Date } {
  const range: RangeName = typeof value === 'string' && Object.hasOwn(RANGES, value) ? (value as RangeName) : '7d';
  return { range, since: new Date(now.getTime() - RANGES[range]) };
}

/** Tokens count input, output and cache-write tokens (not cache reads). */
export const tokensOf = (r: { inputTokens: number; outputTokens: number; cacheWriteTokens: number }): number => r.inputTokens + r.outputTokens + r.cacheWriteTokens;

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export const mean = (values: readonly number[]): number | null => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);

export const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface TokenRun {
  startedAt: Date;
  stage: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
}

export interface TokenDay {
  day: string;
  total: number;
  /** Tokens per group (stage or model) that day. */
  groups: Record<string, number>;
}

/** Tokens per UTC day, split by stage or model. Days without runs are included (as zero) so the chart has no gaps. */
export function tokensPerDay(runs: readonly TokenRun[], groupBy: 'stage' | 'model', since: Date, now: Date): { days: TokenDay[]; keys: string[] } {
  const days = new Map<string, TokenDay>();
  const dayOf = (d: Date) => d.toISOString().slice(0, 10);
  for (let t = Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate()); t <= now.getTime(); t += 86_400_000) {
    const day = dayOf(new Date(t));
    days.set(day, { day, total: 0, groups: {} });
  }
  const totals = new Map<string, number>();
  for (const run of runs) {
    const entry = days.get(dayOf(run.startedAt));
    if (!entry) continue;
    const key = run[groupBy];
    const tokens = tokensOf(run);
    entry.groups[key] = (entry.groups[key] ?? 0) + tokens;
    entry.total += tokens;
    totals.set(key, (totals.get(key) ?? 0) + tokens);
  }
  // Groups ordered by their total, biggest first, so the stack and the legend are stable.
  const keys = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
  return { days: [...days.values()], keys };
}

export interface SubtaskRuns {
  /** Number of `fix` runs with reason `tests` for the subtask. */
  testFixRuns: number;
}

/** The share of finished subtasks that needed no tests fix round (null when there are none). */
export function firstPassRate(subtasks: readonly SubtaskRuns[]): number | null {
  if (subtasks.length === 0) return null;
  return round2(subtasks.filter((s) => s.testFixRuns === 0).length / subtasks.length);
}
