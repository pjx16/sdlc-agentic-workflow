import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Inbox, NeedsYou } from './inbox';
import { Sidebar } from './sidebar';
import type { SupportTicketView } from '@/lib/types';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }), usePathname: () => '/inbox' }));

const fetchMock = vi.fn();
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
beforeEach(() => {
  fetchMock.mockReset();
  refresh.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

const NOW = Date.parse('2026-11-14T12:00:00Z');
const t = (over: Partial<SupportTicketView>): SupportTicketView => ({
  id: 'x1', kind: 'question', title: 'Which currency?', body: 'Which currency?', priority: 'blocking', status: 'open', group: 'questions', projectId: 'p1', ticketId: 't1', ticketKey: 'SDA-1', ticketTitle: 'Invoices',
  stage: 'plan', defaultAnswer: null, response: null, resolvedBy: null, createdAt: '2026-11-14T10:00:00Z', resolvedAt: null, actions: ['answer', 'dismiss'], ...over,
});
const sentBody = () => JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));

describe('Inbox', () => {
  it('groups items as Blocking, Approvals, Questions and FYI, and shows how long each has waited', () => {
    const items = [
      t({ id: 'a', kind: 'approval', group: 'approvals', title: 'Approve the plan for SDA-1', actions: ['approve', 'reject', 'dismiss'] }),
      t({ id: 'b', kind: 'hold', group: 'blocking', title: 'SDA-2 is on hold', actions: ['resume', 'retry', 'fail', 'dismiss'] }),
      t({ id: 'c', kind: 'pr_ready', group: 'fyi', priority: 'fyi', title: 'SDA-3 is ready', actions: ['dismiss'] }),
      t({ id: 'd' }),
    ];
    render(<Inbox tickets={items} tab="open" now={NOW} />);
    expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(['Blocking', 'Approvals', 'Questions', 'FYI']);
    expect(screen.getAllByText(/waiting 2 h/).length).toBe(4);
  });

  it('shows a calm empty state', () => {
    render(<Inbox tickets={[]} tab="open" />);
    expect(screen.getByText(/Nothing is waiting for you/)).toBeInTheDocument();
  });

  it('answers a question with one POST and refreshes', async () => {
    fetchMock.mockResolvedValue(reply({}));
    render(<Inbox tickets={[t({})]} tab="open" now={NOW} />);
    const send = screen.getByRole('button', { name: 'Answer' });
    expect(send).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Your answer'), 'EUR');
    await userEvent.click(send);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/support-tickets/x1/action');
    expect(sentBody()).toEqual({ action: 'answer', answer: 'EUR' });
    expect(refresh).toHaveBeenCalled();
  });

  it('approves with one click', async () => {
    fetchMock.mockResolvedValue(reply({}));
    render(<Inbox tickets={[t({ kind: 'approval', group: 'approvals', title: 'Approve', actions: ['approve', 'reject', 'dismiss'] })]} tab="open" now={NOW} />);
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(sentBody()).toEqual({ action: 'approve' });
  });

  it('rejects with a note, and will not send an empty one', async () => {
    fetchMock.mockResolvedValue(reply({}));
    render(<Inbox tickets={[t({ kind: 'approval', group: 'approvals', title: 'Approve', actions: ['approve', 'reject', 'dismiss'] })]} tab="open" now={NOW} />);
    await userEvent.click(screen.getByRole('button', { name: 'Reject with a note' }));
    expect(screen.getByRole('button', { name: 'Send back' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('What should change?'), 'use the booking repo');
    await userEvent.click(screen.getByRole('button', { name: 'Send back' }));
    expect(sentBody()).toEqual({ action: 'reject', note: 'use the booking repo' });
  });

  it('a hold offers resume, retry and mark failed', async () => {
    fetchMock.mockResolvedValue(reply({}));
    render(<Inbox tickets={[t({ kind: 'hold', group: 'blocking', title: 'on hold', actions: ['resume', 'retry', 'fail', 'dismiss'] })]} tab="open" now={NOW} />);
    for (const name of ['Resume', 'Retry', 'Mark failed', 'Dismiss']) expect(screen.getByRole('button', { name })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(sentBody()).toEqual({ action: 'retry' });
  });

  it('a CI problem offers "fixed, re-run CI"', async () => {
    fetchMock.mockResolvedValue(reply({}));
    render(<Inbox tickets={[t({ kind: 'ci_infra', group: 'blocking', title: 'CI down', actions: ['fixed', 'hold', 'dismiss'] })]} tab="open" now={NOW} />);
    await userEvent.click(screen.getByRole('button', { name: 'Fixed, re-run CI' }));
    expect(sentBody()).toEqual({ action: 'fixed' });
  });

  it('an open question shows the default the plan used and offers a rerun once answered', () => {
    render(<Inbox tickets={[t({ kind: 'open_question', group: 'questions', priority: 'normal', status: 'answered', response: 'the booking one', defaultAnswer: 'a new repository', actions: ['answer', 'rerun_with_answers', 'dismiss'] })]} tab="open" now={NOW} />);
    expect(screen.getByText(/The plan assumed: a new repository/)).toBeInTheDocument();
    expect(screen.getByText('the booking one')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rerun the plan with answers' })).toBeInTheDocument();
  });

  it('a credential and an onboarding item link to where they are fixed', () => {
    render(
      <Inbox
        tickets={[
          t({ id: 'c', kind: 'credential', group: 'blocking', ticketId: null, ticketKey: null, title: 'Claude rejected the credential', actions: ['dismiss'] }),
          t({ id: 'o', kind: 'onboarding', group: 'blocking', ticketId: null, ticketKey: null, title: 'Review the proposal', actions: ['dismiss'], projectId: 'p9' }),
        ]}
        tab="open"
        now={NOW}
      />,
    );
    expect(screen.getByRole('link', { name: 'Open Settings → Connections' })).toHaveAttribute('href', '/setup/connections');
    expect(screen.getByRole('link', { name: 'Review the proposal' })).toHaveAttribute('href', '/projects/p9');
  });

  it('shows the server error, and refreshes when someone else already handled it', async () => {
    fetchMock.mockResolvedValue(reply({ message: 'This ticket is already resolved' }, 409));
    render(<Inbox tickets={[t({ kind: 'hold', group: 'blocking', actions: ['resume', 'dismiss'] })]} tab="open" now={NOW} />);
    await userEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already resolved');
    expect(refresh).toHaveBeenCalled();
  });

  it('the history tab shows who closed each item and how', () => {
    render(<Inbox tab="history" now={NOW} tickets={[t({ status: 'resolved', resolvedBy: 'system', resolvedAt: '2026-11-14T11:00:00Z', response: 'The credential test passed', kind: 'credential', actions: [] })]} />);
    expect(screen.getByText(/resolved 1 h ago by system/)).toBeInTheDocument();
    expect(screen.getByText('The credential test passed')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('NeedsYou and the sidebar badge', () => {
  it('lists the oldest blocking items with a link to the inbox, and hides when nothing is waiting', () => {
    const { rerender } = render(<NeedsYou counts={{ badge: 2 }} now={NOW} tickets={[t({ id: 'a', title: 'Older', createdAt: '2026-11-14T08:00:00Z' }), t({ id: 'b', title: 'Newer' }), t({ id: 'c', kind: 'pr_ready', priority: 'fyi', title: 'FYI' })]} />);
    const region = screen.getByRole('region', { name: 'Needs you' });
    const items = within(region).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Older');
    expect(within(region).getByRole('link', { name: 'Open the inbox' })).toHaveAttribute('href', '/inbox');
    rerender(<NeedsYou counts={{ badge: 0 }} tickets={[]} />);
    expect(screen.queryByRole('region', { name: 'Needs you' })).not.toBeInTheDocument();
  });

  it('the sidebar shows the number on the Inbox entry only when something is waiting', () => {
    const { rerender } = render(<Sidebar pipeline={{ text: 'Idle', tone: 'grey' }} inboxBadge={3} />);
    expect(screen.getByTestId('inbox-badge')).toHaveTextContent('3');
    rerender(<Sidebar pipeline={{ text: 'Idle', tone: 'grey' }} inboxBadge={0} />);
    expect(screen.queryByTestId('inbox-badge')).not.toBeInTheDocument();
    rerender(<Sidebar pipeline={{ text: 'Idle', tone: 'grey' }} inboxBadge={250} />);
    expect(screen.getByTestId('inbox-badge')).toHaveTextContent('99+');
  });
});
