/** Pure calculations behind the usage page (BUILD_PLAN v1 6.4). No database here, so they are unit-tested directly. */

export interface RunUsage {
  id: string;
  model: string;
  stage: string;
  startedAt: Date | null;
  endedAt: Date | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface Snap {
  at: Date;
  fiveHourPct: number | null;
  sevenDayPct: number | null;
  resetsAt: Date | null;
}

/** What counts toward a window: the same tokens the usage gate counts (input, output, cache write). */
export const countedTokens = (r: Pick<RunUsage, 'inputTokens' | 'outputTokens' | 'cacheWriteTokens'>): number => r.inputTokens + r.outputTokens + r.cacheWriteTokens;

type Window = 'fiveHourPct' | 'sevenDayPct';

/**
 * Splits each rise of a window's percentage between two snapshots across the runs that ended in that interval, by their
 * tokens. A fall (the window reset) attributes nothing. An interval with a rise but no run attributes nothing either:
 * the rise is not ours to blame on anyone. This is an ESTIMATE; token and cost figures are exact.
 */
export function attributeRises(snaps: Snap[], runs: RunUsage[], window: Window): Map<string, number> {
  const out = new Map<string, number>();
  const sorted = snaps.filter((s) => s[window] !== null).sort((a, b) => a.at.getTime() - b.at.getTime());
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1] as Snap;
    const cur = sorted[i] as Snap;
    const rise = (cur[window] as number) - (prev[window] as number);
    if (rise <= 0) continue;
    const inside = runs.filter((r) => {
      const t = (r.endedAt ?? r.startedAt)?.getTime();
      return t !== undefined && t > prev.at.getTime() && t <= cur.at.getTime();
    });
    const total = inside.reduce((n, r) => n + countedTokens(r), 0);
    if (inside.length === 0 || total === 0) continue;
    for (const r of inside) out.set(r.id, (out.get(r.id) ?? 0) + rise * (countedTokens(r) / total));
  }
  return out;
}

export interface ModelUsage {
  model: string;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  /** Share of all counted tokens and of all cost, 0 to 1. */
  tokenShare: number;
  costShare: number;
  byStage: { stage: string; runs: number; tokens: number; costUsd: number }[];
  perDay: { day: string; tokens: number; costUsd: number; runs: number }[];
  /** ESTIMATE: percentage points of each window this model used, and its share of the points used by all models. */
  estimate: { fiveHourPts: number; fiveHourShare: number; weeklyPts: number; weeklyShare: number };
}

const day = (d: Date): string => d.toISOString().slice(0, 10);
const round = (n: number, p = 3) => Math.round(n * 10 ** p) / 10 ** p;

export function usageByModel(runs: RunUsage[], snaps: Snap[]): ModelUsage[] {
  const five = attributeRises(snaps, runs, 'fiveHourPct');
  const week = attributeRises(snaps, runs, 'sevenDayPct');
  const byModel = new Map<string, RunUsage[]>();
  for (const r of runs) byModel.set(r.model, [...(byModel.get(r.model) ?? []), r]);
  const totalTokens = runs.reduce((n, r) => n + countedTokens(r), 0);
  const totalCost = runs.reduce((n, r) => n + r.costUsd, 0);
  const totalFive = [...five.values()].reduce((n, v) => n + v, 0);
  const totalWeek = [...week.values()].reduce((n, v) => n + v, 0);

  return [...byModel.entries()]
    .map(([model, rs]) => {
      const stages = new Map<string, { runs: number; tokens: number; costUsd: number }>();
      const days = new Map<string, { tokens: number; costUsd: number; runs: number }>();
      for (const r of rs) {
        const s = stages.get(r.stage) ?? { runs: 0, tokens: 0, costUsd: 0 };
        s.runs++;
        s.tokens += countedTokens(r);
        s.costUsd += r.costUsd;
        stages.set(r.stage, s);
        const when = r.startedAt ?? r.endedAt;
        if (when) {
          const d = days.get(day(when)) ?? { tokens: 0, costUsd: 0, runs: 0 };
          d.tokens += countedTokens(r);
          d.costUsd += r.costUsd;
          d.runs++;
          days.set(day(when), d);
        }
      }
      const tokens = rs.reduce((n, r) => n + countedTokens(r), 0);
      const cost = rs.reduce((n, r) => n + r.costUsd, 0);
      const fivePts = rs.reduce((n, r) => n + (five.get(r.id) ?? 0), 0);
      const weekPts = rs.reduce((n, r) => n + (week.get(r.id) ?? 0), 0);
      return {
        model,
        runs: rs.length,
        inputTokens: rs.reduce((n, r) => n + r.inputTokens, 0),
        outputTokens: rs.reduce((n, r) => n + r.outputTokens, 0),
        cacheReadTokens: rs.reduce((n, r) => n + r.cacheReadTokens, 0),
        cacheWriteTokens: rs.reduce((n, r) => n + r.cacheWriteTokens, 0),
        costUsd: round(cost, 4),
        tokenShare: totalTokens ? round(tokens / totalTokens) : 0,
        costShare: totalCost ? round(cost / totalCost) : 0,
        byStage: [...stages.entries()].map(([stage, v]) => ({ stage, ...v, costUsd: round(v.costUsd, 4) })).sort((a, b) => b.tokens - a.tokens),
        perDay: [...days.entries()].map(([d, v]) => ({ day: d, ...v, costUsd: round(v.costUsd, 4) })).sort((a, b) => a.day.localeCompare(b.day)),
        estimate: { fiveHourPts: round(fivePts, 2), fiveHourShare: totalFive ? round(fivePts / totalFive) : 0, weeklyPts: round(weekPts, 2), weeklyShare: totalWeek ? round(weekPts / totalWeek) : 0 },
      };
    })
    .sort((a, b) => b.costUsd - a.costUsd || b.runs - a.runs);
}

// ------------------------------------------------------------------------------------------------ rate of change

export interface RatePoint {
  at: string;
  pct: number;
  /** Percentage points per hour (5-hour window) or per day (weekly window), from the previous point of the same segment. Null for a segment's first point. */
  rate: number | null;
}
export interface RateSegment {
  /** Why this segment starts: the first one, a reset (new `resetsAt` or a fall in percentage) or a gap with no data. */
  startedBy: 'first' | 'reset' | 'gap';
  points: RatePoint[];
}
export interface RateSeries {
  unit: 'pts/hour' | 'pts/day';
  segments: RateSegment[];
  latest: { at: string; pct: number; rate: number | null } | null;
  projection: { thresholdPct: number; reachesAt: string | null; note: string } | null;
}

interface RateOptions {
  thresholdPct: number;
  now: Date;
  /** Longer than this between two snapshots is a gap: the line is broken, not drawn across. */
  gapMs: number;
  perMs: number;
  unit: RateSeries['unit'];
}

function series(snaps: Snap[], window: Window, o: RateOptions): RateSeries {
  const sorted = snaps.filter((s) => s[window] !== null).sort((a, b) => a.at.getTime() - b.at.getTime());
  const segments: RateSegment[] = [];
  let prev: Snap | null = null;
  for (const s of sorted) {
    const pct = s[window] as number;
    let startedBy: RateSegment['startedBy'] | null = null;
    if (!prev) startedBy = 'first';
    else if (pct < (prev[window] as number) || (prev.resetsAt && s.resetsAt && prev.resetsAt.getTime() !== s.resetsAt.getTime())) startedBy = 'reset';
    else if (s.at.getTime() - prev.at.getTime() > o.gapMs) startedBy = 'gap';
    if (startedBy || segments.length === 0) segments.push({ startedBy: startedBy ?? 'first', points: [] });
    const seg = segments[segments.length - 1] as RateSegment;
    const last = seg.points[seg.points.length - 1];
    const rate = last ? ((pct - last.pct) / (s.at.getTime() - Date.parse(last.at))) * o.perMs : null;
    seg.points.push({ at: s.at.toISOString(), pct, rate: rate === null ? null : round(rate, 2) });
    prev = s;
  }
  const lastSeg = segments[segments.length - 1];
  const lastPoint = lastSeg?.points[lastSeg.points.length - 1];
  const latest = lastPoint ? { at: lastPoint.at, pct: lastPoint.pct, rate: lastPoint.rate } : null;
  return { unit: o.unit, segments, latest, projection: project(latest, lastSeg, o) };
}

/** At the latest rate, when does the percentage reach the threshold? The rate is the average of the last three points of the current segment. */
function project(latest: RateSeries['latest'], seg: RateSegment | undefined, o: RateOptions): RateSeries['projection'] {
  if (!latest || !seg) return null;
  if (latest.pct >= o.thresholdPct) return { thresholdPct: o.thresholdPct, reachesAt: null, note: `Already at ${Math.round(latest.pct)}%, past the ${o.thresholdPct}% threshold` };
  const recent = seg.points.filter((p) => p.rate !== null).slice(-3);
  const rate = recent.length ? recent.reduce((n, p) => n + (p.rate as number), 0) / recent.length : null;
  if (rate === null || rate <= 0) return { thresholdPct: o.thresholdPct, reachesAt: null, note: 'Usage is not rising right now, so the threshold is not reached' };
  const ms = ((o.thresholdPct - latest.pct) / rate) * o.perMs;
  return { thresholdPct: o.thresholdPct, reachesAt: new Date(o.now.getTime() + ms).toISOString(), note: `At ${round(rate, 1)} ${o.unit} you reach ${o.thresholdPct}%` };
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export function usageRate(snaps: Snap[], thresholds: { fiveHourPct: number; weeklyPct: number }, now: Date): { fiveHour: RateSeries; weekly: RateSeries } {
  return {
    fiveHour: series(snaps, 'fiveHourPct', { thresholdPct: thresholds.fiveHourPct, now, gapMs: 90 * 60_000, perMs: HOUR, unit: 'pts/hour' }),
    weekly: series(snaps, 'sevenDayPct', { thresholdPct: thresholds.weeklyPct, now, gapMs: 48 * HOUR, perMs: DAY, unit: 'pts/day' }),
  };
}
