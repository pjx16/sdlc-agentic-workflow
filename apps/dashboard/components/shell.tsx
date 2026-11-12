import type { ReactNode } from 'react';
import { apiGet } from '@/lib/server-api';
import type { SystemView } from '@/lib/types';
import { BrandMark } from './brand-mark';
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

const DOT = { green: 'text-green', grey: 'text-grey', amber: 'text-amber' } as const;

/** Left rail plus top bar with the pipeline state and, while paused, the banner. */
export async function Shell({ children }: { children: ReactNode }) {
  const system = await apiGet<SystemView>('/system').catch(() => null);
  const label = pipelineLabel(system);
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r border-border bg-surface/80 backdrop-blur">
        <div className="flex items-center gap-3 px-5 py-5">
          <BrandMark />
          <div className="leading-tight">
            <div className="font-display text-sm font-semibold tracking-wide">SDLC AGENT</div>
            <div className="eyebrow">Control deck</div>
          </div>
        </div>
        <Nav />
        <div className="mt-auto border-t border-border px-5 py-4">
          <div className="eyebrow">Pipeline</div>
          <div className="mt-2 flex items-center gap-2 text-sm">
            <span aria-hidden className={`dot ${DOT[label.tone]} ${label.tone === 'green' ? 'pulse' : ''}`} />
            <span className="font-mono text-xs">{label.text}</span>
          </div>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-border bg-surface/60 px-8 py-3 backdrop-blur">
          <div className="eyebrow">Autonomous delivery pipeline</div>
          <LogoutButton />
        </header>
        {system?.settings.pipelinePaused && <PauseBanner reason={system.settings.pausedReason} resetsAt={system.settings.resetsAt} />}
        <main className="flex-1 p-8">{children}</main>
      </div>
    </div>
  );
}
