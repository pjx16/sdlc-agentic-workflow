import { describe, expect, it } from 'vitest';
import { attributeRises, usageByModel, usageRate, type RunUsage, type Snap } from './usage-analytics';

const t = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 14, h, m));
const snap = (at: Date, five: number | null, week: number | null = null, resetsAt: Date | null = null): Snap => ({ at, fiveHourPct: five, sevenDayPct: week, resetsAt });
const run = (id: string, model: string, stage: string, end: Date, tokens: number, cost = 0.1): RunUsage => ({
  id, model, stage, startedAt: new Date(end.getTime() - 60_000), endedAt: end, inputTokens: tokens, outputTokens: 0, cacheReadTokens: 999, cacheWriteTokens: 0, costUsd: cost,
});

describe('attributeRises', () => {
  it('splits a rise between two snapshots across the runs that ended in it, by tokens', () => {
    const snaps = [snap(t(10), 10), snap(t(11), 30)];
    const runs = [run('a', 'opus', 'plan', t(10, 20), 3000), run('b', 'sonnet', 'implement', t(10, 40), 1000), run('c', 'sonnet', 'fix', t(12), 5000)];
    const r = attributeRises(snaps, runs, 'fiveHourPct');
    expect(r.get('a')).toBeCloseTo(15);
    expect(r.get('b')).toBeCloseTo(5);
    expect(r.has('c')).toBe(false);
  });
  it('attributes nothing for a fall (a reset) or when no run ended in the interval', () => {
    expect(attributeRises([snap(t(10), 80), snap(t(11), 5)], [run('a', 'x', 'plan', t(10, 30), 100)], 'fiveHourPct').size).toBe(0);
    expect(attributeRises([snap(t(10), 10), snap(t(11), 30)], [], 'fiveHourPct').size).toBe(0);
  });
  it('skips snapshots without a figure and works for the weekly window', () => {
    const r = attributeRises([snap(t(10), null, 10), snap(t(11), null, 14)], [run('a', 'x', 'plan', t(10, 30), 100)], 'sevenDayPct');
    expect(r.get('a')).toBeCloseTo(4);
  });
});

describe('usageByModel', () => {
  const runs = [run('a', 'opus', 'plan', t(10, 20), 3000, 0.6), run('b', 'sonnet', 'implement', t(10, 40), 1000, 0.1), run('c', 'sonnet', 'fix', t(10, 50), 1000, 0.1)];
  const snaps = [snap(t(10), 10, 20), snap(t(11), 30, 25)];

  it('gives exact tokens, cost, runs and shares per model, biggest spender first', () => {
    const m = usageByModel(runs, snaps);
    expect(m.map((x) => x.model)).toEqual(['opus', 'sonnet']);
    expect(m[0]).toMatchObject({ model: 'opus', runs: 1, inputTokens: 3000, cacheReadTokens: 999, costUsd: 0.6 });
    expect(m[0]?.tokenShare).toBeCloseTo(0.6);
    expect(m[1]?.costShare).toBeCloseTo(0.25);
  });
  it('splits each model by stage and by day', () => {
    const sonnet = usageByModel(runs, snaps)[1];
    expect(sonnet?.byStage.map((s) => s.stage).sort()).toEqual(['fix', 'implement']);
    expect(sonnet?.perDay).toEqual([{ day: '2026-11-14', tokens: 2000, costUsd: 0.2, runs: 2 }]);
  });
  it('estimates the share of the 5-hour and weekly percentage each model used', () => {
    const [opus, sonnet] = usageByModel(runs, snaps);
    expect(opus?.estimate).toMatchObject({ fiveHourPts: 12, fiveHourShare: 0.6, weeklyPts: 3, weeklyShare: 0.6 });
    expect(sonnet?.estimate.fiveHourPts).toBeCloseTo(8);
    expect((opus?.estimate.fiveHourShare ?? 0) + (sonnet?.estimate.fiveHourShare ?? 0)).toBeCloseTo(1);
  });
  it('is empty without runs', () => expect(usageByModel([], snaps)).toEqual([]));
});

describe('usageRate', () => {
  const th = { fiveHourPct: 50, weeklyPct: 80 };
  it('measures percentage points per hour inside a segment', () => {
    const r = usageRate([snap(t(10), 10), snap(t(11), 20), snap(t(12), 35)], th, t(12, 30));
    expect(r.fiveHour.unit).toBe('pts/hour');
    expect(r.fiveHour.segments).toHaveLength(1);
    expect(r.fiveHour.segments[0]?.points.map((p) => p.rate)).toEqual([null, 10, 15]);
    expect(r.fiveHour.latest).toMatchObject({ pct: 35, rate: 15 });
  });
  it('splits at a reset, so a reset never shows as a fall', () => {
    const resetA = t(15);
    const resetB = t(20);
    const r = usageRate([snap(t(10), 40, null, resetA), snap(t(11), 50, null, resetA), snap(t(15, 30), 4, null, resetB), snap(t(16), 10, null, resetB)], th, t(16, 10));
    expect(r.fiveHour.segments.map((s) => s.startedBy)).toEqual(['first', 'reset']);
    expect(r.fiveHour.segments[1]?.points[0]?.rate).toBeNull();
    expect(r.fiveHour.segments[1]?.points[1]?.rate).toBe(12);
    const fall = usageRate([snap(t(10), 60), snap(t(11), 5)], th, t(11));
    expect(fall.fiveHour.segments.map((s) => s.startedBy)).toEqual(['first', 'reset']);
  });
  it('keeps a gap as a gap: the line is broken, nothing is interpolated', () => {
    const r = usageRate([snap(t(10), 10), snap(t(10, 30), 15), snap(t(15), 25)], th, t(15, 5));
    expect(r.fiveHour.segments.map((s) => s.startedBy)).toEqual(['first', 'gap']);
    expect(r.fiveHour.segments[1]?.points).toHaveLength(1);
  });
  it('projects when the threshold is reached at the latest rate', () => {
    const r = usageRate([snap(t(10), 10), snap(t(11), 20), snap(t(12), 30)], th, t(12));
    expect(r.fiveHour.projection).toMatchObject({ thresholdPct: 50, reachesAt: t(14).toISOString() });
    expect(r.fiveHour.projection?.note).toBe('At 10 pts/hour you reach 50%');
  });
  it('says so when usage is flat, or already past the threshold', () => {
    expect(usageRate([snap(t(10), 20), snap(t(11), 20)], th, t(11)).fiveHour.projection).toMatchObject({ reachesAt: null, note: expect.stringContaining('not rising') });
    expect(usageRate([snap(t(10), 55), snap(t(11), 60)], th, t(11)).fiveHour.projection).toMatchObject({ reachesAt: null, note: expect.stringContaining('past the 50% threshold') });
  });
  it('does the weekly window in points per day, with its own gap rule', () => {
    const day = (d: number, h = 0) => new Date(Date.UTC(2026, 10, d, h));
    const r = usageRate([snap(day(10), null, 10), snap(day(11), null, 16), snap(day(12), null, 22)], th, day(12, 6));
    expect(r.weekly.unit).toBe('pts/day');
    expect(r.weekly.latest).toMatchObject({ pct: 22, rate: 6 });
    expect(r.weekly.projection?.reachesAt).toBe(new Date(Date.UTC(2026, 10, 12, 6) + (58 / 6) * 86_400_000).toISOString());
    expect(r.fiveHour.segments).toEqual([]);
    expect(r.fiveHour.projection).toBeNull();
  });
});
