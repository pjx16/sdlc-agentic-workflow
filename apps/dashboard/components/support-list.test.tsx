import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupportQueryView } from '@/lib/types';
import { SupportList } from './support-list';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));
const fetchMock = vi.fn();
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });

const q = (over: Partial<SupportQueryView> = {}): SupportQueryView => ({
  id: 'q1', ticketId: 't1', ticketKey: 'ABC-1', ticketTitle: 'Export bookings', stage: 'plan', question: 'Which currency?', answer: null,
  status: 'open', createdAt: '2026-11-11T10:00:00Z', answeredAt: null, ...over,
});

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  refresh.mockReset();
});

describe('SupportList (F13)', () => {
  it('explains the empty state', () => {
    render(<SupportList queries={[]} />);
    expect(screen.getByText(/No questions/)).toBeInTheDocument();
  });

  it('shows each open question with its ticket, stage and an answer box; answered ones follow read-only', () => {
    render(<SupportList queries={[q(), q({ id: 'q2', ticketKey: 'ABC-2', question: 'Rounding?', status: 'answered', answer: 'Half up' })]} />);
    expect(screen.getByRole('link', { name: 'ABC-1' })).toHaveAttribute('href', '/tickets/t1');
    expect(screen.getByText('Which currency?')).toBeInTheDocument();
    expect(screen.getByText('plan')).toBeInTheDocument();
    expect(screen.getAllByLabelText('Your answer')).toHaveLength(1);
    expect(screen.getByText(/Answer: Half up/)).toBeInTheDocument();
  });

  it('sends the answer, then refreshes the page', async () => {
    fetchMock.mockResolvedValue(reply({ status: 'answered' }));
    render(<SupportList queries={[q()]} />);
    const button = screen.getByRole('button', { name: 'Answer' });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Your answer'), 'EUR');
    await userEvent.click(button);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/support-queries/q1/answer');
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({ answer: 'EUR' });
  });

  it('shows the server message when the question was already answered', async () => {
    fetchMock.mockResolvedValue(reply({ error: 'conflict', message: 'This question was already answered' }, 409));
    render(<SupportList queries={[q()]} />);
    await userEvent.type(screen.getByLabelText('Your answer'), 'EUR');
    await userEvent.click(screen.getByRole('button', { name: 'Answer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already answered');
    expect(within(screen.getByRole('alert').parentElement as HTMLElement).getByLabelText('Your answer')).toHaveAttribute('aria-invalid', 'true');
  });
});
