import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ActivityCard, NumberCards, QueueList, RangeSwitch } from '../overview-parts';
import { QualityPanel } from '../quality-panel';
import type { MetricsQuality, MetricsTokens, MetricsUsage, SystemView, TicketListItem } from '@/lib/types';
import { BarListChart } from './bar-list-chart';
import { ChartFrame } from './chart-frame';
import { TokensChart } from './tokens-chart';
import { UsageChart } from './usage-chart';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const usage: MetricsUsage = {
  range: '7d', thresholdPct: 50, thresholdWeeklyPct: 80,
  series: [{ at: '2026-11-12T10:00:00Z', fiveHourPct: 20.04, sevenDayPct: 5, status: 'allowed' }, { at: '2026-11-12T11:00:00Z', fiveHourPct: 55, sevenDayPct: null, status: 'allowed_warning' }],
  pauses: [{ at: '2026-11-12T11:00:00Z', message: 'Pipeline paused: 5-hour usage is at 55%' }],
};
const tokens: MetricsTokens = {
  range: '7d', groupBy: 'stage', keys: ['plan', 'implement'],
  days: [{ day: '2026-11-11', total: 0, groups: {} }, { day: '2026-11-12', total: 1500, groups: { plan: 1000, implement: 500 } }],
};

describe('ChartFrame', () => {
  it('shows the empty state with no toggle', () => {
    render(<ChartFrame title="T" summary="S" empty emptyText="Nothing here" table={{ columns: ['A'], rows: [] }}><div>chart</div></ChartFrame>);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText('chart')).not.toBeInTheDocument();
  });
  it('has an accessible text label and switches between the chart and its data', async () => {
    render(<ChartFrame title="Tokens" summary="Per day." empty={false} emptyText="" table={{ columns: ['Day', 'Total'], rows: [['2026-11-12', 1500], ['2026-11-11', null]] }}><div>chart</div></ChartFrame>);
    expect(screen.getByRole('img', { name: 'Tokens. Per day.' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'View data' }));
    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Total' })).toBeInTheDocument();
    expect(within(table).getByText('1500')).toBeInTheDocument();
    expect(within(table).getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('chart')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'View chart' }));
    expect(screen.getByText('chart')).toBeInTheDocument();
  });
});

describe('UsageChart', () => {
  it('describes the chart in text and lists the same numbers as a table', async () => {
    render(<UsageChart data={usage} />);
    expect(screen.getByText(/pause threshold; latest 55%\. 1 pause/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'View data' }));
    expect(screen.getByText('20')).toBeInTheDocument();
    expect(screen.getByText('allowed_warning')).toBeInTheDocument();
  });
  it('has a clear empty state', () => {
    render(<UsageChart data={{ ...usage, series: [], pauses: [] }} />);
    expect(screen.getByText(/No usage recorded in this range/)).toBeInTheDocument();
  });
});

describe('TokensChart', () => {
  it('names the grouping, offers the other one as a link, and shows the data', async () => {
    render(<TokensChart data={tokens} />);
    expect(screen.getByText('Tokens by stage')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'By model' })).toHaveAttribute('href', '/?range=7d&groupBy=model');
    expect(screen.getByRole('link', { name: 'By stage' })).toHaveAttribute('aria-current', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'View data' }));
    expect(screen.getByRole('columnheader', { name: 'implement' })).toBeInTheDocument();
    expect(screen.getByText('1500')).toBeInTheDocument();
  });
  it('is empty when no tokens were used, even though the days exist', () => {
    render(<TokensChart data={{ ...tokens, keys: [], days: [{ day: '2026-11-12', total: 0, groups: {} }] }} />);
    expect(screen.getByText('No tokens used in this range.')).toBeInTheDocument();
  });
});

describe('BarListChart', () => {
  it('empty when there are no rows or every value is zero', () => {
    const { rerender } = render(<BarListChart title="States" summary="s" emptyText="No tickets yet." valueLabel="Tickets" rows={[]} />);
    expect(screen.getByText('No tickets yet.')).toBeInTheDocument();
    rerender(<BarListChart title="States" summary="s" emptyText="No tickets yet." valueLabel="Tickets" rows={[{ name: 'New', value: 0 }]} />);
    expect(screen.getByText('No tickets yet.')).toBeInTheDocument();
  });
  it('formats values in the data table', async () => {
    render(<BarListChart title="Durations" summary="s" emptyText="x" valueLabel="Median" unit="duration" rows={[{ name: 'plan', value: 20 }]} />);
    await userEvent.click(screen.getByRole('button', { name: 'View data' }));
    expect(screen.getByText('20s')).toBeInTheDocument();
  });
});

describe('QualityPanel', () => {
  it('shows the three numbers and findings by severity', async () => {
    const data: MetricsQuality = { range: '7d', firstPassRate: 0.75, avgFixRounds: 1.5, avgReviewRounds: null, findingsBySeverity: [{ severity: 'high', count: 2 }, { severity: 'low', count: 0 }] };
    render(<QualityPanel data={data} />);
    expect(screen.getByText('75%')).toBeInTheDocument();
    expect(screen.getByText('1.5')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'View data' }));
    expect(screen.getByText('high')).toBeInTheDocument();
  });
  it('has an empty state for the findings', () => {
    render(<QualityPanel data={{ range: '7d', firstPassRate: null, avgFixRounds: null, avgReviewRounds: null, findingsBySeverity: [{ severity: 'high', count: 0 }] }} />);
    expect(screen.getByText('No review findings in this range.')).toBeInTheDocument();
  });
});

describe('Overview parts', () => {
  it('number cards show the four numbers', () => {
    render(<NumberCards summary={{ range: '7d', ticketsDone: 3, firstPassRate: 0.5, tokensInWindow: 12345, queueLength: 2 }} />);
    expect(screen.getByText('Tickets done (7d)')).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByText('12,345')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });
  it('a missing first-pass rate is a dash', () => {
    render(<NumberCards summary={{ range: '24h', ticketsDone: 0, firstPassRate: null, tokensInWindow: 0, queueLength: 0 }} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
  it('the range switch marks the current range', () => {
    render(<RangeSwitch range="30d" hrefFor={(r) => `/?range=${r}`} />);
    expect(screen.getByRole('link', { name: '30d' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('link', { name: '24h' })).toHaveAttribute('href', '/?range=24h');
  });
  it('the activity card shows the running stage with elapsed time, idle, or paused', () => {
    const base = { settings: { pipelinePaused: false, pausedReason: null }, usage: null } as unknown as SystemView;
    const now = Date.parse('2026-11-12T10:02:05Z');
    const { rerender } = render(<ActivityCard system={{ ...base, runningStage: { id: 'r1', stage: 'implement', model: 'haiku', projectId: 'p', ticketId: 't1', startedAt: '2026-11-12T10:00:00Z' } }} now={now} />);
    expect(screen.getByText(/implement/)).toBeInTheDocument();
    expect(screen.getByText(/2m 5s/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Watch the log' })).toHaveAttribute('href', '/runs/r1');
    rerender(<ActivityCard system={{ ...base, runningStage: null }} now={now} />);
    expect(screen.getByText(/Idle/)).toBeInTheDocument();
    rerender(<ActivityCard system={{ ...base, settings: { ...base.settings, pipelinePaused: true, pausedReason: 'manual' }, runningStage: null }} now={now} />);
    expect(screen.getByText(/Paused by you/)).toBeInTheDocument();
  });
  it('the queue lists tickets or says there are none', () => {
    const t = { id: 't1', key: 'ABC-1', title: 'Export', status: 'PLANNING', updatedAt: '2026-11-12T10:00:00Z' } as TicketListItem;
    const { rerender } = render(<QueueList tickets={[t]} />);
    expect(screen.getByRole('link', { name: /ABC-1 Export/ })).toHaveAttribute('href', '/tickets/t1');
    rerender(<QueueList tickets={[]} />);
    expect(screen.getByText(/No ticket is waiting/)).toBeInTheDocument();
  });
});
