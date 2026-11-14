import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactVersions, artifactText } from './artifact-versions';
import { RerunPicker } from './rerun-picker';
import { RunsTable } from './runs-table';
import type { ArtifactView, MoveView, RunView } from '@/lib/types';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
const fetchMock = vi.fn();
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
beforeEach(() => {
  fetchMock.mockReset();
  refresh.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

const moves: MoveView[] = [
  { kind: 'advance', to: 'KB_UPDATE', label: 'Move on to KB_UPDATE' },
  { kind: 'rerun', to: 'KB', label: 'Rerun KB' },
  { kind: 'rerun', to: 'PLANNING', label: 'Rerun Planning' },
  { kind: 'rerun', to: 'IN_PROGRESS', label: 'Rerun Implementation' },
];

describe('RerunPicker', () => {
  it('shows nothing when there is no finished stage to go back to', () => {
    const { container } = render(<RerunPicker ticketId="t1" moves={[moves[0] as MoveView]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('offers only the rerun moves, says what each does, and what becomes stale', async () => {
    render(<RerunPicker ticketId="t1" moves={moves} />);
    await userEvent.click(screen.getByRole('button', { name: 'Rerun from here' }));
    const group = screen.getByRole('group', { name: 'Rerun' });
    expect(within(group).getAllByRole('radio')).toHaveLength(3);
    expect(within(group).getByText('Planning')).toBeInTheDocument();
    expect(within(group).getByText(/writes the plan again/)).toBeInTheDocument();
    expect(group).toHaveTextContent('Everything after this stage becomes stale');
    expect(group).toHaveTextContent('nothing is rewritten or force-pushed');
  });

  it('sends the chosen stage with the note, then refreshes', async () => {
    fetchMock.mockResolvedValue(reply({}));
    render(<RerunPicker ticketId="t1" moves={moves} />);
    await userEvent.click(screen.getByRole('button', { name: 'Rerun from here' }));
    await userEvent.click(screen.getByRole('radio', { name: /Planning/ }));
    await userEvent.type(screen.getByLabelText(/Tell the agent what to change/), 'use the existing booking repository');
    await userEvent.click(screen.getByRole('button', { name: 'Send it back' }));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/tickets/t1/rerun');
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({ stage: 'PLANNING', note: 'use the existing booking repository' });
    expect(refresh).toHaveBeenCalled();
  });

  it('defaults to the first stage, omits an empty note, and shows the reason when it is refused', async () => {
    fetchMock.mockResolvedValue(reply({ message: 'A stage is running for this ticket. Stop it first, then rerun.' }, 409));
    render(<RerunPicker ticketId="t1" moves={moves} />);
    await userEvent.click(screen.getByRole('button', { name: 'Rerun from here' }));
    await userEvent.click(screen.getByRole('button', { name: 'Send it back' }));
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({ stage: 'KB' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Stop it first');
  });

  it('cancel closes it without sending anything', async () => {
    render(<RerunPicker ticketId="t1" moves={moves} />);
    await userEvent.click(screen.getByRole('button', { name: 'Rerun from here' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('group', { name: 'Rerun' })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const run = (over: Partial<RunView>): RunView => ({ id: 'r1', stage: 'plan', model: 'opus', attempt: 1, round: 0, status: 'succeeded', startedAt: '2026-11-14T10:00:00Z', endedAt: '2026-11-14T10:05:00Z', inputTokens: 10, outputTokens: 5, costUsd: 0.1, numTurns: 3, error: null, ...over });

describe('stale runs', () => {
  it('are greyed out and marked, and a run started by a person says so', () => {
    render(<RunsTable runs={[run({ id: 'a', stage: 'plan', supersededAt: '2026-11-14T11:00:00Z' }), run({ id: 'b', stage: 'implement', trigger: 'user' }), run({ id: 'c', stage: 'review' })]} />);
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows[0]).toHaveAttribute('data-stale', 'true');
    expect(rows[0]).toHaveClass('opacity-50');
    expect(within(rows[0] as HTMLElement).getByText('stale')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('by you')).toBeInTheDocument();
    expect(rows[2]).toHaveAttribute('data-stale', 'false');
  });
});

const art = (over: Partial<ArtifactView>): ArtifactView => ({ id: 'x', stage: 'plan', version: 1, data: { planMarkdown: '## Goal\nOld' }, stale: false, supersededAt: null, stageRunId: null, createdAt: '2026-11-14T10:00:00Z', externalUrl: null, ...over });

describe('ArtifactVersions', () => {
  it('shows every version side by side, marks the current one and the stale ones', () => {
    render(<ArtifactVersions artifacts={[art({ id: 'a', version: 1, stale: true }), art({ id: 'b', version: 2, data: { planMarkdown: '## Goal\nNew' } })]} />);
    const plan = screen.getByRole('region', { name: 'Plan' });
    expect(within(plan).getAllByRole('listitem')).toHaveLength(2);
    expect(within(plan).getByText('current')).toBeInTheDocument();
    expect(within(plan).getByText('stale')).toBeInTheDocument();
    expect(plan).toHaveTextContent('2 versions');
    expect(screen.getAllByRole('listitem')[0]).toHaveAttribute('data-stale', 'true');
  });

  it('compares an older version with the current one as a diff', async () => {
    render(<ArtifactVersions artifacts={[art({ id: 'a', version: 1, stale: true }), art({ id: 'b', version: 2, data: { planMarkdown: '## Goal\nNew' } })]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Compare with the current version' }));
    const diff = screen.getByLabelText('Changes since this version');
    expect(diff).toHaveTextContent('- Old');
    expect(diff).toHaveTextContent('+ New');
  });

  it('links a plan to its Confluence page and says when nothing was produced', () => {
    const { rerender } = render(<ArtifactVersions artifacts={[art({ externalUrl: 'https://acme.atlassian.net/wiki/x' })]} />);
    expect(screen.getByRole('link', { name: 'Open in Confluence' })).toHaveAttribute('href', 'https://acme.atlassian.net/wiki/x');
    rerender(<ArtifactVersions artifacts={[]} />);
    expect(screen.getByText(/Nothing has been produced/)).toBeInTheDocument();
  });

  it('reads each kind of output as text', () => {
    expect(artifactText({ stage: 'plan', data: { planMarkdown: 'P' } })).toBe('P');
    expect(artifactText({ stage: 'breakdown', data: { subtasks: [{ seq: 1, title: 'A', description: 'd' }, { seq: 2, title: 'B' }] } })).toBe('1. A: d\n2. B');
    expect(artifactText({ stage: 'review', data: { round: 2, findings: [{ severity: 'high', file: 'a.ts', issue: 'bad' }] } })).toBe('Round 2: high a.ts: bad');
    expect(artifactText({ stage: 'review', data: { round: 1, findings: [] } })).toBe('Round 1: no findings');
    expect(artifactText({ stage: 'kb', data: { featureKey: 'bookings', docPath: 'docs/kb/bookings.md' } })).toBe('bookings (docs/kb/bookings.md)');
  });
});
