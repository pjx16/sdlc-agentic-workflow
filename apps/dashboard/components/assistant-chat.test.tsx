import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantChat, AssistantToggle } from './assistant-chat';
import type { AssistantView } from '@/lib/types';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const fetchMock = vi.fn();
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const view = (over: Partial<AssistantView> = {}): AssistantView => ({ canSend: true, blockedReason: null, pending: false, tokens: 1200, tokenCap: 200000, capReached: false, messages: [], ...over });
beforeEach(() => {
  fetchMock.mockReset();
  refresh.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.useRealTimers());

describe('AssistantChat', () => {
  it('shows the conversation, the token use, and says it only drafts', async () => {
    fetchMock.mockResolvedValue(reply(view({ messages: [{ id: 'm1', role: 'user', text: 'What should I answer?', at: '', draft: null }, { id: 'm2', role: 'assistant', text: 'Use a comma.', at: '', draft: null }] })));
    render(<AssistantChat supportTicketId="s1" />);
    expect(await screen.findByText('Use a comma.')).toBeInTheDocument();
    expect(screen.getByText('What should I answer?')).toBeInTheDocument();
    expect(screen.getByText(/1,200 \/ 200,000 tokens used/)).toBeInTheDocument();
    expect(screen.getByText(/nothing changes until you apply a draft/)).toBeInTheDocument();
  });

  it('sends a message and shows that the assistant is working', async () => {
    fetchMock.mockResolvedValueOnce(reply(view()));
    render(<AssistantChat supportTicketId="s1" />);
    await screen.findByLabelText('Ask a question');
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    fetchMock.mockResolvedValueOnce(reply(view({ pending: true, canSend: false, messages: [{ id: 'm1', role: 'user', text: 'Which one?', at: '', draft: null }] })));
    await userEvent.type(screen.getByLabelText('Ask a question'), 'Which one?');
    await userEvent.click(send);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/support-tickets/s1/assistant/messages');
    expect(JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body))).toEqual({ text: 'Which one?' });
    expect(await screen.findByRole('status')).toHaveTextContent('working on it');
  });

  it('asks again every two seconds while the assistant is working, and stops when it has answered', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchMock.mockResolvedValueOnce(reply(view({ pending: true, canSend: false })));
    render(<AssistantChat supportTicketId="s1" />);
    await screen.findByRole('status');
    fetchMock.mockResolvedValue(reply(view({ messages: [{ id: 'm2', role: 'assistant', text: 'Done thinking.', at: '', draft: null }] })));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(await screen.findByText('Done thinking.')).toBeInTheDocument();
    const calls = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it('applies a draft with one click, and the page refreshes', async () => {
    const draft = { kind: 'answer' as const, text: 'Comma', appliedAt: null, diff: null };
    fetchMock.mockResolvedValueOnce(reply(view({ messages: [{ id: 'm2', role: 'assistant', text: 'Use a comma.', at: '', draft }] })));
    render(<AssistantChat supportTicketId="s1" />);
    fetchMock.mockResolvedValueOnce(reply({})).mockResolvedValueOnce(reply(view({ messages: [{ id: 'm2', role: 'assistant', text: 'Use a comma.', at: '', draft: { ...draft, appliedAt: 'now' } }] })));
    await userEvent.click(await screen.findByRole('button', { name: 'Use this answer' }));
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/support-tickets/s1/assistant/messages/m2/apply');
    expect(refresh).toHaveBeenCalled();
    expect(await screen.findByText('Applied.')).toBeInTheDocument();
  });

  it('shows an edited plan as a diff', async () => {
    const draft = { kind: 'plan_edit' as const, text: '## Goal\nNew', appliedAt: null, diff: '- Old\n+ New' };
    fetchMock.mockResolvedValue(reply(view({ messages: [{ id: 'm2', role: 'assistant', text: 'Smaller plan.', at: '', draft }] })));
    render(<AssistantChat supportTicketId="s1" />);
    const diff = await screen.findByLabelText('Changes to the plan');
    expect(diff).toHaveTextContent('- Old');
    expect(diff).toHaveTextContent('+ New');
    expect(screen.getByRole('button', { name: 'Approve with this plan' })).toBeInTheDocument();
  });

  it('explains why it cannot take a message (paused, or the token budget is used) and disables the box', async () => {
    fetchMock.mockResolvedValue(reply(view({ canSend: false, capReached: true, blockedReason: 'This conversation used its 200,000 token budget.' })));
    render(<AssistantChat supportTicketId="s1" />);
    expect(await screen.findByText(/token budget/)).toBeInTheDocument();
    expect(screen.getByLabelText('Ask a question')).toBeDisabled();
  });

  it('shows the server error when sending fails', async () => {
    fetchMock.mockResolvedValueOnce(reply(view()));
    render(<AssistantChat supportTicketId="s1" />);
    await userEvent.type(await screen.findByLabelText('Ask a question'), 'hi');
    fetchMock.mockResolvedValueOnce(reply({ message: 'The pipeline is paused' }, 409));
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The pipeline is paused');
  });
});

describe('AssistantToggle', () => {
  it('opens and closes the chat', async () => {
    fetchMock.mockResolvedValue(reply(view()));
    render(<AssistantToggle supportTicketId="s1" />);
    expect(screen.queryByLabelText('Assistant')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Ask the assistant' }));
    expect(await screen.findByLabelText('Assistant')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Hide the assistant' }));
    expect(screen.queryByLabelText('Assistant')).not.toBeInTheDocument();
  });
});
