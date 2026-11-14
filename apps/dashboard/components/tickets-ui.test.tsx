import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RunsTable } from './runs-table';
import { StateBadge } from './state-badge';
import { TicketForm } from './ticket-form';
import { TicketFilters, TicketsTable } from './tickets-table';
import { TransitionHistory } from './transition-history';
import type { RunView, TicketListItem, TransitionView } from '@/lib/types';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: vi.fn(), replace: vi.fn() }) }));
const fetchMock = vi.fn();
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  push.mockReset();
});

const ticket = (over: Partial<TicketListItem> = {}): TicketListItem => ({
  id: 't1', projectId: 'p1', projectName: 'Billing', key: 'BILL-1', source: 'paste', type: 'story', title: 'Add export', status: 'NEW', holdReason: null, holdFromStatus: null,
  updatedAt: '2026-11-11T16:30:00.000Z', ...over,
});

describe('StateBadge', () => {
  it('shows the humanized state', () => {
    render(<StateBadge status="AWAITING_PLAN_APPROVAL" />);
    expect(screen.getByText('Awaiting plan approval')).toBeInTheDocument();
  });
});

describe('TicketForm: the ticket format', () => {
  it('starts the description with the team ticket format', () => {
    render(<TicketForm projects={[{ id: 'p1', name: 'Alpha', mirrorStatus: 'ok', enabled: true }]} template={'## Problem\n\n## Acceptance criteria\n'} />);
    expect((screen.getByLabelText(/description/i) as HTMLTextAreaElement).value).toBe('## Problem\n\n## Acceptance criteria\n');
  });
});

describe('TicketsTable: tickets waiting for a person', () => {
  it('marks the states that wait for you, and only those', () => {
    render(<TicketsTable tickets={[ticket({ id: 'a', key: 'A-1', status: 'IN_HUMAN_REVIEW' }), ticket({ id: 'b', key: 'A-2', status: 'AWAITING_PLAN_APPROVAL' }), ticket({ id: 'c', key: 'A-3', status: 'IN_PROGRESS' })]} filtered={false} />);
    expect(screen.getByText('Review the PR')).toBeInTheDocument();
    expect(screen.getByText('Approve the plan')).toBeInTheDocument();
    expect(screen.queryAllByText(/^(Review the PR|Approve the plan|Approve the breakdown|On hold|Failed)$/)).toHaveLength(2);
  });
});

describe('TicketsTable and filters', () => {
  it('lists key, title, project, state and updated time, with a link to the ticket', () => {
    render(<TicketsTable tickets={[ticket(), ticket({ id: 't2', key: 'ABC-7', title: 'Fix crash', status: 'PLANNING', projectName: 'Alpha' })]} filtered={false} />);
    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[1] as HTMLElement).getByRole('link', { name: 'BILL-1' })).toHaveAttribute('href', '/tickets/t1');
    expect(within(rows[1] as HTMLElement).getByText('Add export')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('Billing')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('New')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('2026-11-11 16:30 UTC')).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText('Planning')).toBeInTheDocument();
  });

  it('has different empty messages with and without filters', () => {
    const { rerender } = render(<TicketsTable tickets={[]} filtered={false} />);
    expect(screen.getByText(/No tickets yet/)).toBeInTheDocument();
    rerender(<TicketsTable tickets={[]} filtered />);
    expect(screen.getByText('No tickets match these filters.')).toBeInTheDocument();
  });

  it('offers project and state filters as a GET form, keeping the current choice', () => {
    render(<TicketFilters projects={[{ id: 'p1', name: 'Billing' }, { id: 'p2', name: 'Alpha' }]} filters={{ projectId: 'p2', status: 'PLANNING' }} />);
    const form = screen.getByRole('form', { name: 'Filters' });
    expect(form).toHaveAttribute('method', 'get');
    expect(screen.getByLabelText('Project')).toHaveValue('p2');
    expect(screen.getByLabelText('State')).toHaveValue('PLANNING');
    expect(within(screen.getByLabelText('State')).getAllByRole('option')).toHaveLength(15); // all + 14 states
    expect(screen.getByRole('link', { name: 'Clear' })).toHaveAttribute('href', '/tickets');
  });

  it('shows no Clear link when nothing is filtered', () => {
    render(<TicketFilters projects={[]} filters={{}} />);
    expect(screen.queryByRole('link', { name: 'Clear' })).not.toBeInTheDocument();
  });
});

describe('TransitionHistory (F15)', () => {
  const t = (over: Partial<TransitionView>): TransitionView => ({
    id: 'x', at: '2026-11-11T10:00:00.000Z', fromStatus: 'NEW', toStatus: 'KB', actor: 'system', reason: null, stageRunId: null, jiraStatusApplied: null, jiraSyncResult: 'none', jiraSyncError: null, ...over,
  });

  it('shows each state change with who made it and why', () => {
    render(<TransitionHistory transitions={[t({ id: '1', reason: 'picked up' }), t({ id: '2', fromStatus: 'KB', toStatus: 'PLANNING', actor: 'user' })]} />);
    expect(screen.getAllByRole('row')).toHaveLength(3);
    expect(screen.getByText('picked up')).toBeInTheDocument();
    expect(screen.getByText('user')).toBeInTheDocument();
    expect(screen.getAllByLabelText('to')).toHaveLength(2);
  });

  it('shows a successful Jira move, and a dash when nothing was mapped', () => {
    render(<TransitionHistory transitions={[t({ id: '1', jiraSyncResult: 'applied', jiraStatusApplied: 'In Progress' }), t({ id: '2' })]} />);
    expect(screen.getByText('Moved to “In Progress”')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a failed Jira move as a warning with the error, without hiding the transition', () => {
    render(<TransitionHistory transitions={[t({ jiraSyncResult: 'failed', jiraStatusApplied: 'Shipped', jiraSyncError: 'Jira has no transition to "Shipped"', toStatus: 'DONE' })]} />);
    const warning = screen.getByRole('alert');
    expect(warning).toHaveTextContent('Jira move to “Shipped” failed: Jira has no transition to "Shipped"');
    expect(screen.getByText('Done')).toBeInTheDocument();
  });

  it('has an empty state', () => {
    render(<TransitionHistory transitions={[]} />);
    expect(screen.getByText('No state changes yet.')).toBeInTheDocument();
  });
});

describe('RunsTable', () => {
  const run = (over: Partial<RunView> = {}): RunView => ({ id: 'r1', stage: 'plan', model: 'opus', attempt: 1, round: 0, status: 'succeeded', startedAt: '2026-01-01T10:00:00Z', endedAt: '2026-01-01T10:03:05Z', inputTokens: 1200, outputTokens: 300, costUsd: 0.01, numTurns: 3, error: null, ...over });

  it('lists runs with duration, tokens and a link to the log', () => {
    render(<RunsTable runs={[run(), run({ id: 'r2', status: 'failed', error: 'Timed out after 20 minutes', attempt: 2 })]} />);
    expect(screen.getAllByRole('link', { name: 'View' })[0]).toHaveAttribute('href', '/runs/r1');
    expect(screen.getAllByText('3m 5s')).toHaveLength(2);
    expect(screen.getAllByText('1,500')).toHaveLength(2);
    expect(screen.getByText('Timed out after 20 minutes')).toBeInTheDocument();
  });
  it('has an empty state', () => {
    render(<RunsTable runs={[]} />);
    expect(screen.getByText(/No stage has run/)).toBeInTheDocument();
  });
});

describe('TicketForm (paste)', () => {
  const projects = [{ id: 'p1', name: 'Billing', mirrorStatus: 'ok', enabled: true }, { id: 'p2', name: 'Off', mirrorStatus: 'ok', enabled: false }, { id: 'p3', name: 'Cloning', mirrorStatus: 'pending', enabled: true }];

  it('only offers enabled projects and marks one whose mirror is not ready', () => {
    render(<TicketForm projects={projects} />);
    expect(within(screen.getByLabelText('Project')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Billing', 'Cloning (mirror pending)']);
  });

  it('posts the ticket and goes to its page', async () => {
    fetchMock.mockResolvedValue(reply({ id: 'new-1', key: 'BILL-1' }, 201));
    render(<TicketForm projects={projects} />);
    await userEvent.type(screen.getByLabelText('Title'), 'Add export');
    await userEvent.type(screen.getByLabelText('Description'), 'CSV please');
    await userEvent.selectOptions(screen.getByLabelText('Kind'), 'bug');
    await userEvent.click(screen.getByRole('button', { name: 'Create ticket' }));
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith('/tickets/new-1'));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/tickets');
    expect(JSON.parse(String(init.body))).toEqual({ projectId: 'p1', title: 'Add export', body: 'CSV please', kind: 'bug', featureKey: '' });
  });

  it('shows field-level errors, and a conflict message when the mirror is not ready', async () => {
    fetchMock.mockResolvedValueOnce(reply({ error: 'validation_error', message: 'Validation failed', fields: { title: 'required' } }, 400));
    render(<TicketForm projects={projects} />);
    await userEvent.click(screen.getByRole('button', { name: 'Create ticket' }));
    expect(await screen.findByText('required')).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toHaveAttribute('aria-invalid', 'true');
    expect(push).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(reply({ error: 'conflict', message: 'The repository mirror is still being cloned' }, 409));
    await userEvent.type(screen.getByLabelText('Title'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Create ticket' }));
    expect(await screen.findByText('The repository mirror is still being cloned')).toBeInTheDocument();
  });

  it('asks for a project when there is none', () => {
    render(<TicketForm projects={[]} />);
    expect(screen.getByText(/no enabled project/i)).toBeInTheDocument();
  });
});
