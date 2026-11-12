import type { ReactNode } from 'react';
import { apiGet } from '@/lib/server-api';
import type { SystemView } from '@/lib/types';
import { LogoutButton } from './logout-button';
import { Nav } from './nav';
import { PauseBanner } from './pause-banner';

/** What the top bar says about the pipeline (BUILD_PLAN 6.10): `Running <stage>`, `Idle` or `Paused`. */
export function pipelineLabel(system: SystemView | null): { text: string; tone: 'green' | 'grey' | 'amber' } {
  if (!system) return { text: 'Unknown', tone: 'grey' };
  if (system.settings.pipelinePaused) return { text: 'Paused', tone: 'amber' };
  if (system.runningStage) return { text: `Running ${system.runningStage.stage}`, tone: 'green' };
  return { text: 'Idle', tone: 'grey' };
}

const DOT = { green: 'bg-green', grey: 'bg-grey', amber: 'bg-amber' } as const;

/** Left rail plus top bar with the pipeline state and, while paused, the banner. */
export async function Shell({ children }: { children: ReactNode }) {
  const system = await apiGet<SystemView>('/system').catch(() => null);
  const label = pipelineLabel(system);
  return (
    <div className="flex min-h-screen">
      <aside className="w-56 shrink-0 border-r border-border bg-surface">
        <div className="px-6 py-5 text-sm font-semibold">SDLC Agent</div>
        <Nav />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-border bg-surface px-8 py-3">
          <div className="flex items-center gap-2 text-sm text-muted">
            <span aria-hidden className={`inline-block h-2 w-2 rounded-full ${DOT[label.tone]}`} />
            <span>{label.text}</span>
          </div>
          <LogoutButton />
        </header>
        {system?.settings.pipelinePaused && <PauseBanner reason={system.settings.pausedReason} resetsAt={system.settings.resetsAt} />}
        <main className="flex-1 p-8">{children}</main>
      </div>
    </div>
  );
}
