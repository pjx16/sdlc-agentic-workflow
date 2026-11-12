import { describe, expect, it } from 'vitest';
import { firstPassRate, mergedPerDay, mean, median, parseRange, tokensOf, tokensPerDay } from './aggregate';

const NOW = new Date('2026-11-12T12:00:00Z');
const run = (day: string, stage: string, model: string, input: number, output = 0, cacheWrite = 0) => ({ startedAt: new Date(`${day}T10:00:00Z`), stage, model, inputTokens: input, outputTokens: output, cacheWriteTokens: cacheWrite });

describe('parseRange', () => {
  it('knows 24h, 7d and 30d, and defaults to 7d', () => {
    expect(parseRange('24h', NOW)).toEqual({ range: '24h', since: new Date('2026-11-11T12:00:00Z') });
    expect(parseRange('30d', NOW).since).toEqual(new Date('2026-10-13T12:00:00Z'));
    for (const bad of [undefined, '', '1y', 7, 'constructor']) expect(parseRange(bad, NOW).range).toBe('7d');
  });
});

describe('tokensOf', () => {
  it('is input plus output plus cache-write', () => expect(tokensOf({ inputTokens: 1, outputTokens: 2, cacheWriteTokens: 4 })).toBe(7));
});

describe('median and mean', () => {
  it('handles odd, even and empty lists', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(mean([1, 2, 6])).toBe(3);
    expect(mean([])).toBeNull();
  });
});

describe('tokensPerDay', () => {
  const since = new Date('2026-11-10T12:00:00Z');
  it('groups by stage per UTC day, includes empty days, and orders the keys by total', () => {
    const { days, keys } = tokensPerDay([run('2026-11-10', 'plan', 'opus', 100, 50), run('2026-11-10', 'implement', 'haiku', 10), run('2026-11-12', 'plan', 'opus', 1, 1, 1)], 'stage', since, NOW);
    expect(days.map((d) => d.day)).toEqual(['2026-11-10', '2026-11-11', '2026-11-12']);
    expect(days[0]).toEqual({ day: '2026-11-10', total: 160, groups: { plan: 150, implement: 10 } });
    expect(days[1]).toEqual({ day: '2026-11-11', total: 0, groups: {} });
    expect(days[2]?.total).toBe(3);
    expect(keys).toEqual(['plan', 'implement']);
  });
  it('groups by model', () => {
    const { days, keys } = tokensPerDay([run('2026-11-11', 'plan', 'opus', 5), run('2026-11-11', 'implement', 'opus', 5), run('2026-11-11', 'tests', 'sonnet', 1)], 'model', since, NOW);
    expect(days[1]?.groups).toEqual({ opus: 10, sonnet: 1 });
    expect(keys).toEqual(['opus', 'sonnet']);
  });
  it('an empty range gives days of zero and no keys; runs outside the days are ignored', () => {
    const empty = tokensPerDay([], 'stage', since, NOW);
    expect(empty.keys).toEqual([]);
    expect(empty.days.every((d) => d.total === 0)).toBe(true);
    expect(tokensPerDay([run('2026-01-01', 'plan', 'opus', 5)], 'stage', since, NOW).keys).toEqual([]);
  });
});

describe('firstPassRate', () => {
  it('is the share of subtasks with no tests fix run, and null for none', () => {
    expect(firstPassRate([{ testFixRuns: 0 }, { testFixRuns: 2 }, { testFixRuns: 0 }, { testFixRuns: 1 }])).toBe(0.5);
    expect(firstPassRate([{ testFixRuns: 0 }])).toBe(1);
    expect(firstPassRate([])).toBeNull();
  });
});

describe('mergedPerDay', () => {
  const since = new Date('2026-11-10T08:00:00Z');
  const NOW2 = new Date('2026-11-12T12:00:00Z');
  const m = (at: string, a: number | null, d: number | null) => ({ mergedAt: new Date(at), prAdditions: a, prDeletions: d });
  it('counts merged PRs and sums lines per UTC day, with empty days as zero', () => {
    const { days, totals } = mergedPerDay([m('2026-11-10T23:00:00Z', 100, 20), m('2026-11-10T01:00:00Z', 5, 1), m('2026-11-12T00:30:00Z', 7, 7)], since, NOW2);
    expect(days).toEqual([
      { day: '2026-11-10', merged: 2, additions: 105, deletions: 21 },
      { day: '2026-11-11', merged: 0, additions: 0, deletions: 0 },
      { day: '2026-11-12', merged: 1, additions: 7, deletions: 7 },
    ]);
    expect(totals).toEqual({ merged: 3, additions: 112, deletions: 28, withoutLineData: 0 });
  });
  it('a PR with no line counts still counts as merged, and is reported', () => {
    const { days, totals } = mergedPerDay([m('2026-11-11T10:00:00Z', null, null)], since, NOW2);
    expect(days[1]).toEqual({ day: '2026-11-11', merged: 1, additions: 0, deletions: 0 });
    expect(totals).toEqual({ merged: 1, additions: 0, deletions: 0, withoutLineData: 1 });
  });
  it('ignores merges outside the days of the range', () => {
    expect(mergedPerDay([m('2026-01-01T00:00:00Z', 9, 9)], since, NOW2).totals.merged).toBe(0);
  });
});
