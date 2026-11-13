import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HoldInfo } from '@/lib/types';
import { HoldPanel } from './hold-panel';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
const fetchMock = vi.fn();

const info = (over: Partial<HoldInfo> = {}): HoldInfo => ({
  status: 'ON_HOLD', holdReason: 'needs_help', holdFromStatus: 'IN_PROGRESS', note: 'The fix stage failed twice: the test cannot pass', at: null,
  failedRun: { id: 'r9', stage: 'fix', attempt: 2, round: 1, error: 'blocked' }, subtask: { seq: 1, title: 'Add a section', status: 'FIXING', fixRounds: 1 }, canRedoTests: true, ...over,
});

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
  refresh.mockReset();
});

describe('HoldPanel', () => {
  it('shows what happened, the recorded reason, the steps to take and a link to the failed run', () => {
    render(<HoldPanel ticketId="t1" info={info()} />);
    expect(screen.getByText('What happened')).toBeInTheDocument();
    expect(screen.getByTestId('hold-detail')).toHaveTextContent('The fix stage failed twice: the test cannot pass');
    expect(screen.getByText('What to do')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByRole('link', { name: /log of the failed fix run/ })).toHaveAttribute('href', '/runs/r9');
    for (const name of ['Redo tests', 'Retry', 'Resume']) expect(screen.getByRole('button', { name })).toBeInTheDocument();
  });

  it('Retry and Resume post to their endpoints and refresh the page', async () => {
    render(<HoldPanel ticketId="t1" info={info()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/tickets/t1/retry', expect.objectContaining({ method: 'POST' })));
    await userEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/tickets/t1/resume', expect.objectContaining({ method: 'POST' })));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('Redo tests asks first (what is discarded), takes an optional note, and only then posts it', async () => {
    render(<HoldPanel ticketId="t1" info={info()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Redo tests' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('group', { name: 'Redo tests' })).toHaveTextContent('throws away the tests and the code');
    await userEvent.type(screen.getByLabelText(/Tell the agent what to change/), 'accept export const');
    await userEvent.click(screen.getByRole('button', { name: 'Discard and redo the tests' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/tickets/t1/redo-tests', expect.objectContaining({ method: 'POST', body: JSON.stringify({ note: 'accept export const' }) })));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.queryByRole('group', { name: 'Redo tests' })).toBeNull();
  });

  it('cancelling Redo tests posts nothing', async () => {
    render(<HoldPanel ticketId="t1" info={info()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Redo tests' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('only offers Redo tests when it applies, and has no buttons while waiting for an answer', () => {
    const { rerender } = render(<HoldPanel ticketId="t1" info={info({ canRedoTests: false })} />);
    expect(screen.queryByRole('button', { name: 'Redo tests' })).toBeNull();
    rerender(<HoldPanel ticketId="t1" info={info({ holdReason: 'awaiting_answer' })} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('link', { name: 'Go to Inbox' })).toHaveAttribute('href', '/inbox');
  });

  it('shows the server error', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 409, json: async () => ({ message: 'There are no tests of the current subtask to redo. Use Retry instead.' }) });
    render(<HoldPanel ticketId="t1" info={info()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Use Retry instead');
  });
});
