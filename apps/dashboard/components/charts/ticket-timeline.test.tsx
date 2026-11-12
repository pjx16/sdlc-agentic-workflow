import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { TicketTimeline, type TimelineRun } from './ticket-timeline';

const run = (over: Partial<TimelineRun> = {}): TimelineRun => ({ id: 'r1', stage: 'plan', attempt: 1, round: 0, status: 'succeeded', startedAt: '2026-11-12T10:00:00Z', endedAt: '2026-11-12T10:01:00Z', ...over });
const NOW = Date.parse('2026-11-12T10:10:00Z');

describe('TicketTimeline (F17)', () => {
  it('has a clear empty state when nothing ran (and for runs that never started)', () => {
    const { rerender } = render(<TicketTimeline runs={[]} now={NOW} />);
    expect(screen.getByText('No stage has run for this ticket yet.')).toBeInTheDocument();
    rerender(<TicketTimeline runs={[run({ startedAt: null, endedAt: null, status: 'queued' })]} now={NOW} />);
    expect(screen.getByText('No stage has run for this ticket yet.')).toBeInTheDocument();
  });

  it('draws one bar per run, linked to its log, with the outcome in its label', () => {
    render(<TicketTimeline runs={[run(), run({ id: 'r2', stage: 'fix', round: 1, attempt: 2, status: 'failed', startedAt: '2026-11-12T10:02:00Z', endedAt: '2026-11-12T10:05:00Z' })]} now={NOW} />);
    const first = screen.getByRole('link', { name: 'plan: succeeded, 1m 0s' });
    expect(first).toHaveAttribute('href', '/runs/r1');
    expect(first.getAttribute('style')).toContain('var(--status-green)');
    const second = screen.getByRole('link', { name: 'fix r1 (attempt 2): failed, 3m 0s' });
    expect(second.getAttribute('style')).toContain('var(--status-red)');
  });

  it('a running stage is measured up to now', () => {
    render(<TicketTimeline runs={[run({ status: 'running', endedAt: null })]} now={NOW} />);
    expect(screen.getByRole('link', { name: 'plan: running, 10m 0s' }).getAttribute('style')).toContain('var(--accent)');
  });

  it('describes itself in text and offers the data as a table', async () => {
    render(<TicketTimeline runs={[run()]} now={NOW} />);
    expect(screen.getByText(/1 stage run\(s\) over 1m 0s/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'View data' }));
    expect(screen.getByRole('cell', { name: 'succeeded' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '2026-11-12 10:00:00' })).toBeInTheDocument();
  });
});
