import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from './sidebar';

vi.mock('next/navigation', () => ({ usePathname: () => '/tickets' }));

describe('Sidebar', () => {
  beforeEach(() => window.localStorage.clear());

  it('shows the labelled links with the current one marked, and the pipeline state', () => {
    render(<Sidebar pipeline={{ text: 'Running plan', tone: 'green' }} />);
    expect(screen.getByRole('link', { name: 'Tickets' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
    expect(screen.getByText('Running plan')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('collapses to icons, keeps every link reachable by name, and remembers the choice', async () => {
    const { unmount } = render(<Sidebar pipeline={{ text: 'Idle', tone: 'grey' }} />);
    await userEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toHaveAttribute('aria-expanded', 'false');
    for (const name of ['Overview', 'Tickets', 'Support', 'Projects', 'Guidelines', 'Usage', 'Settings']) {
      expect(screen.getByRole('link', { name })).toHaveAttribute('title', name);
    }
    expect(screen.queryByText('Control deck')).not.toBeInTheDocument();
    expect(window.localStorage.getItem('sdlc.sidebar.collapsed')).toBe('1');
    unmount();

    render(<Sidebar pipeline={{ text: 'Idle', tone: 'grey' }} />);
    expect(await screen.findByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();
  });

  it('works when storage is blocked', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    render(<Sidebar pipeline={{ text: 'Idle', tone: 'grey' }} />);
    await userEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();
    vi.restoreAllMocks();
  });
});
