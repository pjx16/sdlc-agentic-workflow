import { STAGE_NAMES } from '@sdlc/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { collapseListErrors } from '@/lib/form';
import type { GlobalSettingsView } from '@/lib/types';
import { SettingsForm } from './settings-form';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));
const fetchMock = vi.fn();
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });

const settings: GlobalSettingsView = {
  usageThresholdPct: 50, usageThresholdWeeklyPct: 80, calibratedWindowTokens: null, pollIntervalSec: 120, stageTimeoutMin: 20,
  verifyTimeoutSec: 600, workspaceRetentionDays: 7, logRetentionDays: 30, assistantTokenCap: 200000,
  stageDefaults: Object.fromEntries(STAGE_NAMES.map((st) => [st, { model: 'sonnet' as const, maxTurns: 10 }])),
  modelAliases: { haiku: 'haiku', sonnet: 'sonnet', opus: 'opus' },
  pipelinePaused: false, pausedReason: null, resetsAt: null, usageIgnoredUntil: null, intakePaused: false,
};

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  refresh.mockReset();
});

describe('SettingsForm', () => {
  it('shows the current values', () => {
    render(<SettingsForm settings={settings} />);
    expect(screen.getByLabelText('5-hour threshold (%)')).toHaveValue('50');
    expect(screen.getByLabelText('Calibrated window tokens')).toHaveValue('');
    expect(screen.getByLabelText('opus')).toHaveValue('opus');
    expect(screen.queryByLabelText('Read tools')).not.toBeInTheDocument();
  });

  it('saves edits as numbers and confirms', async () => {
    fetchMock.mockResolvedValue(reply({ ...settings, usageThresholdPct: 40, calibratedWindowTokens: 5000000 }));
    render(<SettingsForm settings={settings} />);
    await userEvent.clear(screen.getByLabelText('5-hour threshold (%)'));
    await userEvent.type(screen.getByLabelText('5-hour threshold (%)'), '40');
    await userEvent.type(screen.getByLabelText('Calibrated window tokens'), '5000000');
    await userEvent.clear(screen.getByLabelText('opus'));
    await userEvent.type(screen.getByLabelText('opus'), 'claude-opus-5-5');
    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText(/Saved\. Changes apply from the next stage run/)).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/system/settings');
    expect(init.method).toBe('PATCH');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ usageThresholdPct: 40, calibratedWindowTokens: 5000000, pollIntervalSec: 120, modelAliases: { opus: 'claude-opus-5-5' } });
    expect(body).not.toHaveProperty('jiraMcp');
    expect(screen.getByLabelText('5-hour threshold (%)')).toHaveValue('40');
    expect(refresh).toHaveBeenCalled();
  });

  it('sends null for an emptied calibration and for blank numbers', async () => {
    fetchMock.mockResolvedValue(reply(settings));
    render(<SettingsForm settings={{ ...settings, calibratedWindowTokens: 100 }} />);
    await userEvent.clear(screen.getByLabelText('Calibrated window tokens'));
    await userEvent.clear(screen.getByLabelText('Poll interval (seconds)'));
    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.calibratedWindowTokens).toBeNull();
    expect(body.pollIntervalSec).toBeNull();
  });

  it('has a default model and turn limit for every stage, and sends them as numbers', async () => {
    fetchMock.mockResolvedValue(reply({ ...settings }));
    render(<SettingsForm settings={settings} />);
    expect(screen.getByLabelText('Solution architect: model')).toHaveValue('sonnet');
    expect(screen.getByLabelText('Assistant: turns')).toHaveValue('10');
    await userEvent.selectOptions(screen.getByLabelText('Solution architect: model'), 'opus');
    await userEvent.clear(screen.getByLabelText('Solution architect: turns'));
    await userEvent.type(screen.getByLabelText('Solution architect: turns'), '20');
    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.stageDefaults.solutionDesign).toEqual({ model: 'opus', maxTurns: 20 });
    expect(body.stageDefaults.implement).toEqual({ model: 'sonnet', maxTurns: 10 });
  });

  it('shows field-level errors', async () => {
    fetchMock.mockResolvedValue(
      reply({ error: 'validation_error', message: 'Validation failed', fields: { usageThresholdPct: 'must be at least 1', 'modelAliases.haiku': 'required', } }, 400),
    );
    render(<SettingsForm settings={settings} />);
    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('must be at least 1')).toBeInTheDocument();
    expect(screen.getByLabelText('haiku')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByText(/Saved/)).not.toBeInTheDocument();
  });
});

describe('collapseListErrors', () => {
  it('folds item errors onto the list path and leaves others alone', () => {
    expect(collapseListErrors({ 'a.0': 'x', 'a.2': 'y', b: 'z', 'c.1': 'w' }, ['a'])).toEqual({ a: 'line 1: x; line 3: y', b: 'z', 'c.1': 'w' });
  });
});
