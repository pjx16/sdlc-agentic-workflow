import type { ReactNode } from 'react';
import { apiGet } from '@/lib/server-api';
import type { SystemView } from '@/lib/types';
import { LogoutButton } from './logout-button';
import { Sidebar } from './sidebar';
import { PauseBanner } from './pause-banner';
import { SetupBanner } from './setup-banner';
import type { SetupStatus } from '@sdlc/shared';

/** What the top bar says about the pipeline (BUILD_PLAN 6.10): `Running <stage>`, `Idle` or `Paused`. */
export function pipelineLabel(system: SystemView | null): { text: string; tone: 'green' | 'grey' | 'amber' } {
  if (!system) return { text: 'Unknown', tone: 'grey' };
  if (system.settings.pipelinePaused) return { text: 'Paused', tone: 'amber' };
  if (system.runningStage) return { text: `Running ${system.runningStage.stage}`, tone: 'green' };
  return { text: 'Idle', tone: 'grey' };
}

/** Left rail plus top bar with the pipeline state and, while paused, the banner. */
export async function Shell({ children }: { children: ReactNode }) {
  const system = await apiGet<SystemView>('/system').catch(() => null);
  const setup = await apiGet<SetupStatus>('/setup/status').catch(() => null);
  const label = pipelineLabel(system);
  return (
    <div className="flex min-h-screen">
      <Sidebar pipeline={label} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-border bg-surface/60 px-8 py-3 backdrop-blur">
          <div className="eyebrow">Autonomous delivery pipeline</div>
          <LogoutButton />
        </header>
        {setup && !setup.ready && <SetupBanner missing={setup.missing} adminCreated={setup.adminCreated} />}
        {system?.settings.pipelinePaused && <PauseBanner reason={system.settings.pausedReason} resetsAt={system.settings.resetsAt} />}
        <main className="flex-1 p-8">{children}</main>
      </div>
    </div>
  );
}
