import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubtaskDraft } from '@sdlc/shared';
import { BreakdownPanel } from './breakdown-panel';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));
const fetchMock = vi.fn();
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const sent = (call = 0) => JSON.parse(String((fetchMock.mock.calls[call] as [string, RequestInit])[1].body));

const draft: SubtaskDraft[] = [
  { seq: 1, title: 'Add the model', description: 'Create the table', acceptanceCriteria: ['Table exists'], files: ['src/model.ts'], dependsOn: [] },
  { seq: 2, title: 'Add the endpoint', description: '', acceptanceCriteria: ['Returns rows', 'Handles empty'], files: [], dependsOn: [1] },
];
const gate = (over: Partial<Parameters<typeof BreakdownPanel>[0]> = {}) => render(<BreakdownPanel ticketId="t1" status="AWAITING_BREAKDOWN_APPROVAL" draft={draft} subtasks={[]} maxSubtasks={8} {...over} />);

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  refresh.mockReset();
});

describe('BreakdownPanel (F8)', () => {
  it('shows the created subtasks read-only after approval', () => {
    render(<BreakdownPanel ticketId="t1" status="IN_PROGRESS" draft={draft} maxSubtasks={8} subtasks={[{ id: 's1', seq: 1, title: 'Add the model', description: 'd', status: 'DONE', fixRounds: 0, acceptanceCriteria: ['Table exists'], files: [], dependsOn: [] }, { id: 's2', seq: 2, title: 'Add the endpoint', description: '', status: 'PENDING', fixRounds: 0, acceptanceCriteria: ['Returns rows'], files: [], dependsOn: [1] }]} />);
    expect(screen.getByText('1. Add the model')).toBeInTheDocument();
    expect(screen.getByText('DONE')).toBeInTheDocument();
    expect(screen.getByText('Depends on: 1')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('says there is no breakdown yet', () => {
    render(<BreakdownPanel ticketId="t1" status="BREAKDOWN" draft={null} subtasks={[]} maxSubtasks={8} />);
    expect(screen.getByText(/No breakdown yet/)).toBeInTheDocument();
  });

  it('at the gate: shows every subtask in an editor and approves the unchanged list with an empty body', async () => {
    fetchMock.mockResolvedValue(reply({ status: 'IN_PROGRESS' }));
    gate();
    expect(screen.getByLabelText('Title 1')).toHaveValue('Add the model');
    expect(screen.getByLabelText('Acceptance criteria 2 (one per line)')).toHaveValue('Returns rows\nHandles empty');
    expect(screen.getByLabelText('Depends on 2 (numbers)')).toHaveValue('1');
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/tickets/t1/breakdown/approve');
    expect(sent()).toEqual({});
    expect(screen.getByRole('status')).toHaveTextContent('subtasks were created');
  });

  it('edits a title, description and criteria, and sends the validated list', async () => {
    fetchMock.mockResolvedValue(reply({ status: 'IN_PROGRESS' }));
    gate();
    await userEvent.clear(screen.getByLabelText('Title 1'));
    await userEvent.type(screen.getByLabelText('Title 1'), 'Add the Booking model');
    await userEvent.type(screen.getByLabelText('Acceptance criteria 1 (one per line)'), '\nIndexed by date');
    await userEvent.click(screen.getByRole('button', { name: 'Approve with edits' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = sent();
    expect(body.subtasks[0]).toMatchObject({ seq: 1, title: 'Add the Booking model', acceptanceCriteria: ['Table exists', 'Indexed by date'], files: ['src/model.ts'], dependsOn: [] });
    expect(body.subtasks).toHaveLength(2);
  });

  it('validates live with the same rules as the server, and blocks approval until fixed', async () => {
    gate();
    await userEvent.clear(screen.getByLabelText('Title 2'));
    expect(screen.getByText('required')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Approve/ })).toBeDisabled();
    expect(screen.getByText('Fix the highlighted fields to approve.')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Title 2'), 'Back again');
    expect(screen.getByRole('button', { name: /Approve/ })).toBeEnabled();

    await userEvent.clear(screen.getByLabelText('Depends on 1 (numbers)'));
    await userEvent.type(screen.getByLabelText('Depends on 1 (numbers)'), '2');
    expect(screen.getByText(/depends on a later subtask/)).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText('Depends on 1 (numbers)'));
    await userEvent.clear(screen.getByLabelText('Acceptance criteria 1 (one per line)'));
    expect(screen.getByText('at least one acceptance criterion')).toBeInTheDocument();
  });

  it('reorders: moving a subtask renumbers and keeps the dependencies following it', async () => {
    gate({ draft: [{ ...draft[0]! }, { ...draft[1]!, dependsOn: [] }, { seq: 3, title: 'Wire it up', description: '', acceptanceCriteria: ['Works'], files: [], dependsOn: [1] }] });
    await userEvent.click(screen.getByRole('button', { name: 'Move subtask 3 up' }));
    expect(screen.getByLabelText('Title 2')).toHaveValue('Wire it up');
    expect(screen.getByLabelText('Title 3')).toHaveValue('Add the endpoint');
    expect(screen.getByLabelText('Depends on 2 (numbers)')).toHaveValue('1');
    expect(screen.getByRole('button', { name: 'Move subtask 1 up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move subtask 3 down' })).toBeDisabled();
  });

  it('removes and adds subtasks, and respects the maximum', async () => {
    gate({ maxSubtasks: 2 });
    expect(screen.getByRole('button', { name: 'Add subtask' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Remove subtask 1' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByLabelText('Title 1')).toHaveValue('Add the endpoint');
    expect(screen.getByLabelText('Depends on 1 (numbers)')).toHaveValue(''); // the dependency on the removed subtask is dropped
    await userEvent.click(screen.getByRole('button', { name: 'Add subtask' }));
    expect(screen.getByLabelText('Title 2')).toHaveValue('');
    expect(screen.getByText('required')).toBeInTheDocument();
  });

  it('shows the list-level error when there are too many subtasks', () => {
    const many = Array.from({ length: 3 }, (_, i) => ({ seq: i + 1, title: `T${i}`, description: '', acceptanceCriteria: ['c'], files: [], dependsOn: [] }));
    gate({ draft: many, maxSubtasks: 2 });
    expect(screen.getByText('3 subtasks is more than the limit of 2')).toBeInTheDocument();
  });

  it('shows server-side field errors when the server rejects the list', async () => {
    fetchMock.mockResolvedValue(reply({ error: 'validation_error', message: 'The breakdown is not valid', fields: { 'subtasks.0.title': 'required' } }, 400));
    gate();
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('The breakdown is not valid')).toBeInTheDocument();
    expect(screen.getByText('required')).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('rejects with a note', async () => {
    fetchMock.mockResolvedValue(reply({ status: 'BREAKDOWN' }));
    gate();
    await userEvent.click(screen.getByRole('button', { name: 'Reject…' }));
    await userEvent.type(screen.getByLabelText('What should change?'), 'Split the API from the UI');
    await userEvent.click(screen.getByRole('button', { name: 'Send rejection' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/tickets/t1/breakdown/reject');
    expect(sent()).toEqual({ note: 'Split the API from the UI' });
    expect(within(screen.getByRole('status')).getByText(/split again with your note/)).toBeInTheDocument();
  });

  it('reports a conflict and an unreachable server', async () => {
    fetchMock.mockResolvedValueOnce(reply({ error: 'conflict', message: 'The ticket is not awaiting breakdown approval (it is IN_PROGRESS)' }, 409));
    gate();
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText(/not awaiting breakdown approval/)).toBeInTheDocument();
    fetchMock.mockRejectedValueOnce(new Error('down'));
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Cannot reach the server.')).toBeInTheDocument();
  });
});

describe('BreakdownPanel: a draft read back from a JSON column', () => {
  it('is not "edited" just because the keys came back in another order', () => {
    const scrambled = [{ title: 'Add the counter', seq: 1, files: ['src/a.ts'], dependsOn: [], description: 'd', acceptanceCriteria: ['c'] }] as never;
    render(<BreakdownPanel ticketId="t1" status="AWAITING_BREAKDOWN_APPROVAL" draft={scrambled} subtasks={[]} maxSubtasks={8} />);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve with edits' })).not.toBeInTheDocument();
  });
});
