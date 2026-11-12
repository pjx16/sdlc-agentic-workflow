import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SystemView } from '@/lib/types';
import { CalibrationForm } from './calibration-form';
import { PauseBanner } from './pause-banner';
import { pipelineLabel } from './shell';
import { SnapshotsTable, TokensTable } from './usage-tables';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/lib/server-api', () => ({ apiGet: vi.fn() }));
const fetchMock = vi.fn();
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  refresh.mockReset();
});

const system = (over: Record<string, unknown> = {}, running: SystemView['runningStage'] = null) =>
  ({ settings: { pipelinePaused: false, ...over }, runningStage: running, usage: null }) as unknown as SystemView;

describe('pipelineLabel', () => {
  it('says Paused, Running <stage> or Idle', () => {
    expect(pipelineLabel(system({ pipelinePaused: true }))).toEqual({ text: 'Paused', tone: 'amber' });
    expect(pipelineLabel(system({}, { id: 'r', stage: 'plan', model: 'm', projectId: 'p', ticketId: 't', startedAt: null }))).toEqual({ text: 'Running plan', tone: 'green' });
    expect(pipelineLabel(system())).toEqual({ text: 'Idle', tone: 'grey' });
    expect(pipelineLabel(null).text).toBe('Unknown');
  });
});

describe('PauseBanner (F14)', () => {
  it('shows the reason and the reset time, with Resume and Ignore', () => {
    render(<PauseBanner reason="5-hour usage is at 55% (threshold 50%)" resetsAt="2026-11-12T13:00:00Z" />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Pipeline paused.');
    expect(alert).toHaveTextContent('5-hour usage is at 55% (threshold 50%)');
    expect(alert).toHaveTextContent('2026-11-12 13:00 UTC');
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ignore usage for this window' })).toBeInTheDocument();
  });

  it('a manual pause offers only Resume', () => {
    render(<PauseBanner reason="manual" resetsAt={null} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Paused by you.');
    expect(screen.queryByRole('button', { name: /Ignore/ })).not.toBeInTheDocument();
  });

  it('Resume and Ignore call the API and refresh', async () => {
    fetchMock.mockResolvedValue(reply({}));
    render(<PauseBanner reason="x" resetsAt={null} />);
    await userEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole('button', { name: 'Ignore usage for this window' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/system/resume', '/api/system/usage/ignore']);
  });

  it('shows the server message on an error', async () => {
    fetchMock.mockResolvedValue(reply({ message: 'The pipeline is not paused' }, 409));
    render(<PauseBanner reason="x" resetsAt={null} />);
    await userEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(await screen.findByText('The pipeline is not paused')).toBeInTheDocument();
  });
});

describe('Usage page parts', () => {
  it('lists snapshots with percentages, status and source', () => {
    render(<SnapshotsTable snapshots={[{ id: '1', at: '2026-11-12T10:00:00Z', fiveHourPct: 55.04, sevenDayPct: null, status: 'rejected', resetsAt: '2026-11-12T13:00:00Z', source: 'event', windowTokens: 0 }]} />);
    expect(screen.getByText('55%')).toBeInTheDocument();
    expect(screen.getByText('rejected')).toBeInTheDocument();
    expect(screen.getByText('—', { selector: 'td' })).toBeInTheDocument();
  });
  it('explains empty tables', () => {
    render(
      <>
        <SnapshotsTable snapshots={[]} />
        <TokensTable tokens={[]} />
      </>,
    );
    expect(screen.getByText(/No usage has been recorded/)).toBeInTheDocument();
    expect(screen.getByText(/No stage has run/)).toBeInTheDocument();
  });
  it('shows tokens by stage and model', () => {
    render(<TokensTable tokens={[{ stage: 'plan', model: 'opus', tokens: 12345, runs: 3 }]} />);
    expect(screen.getByText('12,345')).toBeInTheDocument();
  });
});

describe('CalibrationForm', () => {
  it('shows the suggestion and saves it with one click', async () => {
    fetchMock.mockResolvedValue(reply({}));
    render(<CalibrationForm current={null} suggested={900000} />);
    expect(screen.getByText(/Suggested: 900,000 tokens/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Use suggestion' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/system/settings');
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({ calibratedWindowTokens: 900000 });
  });
  it('clearing the field saves null; a server error is shown', async () => {
    fetchMock.mockResolvedValue(reply({ fields: { calibratedWindowTokens: 'must be at least 1' } }, 400));
    render(<CalibrationForm current={500} suggested={null} />);
    await userEvent.clear(screen.getByLabelText('Calibrated window tokens'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('must be at least 1');
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({ calibratedWindowTokens: null });
  });
});
