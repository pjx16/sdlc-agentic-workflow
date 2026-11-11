import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KillRunButton } from './kill-run-button';
import { TicketActions, actionsFor } from './ticket-actions';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));
const fetchMock = vi.fn();
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  refresh.mockReset();
});

describe('actionsFor', () => {
  it('offers the actions that fit the state', () => {
    expect(actionsFor('ON_HOLD')).toEqual(['resume', 'retry']);
    expect(actionsFor('FAILED')).toEqual(['retry']);
    expect(actionsFor('IN_HUMAN_REVIEW')).toEqual(['kb-update/rerun', 'hold']);
    expect(actionsFor('IN_PROGRESS')).toEqual(['hold']);
    expect(actionsFor('DONE')).toEqual([]);
  });
});

describe('TicketActions', () => {
  it('renders nothing for a DONE ticket', () => {
    const { container } = render(<TicketActions ticketId="t1" status="DONE" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('posts the chosen action and refreshes', async () => {
    fetchMock.mockResolvedValue(reply({}));
    render(<TicketActions ticketId="t1" status="ON_HOLD" />);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]).toEqual(['/api/tickets/t1/retry', { method: 'POST' }]);
  });

  it('shows the server message when the action is refused', async () => {
    fetchMock.mockResolvedValue(reply({ message: 'A DONE ticket cannot be put on hold' }, 409));
    render(<TicketActions ticketId="t1" status="IN_PROGRESS" />);
    await userEvent.click(screen.getByRole('button', { name: 'Hold' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('cannot be put on hold');
  });
});

describe('KillRunButton', () => {
  it('requests the kill and shows that it is stopping', async () => {
    fetchMock.mockResolvedValue(reply({ killRequested: true }));
    render(<KillRunButton runId="r1" />);
    await userEvent.click(screen.getByRole('button', { name: 'Kill' }));
    expect(await screen.findByText('Stopping…')).toBeInTheDocument();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/runs/r1/kill');
  });
  it('offers another try when the request fails', async () => {
    fetchMock.mockResolvedValue(reply({}, 409));
    render(<KillRunButton runId="r1" />);
    await userEvent.click(screen.getByRole('button', { name: 'Kill' }));
    expect(await screen.findByRole('button', { name: 'Kill failed, retry' })).toBeInTheDocument();
  });
});
