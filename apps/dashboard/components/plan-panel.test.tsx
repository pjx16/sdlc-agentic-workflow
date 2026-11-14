import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanPanel } from './plan-panel';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));
const fetchMock = vi.fn();
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const body = (call = 0) => JSON.parse(String((fetchMock.mock.calls[call] as [string, RequestInit])[1].body));

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  refresh.mockReset();
});

describe('PlanPanel (F7)', () => {
  it('shows the plan read-only when the ticket is not at the gate', () => {
    render(<PlanPanel ticketId="t1" status="BREAKDOWN" planMarkdown="# The plan" />);
    expect(screen.getByText('# The plan')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('links to the Confluence page of the plan, at the gate and after it, and only when there is one', () => {
    const { rerender } = render(<PlanPanel ticketId="t1" status="AWAITING_PLAN_APPROVAL" planMarkdown="# P" confluenceUrl="https://acme.atlassian.net/wiki/pages/1" />);
    expect(screen.getByRole('link', { name: 'Open in Confluence' })).toHaveAttribute('href', 'https://acme.atlassian.net/wiki/pages/1');
    rerender(<PlanPanel ticketId="t1" status="BREAKDOWN" planMarkdown="# P" confluenceUrl="https://acme.atlassian.net/wiki/pages/1" />);
    expect(screen.getByRole('link', { name: 'Open in Confluence' })).toBeInTheDocument();
    rerender(<PlanPanel ticketId="t1" status="BREAKDOWN" planMarkdown="# P" />);
    expect(screen.queryByRole('link', { name: 'Open in Confluence' })).not.toBeInTheDocument();
  });

  it('says there is no plan yet', () => {
    render(<PlanPanel ticketId="t1" status="PLANNING" planMarkdown={null} />);
    expect(screen.getByText(/No plan yet/)).toBeInTheDocument();
  });

  it('at the gate: approves the plan unchanged with an empty body', async () => {
    fetchMock.mockResolvedValue(reply({ status: 'BREAKDOWN' }));
    render(<PlanPanel ticketId="t1" status="AWAITING_PLAN_APPROVAL" planMarkdown="# Plan v1" />);
    expect(screen.getByLabelText('Plan')).toHaveValue('# Plan v1');
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/tickets/t1/plan/approve');
    expect(body()).toEqual({});
    expect(screen.getByRole('status')).toHaveTextContent('Plan approved');
  });

  it('sends the edited text when the plan was changed, and says so on the button', async () => {
    fetchMock.mockResolvedValue(reply({ status: 'BREAKDOWN' }));
    render(<PlanPanel ticketId="t1" status="AWAITING_PLAN_APPROVAL" planMarkdown="# Plan v1" />);
    await userEvent.type(screen.getByLabelText('Plan'), '\nAlso handle empty exports.');
    await userEvent.click(screen.getByRole('button', { name: 'Approve with edits' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(body()).toEqual({ planMarkdown: '# Plan v1\nAlso handle empty exports.' });
  });

  it('cannot approve an empty plan', async () => {
    render(<PlanPanel ticketId="t1" status="AWAITING_PLAN_APPROVAL" planMarkdown="x" />);
    await userEvent.clear(screen.getByLabelText('Plan'));
    expect(screen.getByRole('button', { name: /Approve/ })).toBeDisabled();
  });

  it('rejects with a note: asks for it first, then posts it', async () => {
    fetchMock.mockResolvedValue(reply({ status: 'PLANNING' }));
    render(<PlanPanel ticketId="t1" status="AWAITING_PLAN_APPROVAL" planMarkdown="# Plan" />);
    expect(screen.queryByLabelText('What should change?')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reject…' }));
    await userEvent.type(screen.getByLabelText('What should change?'), 'Reuse the existing queue');
    await userEvent.click(screen.getByRole('button', { name: 'Send rejection' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/tickets/t1/plan/reject');
    expect(body()).toEqual({ note: 'Reuse the existing queue' });
    expect(screen.getByRole('status')).toHaveTextContent('planned again with your note');
  });

  it('shows the field error when the note is missing, and lets you cancel', async () => {
    fetchMock.mockResolvedValue(reply({ error: 'validation_error', message: 'Validation failed', fields: { note: 'required' } }, 400));
    render(<PlanPanel ticketId="t1" status="AWAITING_PLAN_APPROVAL" planMarkdown="# Plan" />);
    await userEvent.click(screen.getByRole('button', { name: 'Reject…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Send rejection' }));
    expect(await screen.findByText('required')).toBeInTheDocument();
    expect(screen.getByLabelText('What should change?')).toHaveAttribute('aria-invalid', 'true');
    expect(refresh).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('What should change?')).not.toBeInTheDocument();
  });

  it('shows the server message when the ticket is no longer at the gate (409), and when the server is unreachable', async () => {
    fetchMock.mockResolvedValueOnce(reply({ error: 'conflict', message: 'The ticket is not awaiting plan approval (it is BREAKDOWN)' }, 409));
    render(<PlanPanel ticketId="t1" status="AWAITING_PLAN_APPROVAL" planMarkdown="# Plan" />);
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText(/not awaiting plan approval/)).toBeInTheDocument();
    fetchMock.mockRejectedValueOnce(new Error('down'));
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Cannot reach the server.')).toBeInTheDocument();
  });
});
