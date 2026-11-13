import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RateCharts, segmentRows } from './rate-charts';
import { ModelUsage } from '../model-usage';
import type { ModelUsageView, RateSeriesView, UsageRateView } from '@/lib/types';

vi.mock('recharts', async () => {
  const actual = await vi.importActual<typeof import('recharts')>('recharts');
  return { ...actual, ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div style={{ width: 400, height: 200 }}>{children}</div> };
});

const series = (over: Partial<RateSeriesView> = {}): RateSeriesView => ({
  unit: 'pts/hour',
  segments: [
    { startedBy: 'first', points: [{ at: '2026-11-14T10:00:00Z', pct: 10, rate: null }, { at: '2026-11-14T11:00:00Z', pct: 20, rate: 10 }] },
    { startedBy: 'reset', points: [{ at: '2026-11-14T15:00:00Z', pct: 4, rate: null }, { at: '2026-11-14T16:00:00Z', pct: 10, rate: 6 }] },
  ],
  latest: { at: '2026-11-14T16:00:00Z', pct: 10, rate: 6 },
  projection: { thresholdPct: 50, reachesAt: '2026-11-14T22:40:00Z', note: 'At 6 pts/hour you reach 50%' },
  ...over,
});
const rate = (over: Partial<UsageRateView> = {}): UsageRateView => ({ thresholds: { fiveHourPct: 50, weeklyPct: 80 }, fiveHour: series(), weekly: series({ unit: 'pts/day', segments: [], latest: null, projection: null }), ...over });

describe('segmentRows', () => {
  it('keeps every segment on its own key, so a reset or a gap is never joined by a line', () => {
    const { rows, keys } = segmentRows(series());
    expect(keys).toEqual(['s0', 's1']);
    expect(rows).toHaveLength(2); // the first point of a segment has no rate
    expect(rows[0]).toMatchObject({ s0: 10 });
    expect(rows[0]).not.toHaveProperty('s1');
    expect(rows[1]).toMatchObject({ s1: 6 });
    expect(rows[1]).not.toHaveProperty('s0');
  });
});

describe('RateCharts', () => {
  it('gives both charts a text alternative with the latest rate and the projection', () => {
    render(<RateCharts data={rate()} />);
    expect(screen.getByText(/rising 6 pts\/hour/)).toBeInTheDocument();
    expect(screen.getByText(/At 6 pts\/hour you reach 50%/)).toBeInTheDocument();
  });
  it('says there is not enough data when a window has no snapshots', () => {
    render(<RateCharts data={rate()} />);
    expect(screen.getByText(/Not enough snapshots yet/)).toBeInTheDocument();
  });
  it('shows the same numbers as a table on request', async () => {
    render(<RateCharts data={rate()} compact />);
    await userEvent.click(screen.getAllByRole('button', { name: 'View data' })[0] as HTMLElement);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('Rate (pts/hour)')).toBeInTheDocument();
  });
});

const models: ModelUsageView = {
  from: '2026-11-07T00:00:00Z', to: '2026-11-14T00:00:00Z', estimateNote: 'Tokens, cost and runs are exact. The share is an estimate.',
  models: [
    { model: 'opus', runs: 2, inputTokens: 3000, outputTokens: 500, cacheReadTokens: 100, cacheWriteTokens: 0, costUsd: 0.6, tokenShare: 0.6, costShare: 0.8, byStage: [{ stage: 'plan', runs: 2, tokens: 3500, costUsd: 0.6 }], perDay: [{ day: '2026-11-14', tokens: 3500, costUsd: 0.6, runs: 2 }], estimate: { fiveHourPts: 12, fiveHourShare: 0.6, weeklyPts: 3, weeklyShare: 0.5 } },
  ],
};

describe('ModelUsage', () => {
  it('shows exact figures per model and labels the window share as an estimate', () => {
    render(<ModelUsage data={models} />);
    expect(screen.getAllByText('opus').length).toBeGreaterThan(0);
    expect(screen.getByText('$0.60')).toBeInTheDocument();
    expect(screen.getByText('estimate')).toBeInTheDocument();
    expect(screen.getByText(/The share is an estimate/)).toBeInTheDocument();
    expect(screen.getByText('opus: by stage')).toBeInTheDocument();
    expect(screen.getByText(/2026-11-14/)).toBeInTheDocument();
  });
  it('says so when nothing ran', () => {
    render(<ModelUsage data={{ ...models, models: [] }} />);
    expect(screen.getByText('No stage ran in this period.')).toBeInTheDocument();
  });
});
