import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { OnboardingProposal } from '@sdlc/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OnboardForm } from './onboard-form';
import { OnboardingPanel } from './onboarding-panel';
import { ProjectSummary } from './project-summary';
import type { OnboardingView, ProjectView } from '@/lib/types';
import { DEFAULT_PROJECT_SETTINGS } from '@sdlc/shared';

const push = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));

const fetchMock = vi.fn();
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
beforeEach(() => {
  fetchMock.mockReset();
  push.mockReset();
  refresh.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.useRealTimers());
const sentBody = (i = 0) => JSON.parse(String((fetchMock.mock.calls[i] as [string, RequestInit])[1].body));

describe('OnboardForm: two fields', () => {
  it('has only a repo URL and an optional Jira key, and starts the onboarding', async () => {
    fetchMock.mockResolvedValue(reply({ id: 'p9' }));
    render(<OnboardForm />);
    expect(screen.getAllByRole('textbox')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Repository URL'), 'https://github.com/acme/billing');
    await userEvent.type(screen.getByLabelText('Jira project key (optional)'), 'SDA');
    await userEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/projects/onboard');
    expect(sentBody()).toEqual({ repoUrl: 'https://github.com/acme/billing', jiraProjectKey: 'SDA' });
    expect(push).toHaveBeenCalledWith('/projects/p9');
  });

  it('shows the field errors from the server', async () => {
    fetchMock.mockResolvedValue(reply({ fields: { repoUrl: 'must be an HTTPS github.com repository URL' } }, 400));
    render(<OnboardForm />);
    await userEvent.type(screen.getByLabelText('Repository URL'), 'nope');
    await userEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(await screen.findByText('must be an HTTPS github.com repository URL')).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });
});

const proposal = (over: Partial<OnboardingProposal> = {}): OnboardingProposal => ({
  facts: {
    github: { defaultBranch: 'main', languages: ['TypeScript'] },
    jira: { projectName: 'Billing', issueTypes: [{ name: 'Story', subtask: false }, { name: 'Epic', subtask: false }], statusesByType: [], labels: [] },
    confluence: { spaces: [{ key: 'ENG', name: 'Engineering' }] },
  },
  profile: { stack: 'nestjs', installCmd: 'npm ci', typecheckCmd: 'npx tsc --noEmit', testCmdTemplate: 'npx jest {files}', kbDir: 'docs/kb', testFilePattern: '', exampleTestFile: null, baseBranch: 'main', installCheck: { command: 'npm ci', ok: true, tail: '' }, typecheckCheck: { command: 'npx tsc --noEmit', ok: false, tail: 'error TS2304' } },
  advice: { statusMap: { KB: 'In Progress' }, approvalStatuses: { plan: 'Plan Approved', breakdown: null }, issueTypeRouting: { Story: 'feature', Epic: 'ignore' }, intakeLabel: 'sdlc-agent', confluenceSpaceKey: 'ENG' },
  accepted: {},
  createdAt: '2026-11-14T10:00:00Z',
  ...over,
});
const view = (over: Partial<OnboardingView> = {}): OnboardingView => ({ status: 'proposed', error: null, proposal: proposal(), ...over });

describe('OnboardingPanel', () => {
  it('shows progress while the project is being profiled, and asks again until a proposal arrives', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchMock.mockResolvedValue(reply(view()));
    render(<OnboardingPanel projectId="p1" initial={view({ status: 'profiling', proposal: null })} />);
    expect(screen.getByRole('status')).toHaveTextContent('Reading the repository');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/projects/p1/onboarding');
    expect(await screen.findByRole('region', { name: 'Commands' })).toBeInTheDocument();
  });

  it('shows why it failed and offers to run it again', async () => {
    fetchMock.mockResolvedValue(reply(view({ status: 'profiling', proposal: null })));
    render(<OnboardingPanel projectId="p1" initial={view({ status: 'draft', proposal: null, error: 'GitHub: Not Found. Check the GitHub token' })} />);
    expect(screen.getByText(/Check the GitHub token/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Run it again' }));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/projects/p1/onboarding/rerun');
    expect(await screen.findByRole('status')).toBeInTheDocument();
  });

  it('has one card per section, with the command checks and which cards must be accepted', () => {
    render(<OnboardingPanel projectId="p1" initial={view()} />);
    for (const name of ['Commands', 'Jira statuses', 'Issue types', 'Intake label', 'Confluence']) expect(screen.getByRole('region', { name })).toBeInTheDocument();
    const commands = screen.getByRole('region', { name: 'Commands' });
    expect(within(commands).getByText('npx jest {files}')).toBeInTheDocument();
    expect(within(commands).getByText(/Install check: passed/)).toBeInTheDocument();
    expect(within(commands).getByText(/Typecheck check: failed/)).toBeInTheDocument();
    expect(within(commands).getByText('error TS2304')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Jira statuses' })).getByText('must be accepted')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Intake label' })).getByText('must be accepted')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Issue types' })).getByText('ignored')).toBeInTheDocument();
  });

  it('Confirm stays off until the status map and the label are accepted', async () => {
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => reply(view({ proposal: proposal({ accepted: { statusMap: true, label: JSON.parse(String(init.body)).action === 'accept' && String(_url).endsWith('/label') } }) })));
    render(<OnboardingPanel projectId="p1" initial={view()} />);
    const confirm = screen.getByRole('button', { name: 'Confirm the project' });
    expect(confirm).toBeDisabled();
    await userEvent.click(within(screen.getByRole('region', { name: 'Jira statuses' })).getByRole('button', { name: 'Accept' }));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/projects/p1/onboarding/sections/statusMap');
    expect(sentBody()).toEqual({ action: 'accept' });
    await userEvent.click(within(screen.getByRole('region', { name: 'Intake label' })).getByRole('button', { name: 'Accept' }));
    expect(screen.getByRole('button', { name: 'Confirm the project' })).toBeEnabled();
  });

  it('edits a section and sends the change', async () => {
    fetchMock.mockResolvedValue(reply(view()));
    render(<OnboardingPanel projectId="p1" initial={view()} />);
    const label = screen.getByRole('region', { name: 'Intake label' });
    await userEvent.click(within(label).getByRole('button', { name: 'Edit' }));
    const input = within(label).getByLabelText('Label');
    await userEvent.clear(input);
    await userEvent.type(input, 'agent-ready');
    await userEvent.click(within(label).getByRole('button', { name: 'Save and accept' }));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/projects/p1/onboarding/sections/label');
    expect(sentBody()).toEqual({ action: 'edit', value: { intakeLabel: 'agent-ready' } });
  });

  it('edits the routing as lines and sends them as a map', async () => {
    fetchMock.mockResolvedValue(reply(view()));
    render(<OnboardingPanel projectId="p1" initial={view()} />);
    const card = screen.getByRole('region', { name: 'Issue types' });
    await userEvent.click(within(card).getByRole('button', { name: 'Edit' }));
    const box = within(card).getByRole('textbox');
    await userEvent.clear(box);
    await userEvent.type(box, 'Story: bug');
    await userEvent.click(within(card).getByRole('button', { name: 'Save and accept' }));
    expect(sentBody()).toEqual({ action: 'edit', value: { issueTypeRouting: { Story: 'bug' } } });
  });

  it('shows the server error when an edit is refused', async () => {
    fetchMock.mockResolvedValue(reply({ fields: { statusMap: 'KB is not a status of this Jira project' } }, 400));
    render(<OnboardingPanel projectId="p1" initial={view()} />);
    await userEvent.click(within(screen.getByRole('region', { name: 'Jira statuses' })).getByRole('button', { name: 'Accept' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not a status of this Jira project');
  });

  it('runs the dry run and shows the count, the first tickets and the label hint', async () => {
    fetchMock.mockResolvedValue(reply({ jql: 'project = "SDA" AND labels = "sdlc-agent"', count: 0, tickets: [], note: 'Label not used yet. Add the label "sdlc-agent" to a Jira ticket to start.' }));
    render(<OnboardingPanel projectId="p1" initial={view()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Run the dry run' }));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/projects/p1/onboarding/dry-run');
    expect(await screen.findByText('0 tickets currently match.')).toBeInTheDocument();
    expect(screen.getByText(/Label not used yet/)).toBeInTheDocument();
  });

  it('confirms, shows any warning and refreshes the page', async () => {
    const accepted = proposal({ accepted: { statusMap: true, label: true } });
    fetchMock.mockResolvedValue(reply({ warnings: ['Confluence: no access. The project works without it.'] }));
    render(<OnboardingPanel projectId="p1" initial={view({ proposal: accepted })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Confirm the project' }));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/projects/p1/onboarding/confirm');
    expect(await screen.findByText(/Confluence: no access/)).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });

  it('a project without Jira needs no accepting and says it takes pasted tickets only', () => {
    const p = proposal({ facts: { github: { defaultBranch: 'main', languages: [] }, jira: null, confluence: { spaces: null, reason: 'not configured' } } });
    render(<OnboardingPanel projectId="p1" initial={view({ proposal: p })} />);
    expect(screen.getByText(/pasted tickets only/)).toBeInTheDocument();
    expect(screen.getByText(/Confluence is not available \(not configured\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm the project' })).toBeEnabled();
    expect(screen.queryByRole('region', { name: 'Jira statuses' })).not.toBeInTheDocument();
  });
});

describe('ProjectSummary', () => {
  const project = { id: 'p1', name: 'billing', repoUrl: 'https://github.com/acme/billing', baseBranch: 'main', stack: 'nestjs', jiraMode: 'rest', jiraProjectKey: 'SDA', settings: { ...DEFAULT_PROJECT_SETTINGS, jiraIssueTypeRouting: { Story: 'feature', Epic: 'ignore' }, confluence: { spaceKey: 'ENG', parentPageId: '1' } } } as unknown as ProjectView;
  it('shows what the project is, without every setting', () => {
    render(<ProjectSummary project={project} />);
    expect(screen.getByText('Jira SDA, and pasted tickets')).toBeInTheDocument();
    expect(screen.getByText('Story → feature, Epic → ignored')).toBeInTheDocument();
    expect(screen.getByText('Confluence space ENG')).toBeInTheDocument();
  });
  it('says pasted tickets only without Jira, and Jira comments without Confluence', () => {
    render(<ProjectSummary project={{ ...project, jiraMode: 'off', jiraProjectKey: undefined, settings: { ...project.settings, confluence: null, jiraIssueTypeRouting: {} } }} />);
    expect(screen.getByText('Pasted tickets only')).toBeInTheDocument();
    expect(screen.getByText('Jira comments')).toBeInTheDocument();
  });
});
