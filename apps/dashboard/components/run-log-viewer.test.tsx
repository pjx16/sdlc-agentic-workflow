import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunLogViewer } from './run-log-viewer';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private listeners = new Map<string, ((e: { data: string }) => void)[]>();
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  emit(data: string) {
    this.onmessage?.({ data });
  }
  emitEvent(type: string, data: string) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data });
  }
}

const latest = () => FakeEventSource.instances.at(-1) as FakeEventSource;

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});
afterEach(() => vi.unstubAllGlobals());

describe('RunLogViewer', () => {
  it('connects to the run log and shows lines live as they arrive', () => {
    render(<RunLogViewer runId="run-1" />);
    expect(latest().url).toBe('/api/runs/run-1/log');
    expect(screen.getByText('Waiting for output…')).toBeInTheDocument();
    act(() => latest().emit('{"type":"assistant","message":{"content":[{"type":"text","text":"Reading the code"}]}}'));
    expect(screen.getByText('Reading the code')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Live');
    act(() => latest().emit('plain line'));
    expect(screen.getByText('plain line')).toBeInTheDocument();
  });

  it('shows the final status and closes the stream on the end event', () => {
    render(<RunLogViewer runId="run-1" />);
    act(() => latest().emit('{"type":"result","subtype":"success","num_turns":2,"total_cost_usd":0.01}'));
    act(() => latest().emitEvent('end', 'succeeded'));
    expect(screen.getByRole('status')).toHaveTextContent('Finished (succeeded)');
    expect(screen.getByText('Result: success · 2 turns · $0.0100')).toBeInTheDocument();
    expect(latest().closed).toBe(true);
  });

  it('can show raw lines', async () => {
    render(<RunLogViewer runId="run-1" />);
    const raw = '{"type":"system","subtype":"thinking_tokens"}';
    act(() => latest().emit(raw));
    expect(screen.queryByText(raw)).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('Raw'));
    expect(screen.getByText(raw)).toBeInTheDocument();
  });

  it('offers a reconnect that restarts the log from the top instead of duplicating lines', async () => {
    render(<RunLogViewer runId="run-1" />);
    act(() => latest().emit('first'));
    act(() => latest().onerror?.());
    expect(screen.getByRole('status')).toHaveTextContent('Connection lost');
    await userEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(screen.queryByText('first')).not.toBeInTheDocument();
    act(() => latest().emit('first'));
    expect(screen.getAllByText('first')).toHaveLength(1);
  });

  it('does not report a lost connection after the run finished', () => {
    render(<RunLogViewer runId="run-1" />);
    act(() => latest().emitEvent('end', 'failed'));
    act(() => latest().onerror?.());
    expect(screen.getByRole('status')).toHaveTextContent('Finished (failed)');
  });

  it('closes the stream when it unmounts', () => {
    const { unmount } = render(<RunLogViewer runId="run-1" />);
    const source = latest();
    unmount();
    expect(source.closed).toBe(true);
  });
});
