import type { ReactNode } from 'react';
import { LogoutButton } from './logout-button';
import { Nav } from './nav';

/** Left rail plus top bar. The pipeline state is a static "Idle" until the worker exists (milestone 4). */
export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <aside className="w-56 shrink-0 border-r border-border bg-surface">
        <div className="px-6 py-5 text-sm font-semibold">SDLC Agent</div>
        <Nav />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-border bg-surface px-8 py-3">
          <div className="flex items-center gap-2 text-sm text-muted">
            <span aria-hidden className="inline-block h-2 w-2 rounded-full bg-grey" />
            <span>Idle</span>
          </div>
          <LogoutButton />
        </header>
        <main className="flex-1 p-8">{children}</main>
      </div>
    </div>
  );
}
