import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RunControls } from './run-controls';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
  refresh.mockReset();
});

describe('RunControls', () => {
  it('pauses intake and the pipeline with the right endpoints, refreshing after each', async () => {
    render(<RunControls pipelinePaused={false} intakePaused={false} />);
    await userEvent.click(screen.getByRole('button', { name: 'Pause intake' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/system/intake/pause', expect.objectContaining({ method: 'POST' })));
    await userEvent.click(screen.getByRole('button', { name: 'Pause pipeline' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/system/pause', expect.objectContaining({ method: 'POST' })));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('shows Resume buttons while paused and calls the resume endpoints', async () => {
    render(<RunControls pipelinePaused intakePaused />);
    await userEvent.click(screen.getByRole('button', { name: 'Resume intake' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/system/intake/resume', expect.anything()));
    await userEvent.click(screen.getByRole('button', { name: 'Resume pipeline' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/system/resume', expect.anything()));
  });

  it('shows the server error', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({ message: 'nope' }) });
    render(<RunControls pipelinePaused={false} intakePaused={false} />);
    await userEvent.click(screen.getByRole('button', { name: 'Pause pipeline' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('nope');
  });
});
