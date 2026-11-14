import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { EventTimeline } from './event-timeline';
import type { TicketEventView } from '@/lib/types';

const ev = (over: Partial<TicketEventView>): TicketEventView => ({ id: String(Math.random()), at: '2026-11-14T10:00:00Z', level: 'info', source: 'system', type: 'state', message: 'm', errorCode: null, stageRunId: null, subtaskId: null, ...over });

describe('EventTimeline', () => {
  const events = [
    ev({ message: 'SDA-1: NEW -> KB', source: 'system' }),
    ev({ message: 'Coder finished subtask 2/4 · 3m12s · 18 turns · $0.21', source: 'agent', stageRunId: 'run-1' }),
    ev({ message: 'Claude API error (529). Retry 1/3 at 14:32.', level: 'error', source: 'claude', errorCode: 'CLAUDE_API_ERROR' }),
    ev({ message: 'Jira transition to "In Review" skipped: not available from "Blocked"', level: 'warn', source: 'jira' }),
  ];

  it('shows every event as one plain sentence with its source, and links a run to its raw log', () => {
    render(<EventTimeline events={events} />);
    const list = screen.getByRole('list', { name: 'Ticket timeline' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(4);
    expect(screen.getByText(/Coder finished subtask 2\/4/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'raw log' })).toHaveAttribute('href', '/runs/run-1');
  });

  it('marks levels for screen readers and adds the suggested action to a coded error', () => {
    render(<EventTimeline events={events} />);
    expect(screen.getByText('Error:')).toBeInTheDocument();
    expect(screen.getByText('Warning:')).toBeInTheDocument();
    expect(screen.getByText(/After the third, resume the ticket/)).toBeInTheDocument();
  });

  it('"Problems only" hides the info events', async () => {
    render(<EventTimeline events={events} />);
    await userEvent.click(screen.getByLabelText('Problems only'));
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByText(/NEW -> KB/)).not.toBeInTheDocument();
  });

  it('greys out an event of a stale run and says so', () => {
    const run = { id: 'run-1', supersededAt: '2026-11-14T11:00:00Z' } as never;
    render(<EventTimeline events={events} runs={[run]} />);
    expect(screen.getByText('stale')).toBeInTheDocument();
  });

  it('says so when there are no events', () => {
    render(<EventTimeline events={[]} />);
    expect(screen.getByText(/Nothing has happened/)).toBeInTheDocument();
  });
});
