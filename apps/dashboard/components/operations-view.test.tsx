import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OperationsPage } from './operations-view';
import type { OperationsView } from '@/lib/types';

const data = (over: Partial<OperationsView> = {}): OperationsView => ({
  worker: { state: 'busy', phase: 'stage', phaseDetail: 'implement on SDA-12', phaseSince: null, uptimeSec: 5400, restarts24h: 1, queueDepth: 2 },
  stuck: [{ id: 't1', key: 'SDA-3', status: 'IN_PROGRESS', since: '2026-11-14T10:00:00Z', minutes: 50, why: 'Ready for the worker for 50 minutes, but nothing is running' }],
  failures: {
    last24h: { byStage: [{ stage: 'implement', runs: 4, failed: 3, rate: 0.75, byCode: { TIMEOUT: 2, CLAUDE_API_ERROR: 1 } }], byCode: [{ code: 'TIMEOUT', count: 2 }] },
    last7d: { byStage: [], byCode: [] },
  },
  load: [{ stage: 'fix', runs: 5, retries: 1, loops: 4, avgDurationSec: 185, avgTokens: 12000, avgCostUsd: 0.214 }],
  integrations: [{ source: 'claude', total: 10, errors: 3, rate: 0.3 }, { source: 'jira', total: 0, errors: 0, rate: 0 }],
  recentErrors: [{ id: 'e1', at: '2026-11-14T10:00:00Z', source: 'claude', message: 'Claude API error (529).', errorCode: 'CLAUDE_API_ERROR', ticketId: 't1', ticketKey: 'SDA-3' }],
  ...over,
});

describe('OperationsPage', () => {
  it('shows the worker state with its phase, uptime and queue', () => {
    render(<OperationsPage data={data()} />);
    expect(screen.getByText('Online, busy')).toBeInTheDocument();
    expect(screen.getByText('stage: implement on SDA-12')).toBeInTheDocument();
    expect(screen.getByText('1 h 30 min')).toBeInTheDocument();
  });
  it('says offline in red, stalled in amber, and never reported', () => {
    const { rerender } = render(<OperationsPage data={data({ worker: { ...data().worker, state: 'offline' } })} />);
    expect(screen.getByText('Offline')).toHaveClass('text-red');
    rerender(<OperationsPage data={data({ worker: { ...data().worker, state: 'stalled' } })} />);
    expect(screen.getByText(/Stalled/)).toHaveClass('text-amber');
    rerender(<OperationsPage data={data({ worker: { ...data().worker, state: 'unknown' } })} />);
    expect(screen.getByText('Has not reported yet')).toBeInTheDocument();
  });
  it('links each stuck ticket and says why it is stuck', () => {
    render(<OperationsPage data={data()} />);
    expect(screen.getAllByRole('link', { name: 'SDA-3' }).some((l) => l.getAttribute('href') === '/tickets/t1')).toBe(true);
    expect(screen.getByText(/nothing is running/)).toBeInTheDocument();
  });
  it('shows failure rates with their codes, and load figures', () => {
    render(<OperationsPage data={data()} />);
    expect(screen.getByText('75%')).toBeInTheDocument();
    expect(screen.getByText('TIMEOUT ×2, CLAUDE_API_ERROR ×1')).toBeInTheDocument();
    expect(screen.getByText('3m 5s')).toBeInTheDocument();
    expect(screen.getByText('$0.21')).toBeInTheDocument();
  });
  it('lists recent errors with a link to the ticket timeline and the suggested action', () => {
    render(<OperationsPage data={data()} />);
    expect(screen.getByText(/After the third, resume/)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'SDA-3' }).some((l) => l.getAttribute('href') === '/tickets/t1?tab=timeline')).toBe(true);
  });
  it('shows calm empty states', () => {
    render(<OperationsPage data={data({ stuck: [], load: [], recentErrors: [], failures: { last24h: { byStage: [], byCode: [] }, last7d: { byStage: [], byCode: [] } } })} />);
    expect(screen.getByText(/Nothing is stuck/)).toBeInTheDocument();
    expect(screen.getByText('No errors recorded.')).toBeInTheDocument();
    expect(screen.getAllByText('No stage ran in this period.')).toHaveLength(2);
  });
});
