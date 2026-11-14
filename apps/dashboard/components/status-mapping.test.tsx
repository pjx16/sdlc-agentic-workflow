import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROJECT_SETTINGS } from '@sdlc/shared';
import { ProjectForm } from './project-form';
import type { ProjectView } from '@/lib/types';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));
const fetchMock = vi.fn();
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });

const project = (jiraMode: 'rest' | 'off', map: Record<string, string | null> = {}): ProjectView => ({
  id: 'p1', name: 'Billing', repoUrl: 'https://github.com/a/b', baseBranch: 'dev', stack: 'nestjs', installCmd: 'npm ci', typecheckCmd: 'npx tsc --noEmit',
  testCmdTemplate: 'npx jest {files}', kbDir: 'docs/kb', claudeMdMode: 'both', jiraMode, jiraProjectKey: 'ABC', localKeyPrefix: 'BILL', enabled: true,
  mirrorStatus: 'ok', mirrorError: null, nextLocalNumber: 1, createdAt: '', updatedAt: '',
  settings: { ...DEFAULT_PROJECT_SETTINGS, jiraStatusMap: { ...DEFAULT_PROJECT_SETTINGS.jiraStatusMap, ...map } },
});

/** The rows are text inputs until Jira answers; wait until they have become dropdowns. */
const dropdown = async (label: string) => {
  await waitFor(() => expect(screen.getByLabelText(label).tagName).toBe('SELECT'));
  return screen.getByLabelText(label) as HTMLSelectElement;
};

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

describe('Jira status mapping table (F15)', () => {
  it('REST mode: fills each row with a dropdown of the statuses in Jira', async () => {
    fetchMock.mockResolvedValue(reply(['To Do', 'In Progress', 'Done']));
    render(<ProjectForm project={project('rest', { DONE: 'Done' })} />);
    const done = await dropdown('DONE');
    expect(done).toHaveValue('Done');
    expect(within(done).getAllByRole('option').map((o) => o.textContent)).toEqual(['Not mapped', 'To Do', 'In Progress', 'Done']);
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p1/jira/statuses');
    await userEvent.selectOptions(screen.getByLabelText('KB'), 'In Progress');
    expect(screen.getByLabelText('KB')).toHaveValue('In Progress');
  });

  it('flags a mapped status that does not exist in Jira, and keeps it selectable', async () => {
    fetchMock.mockResolvedValue(reply(['To Do', 'Done']));
    render(<ProjectForm project={project('rest', { IN_HUMAN_REVIEW: 'Shipped' })} />);
    const select = await dropdown('IN_HUMAN_REVIEW');
    expect(select).toHaveValue('Shipped');
    expect(within(select).getByRole('option', { name: 'Shipped (not in Jira)' })).toBeInTheDocument();
    expect(await screen.findByText(/Not a status in this Jira project: IN_HUMAN_REVIEW → "Shipped"/)).toBeInTheDocument();
  });

  it('falls back to typing, with a warning, when Jira cannot be reached', async () => {
    fetchMock.mockResolvedValue(reply({ error: 'jira_error', message: 'Jira 401: bad credentials' }, 502));
    render(<ProjectForm project={project('rest', { DONE: 'Done' })} />);
    expect(await screen.findByText(/Could not load statuses from Jira: Jira 401: bad credentials/)).toBeInTheDocument();
    const done = screen.getByLabelText('DONE');
    expect(done.tagName).toBe('INPUT');
    expect(done).toHaveValue('Done');
  });

  it('REST mode on a new project: free text with a hint to save first', async () => {
    render(<ProjectForm />);
    await userEvent.selectOptions(screen.getByLabelText('Jira mode'), 'rest');
    expect(screen.getByText(/Save the project first/)).toBeInTheDocument();
    expect(screen.getByLabelText('DONE').tagName).toBe('INPUT');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('saves the chosen mapping, sending null for rows left as Not mapped', async () => {
    fetchMock.mockImplementation(async (url: string) => (url.endsWith('/statuses') ? reply(['To Do', 'Done']) : reply(project('rest'))));
    render(<ProjectForm project={project('rest')} />);
    await userEvent.selectOptions(await dropdown('DONE'), 'Done');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'PATCH')).toBe(true));
    const patch = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PATCH') as [string, RequestInit];
    const map = JSON.parse(String(patch[1].body)).settings.jiraStatusMap;
    expect(map.DONE).toBe('Done');
    expect(map.NEW).toBeNull();
  });
});
