import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstallAppButton } from './install-app-button';

const matchMedia = (standalone: boolean) => vi.fn().mockReturnValue({ matches: standalone, addEventListener: () => undefined, removeEventListener: () => undefined });

function fakePrompt() {
  const e = new Event('beforeinstallprompt', { cancelable: true }) as Event & { prompt: () => Promise<void> };
  e.prompt = vi.fn().mockResolvedValue(undefined);
  return e;
}

afterEach(() => vi.unstubAllGlobals());

describe('InstallAppButton', () => {
  it('is hidden by default', () => {
    vi.stubGlobal('matchMedia', matchMedia(false));
    render(<InstallAppButton />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('appears after beforeinstallprompt, prompts on click, and hides on appinstalled', async () => {
    vi.stubGlobal('matchMedia', matchMedia(false));
    render(<InstallAppButton />);
    const e = fakePrompt();
    act(() => void window.dispatchEvent(e));
    expect(e.defaultPrevented).toBe(true);
    const button = await screen.findByRole('button', { name: /install app/i });
    act(() => button.click());
    expect(e.prompt).toHaveBeenCalledOnce();
    act(() => void window.dispatchEvent(new Event('appinstalled')));
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('stays hidden in standalone mode (already installed)', () => {
    vi.stubGlobal('matchMedia', matchMedia(true));
    render(<InstallAppButton />);
    act(() => void window.dispatchEvent(fakePrompt()));
    expect(screen.queryByRole('button')).toBeNull();
  });
});
