import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeleteProject } from './delete-project';

const replace = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace, refresh }) }));
const fetchMock = vi.fn();
const project = { id: 'p1', name: 'Billing' };
const impact = (over = {}) => ({ ok: true, status: 200, json: async () => ({ tickets: 4, openTickets: 2, stageRuns: 17, runningStage: false, ...over }) });

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  replace.mockReset();
  refresh.mockReset();
});

async function open() {
  render(<DeleteProject project={project} />);
  await userEvent.click(screen.getByRole('button', { name: 'Delete project…' }));
  await screen.findByText(/4 tickets/);
}

describe('DeleteProject', () => {
  it('shows nothing destructive until asked, then warns with what will be deleted', async () => {
    fetchMock.mockResolvedValue(impact());
    render(<DeleteProject project={project} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Delete project…' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('This cannot be undone');
    expect(dialog).toHaveTextContent('4 tickets');
    expect(dialog).toHaveTextContent('2 not finished');
    expect(dialog).toHaveTextContent('17 stage runs');
    expect(dialog).toHaveTextContent('Nothing is changed on GitHub or Jira');
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p1/delete-impact');
  });

  it('keeps the delete button disabled until the project name is typed exactly', async () => {
    fetchMock.mockResolvedValue(impact());
    await open();
    const button = screen.getByRole('button', { name: 'Delete permanently' });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Type/), 'billing');
    expect(button).toBeDisabled();
    await userEvent.clear(screen.getByLabelText(/Type/));
    await userEvent.type(screen.getByLabelText(/Type/), 'Billing');
    expect(button).toBeEnabled();
  });

  it('deletes with DELETE /permanent and returns to the project list', async () => {
    fetchMock.mockResolvedValueOnce(impact()).mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ deleted: true, tickets: 4 }) });
    await open();
    await userEvent.type(screen.getByLabelText(/Type/), 'Billing');
    await userEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/projects'));
    expect(fetchMock).toHaveBeenLastCalledWith('/api/projects/p1/permanent', { method: 'DELETE' });
  });

  it('still lets you delete when the counts cannot be loaded (the server enforces the rules)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) }).mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ deleted: true, tickets: 0 }) });
    render(<DeleteProject project={project} />);
    await userEvent.click(screen.getByRole('button', { name: 'Delete project…' }));
    expect(await screen.findByText(/counts could not be loaded/)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveTextContent('enabled once the name above matches');
    await userEvent.type(screen.getByLabelText(/Type/), 'Billing');
    await userEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/projects'));
  });

  it('cancel closes the dialog without deleting', async () => {
    fetchMock.mockResolvedValue(impact());
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cannot delete while a stage is running, and shows the server error if the delete is refused', async () => {
    fetchMock.mockResolvedValue(impact({ runningStage: true }));
    await open();
    await userEvent.type(screen.getByLabelText(/Type/), 'Billing');
    expect(screen.getByRole('button', { name: 'Delete permanently' })).toBeDisabled();
    expect(screen.getByRole('dialog')).toHaveTextContent('A stage of this project is running');
  });

  it('shows the error when the server refuses', async () => {
    fetchMock.mockResolvedValueOnce(impact()).mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ message: 'A stage of this project is running.' }) });
    await open();
    await userEvent.type(screen.getByLabelText(/Type/), 'Billing');
    await userEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A stage of this project is running.');
    expect(replace).not.toHaveBeenCalled();
  });
});
