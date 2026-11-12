'use client';

import Link from 'next/link';
import { ChartFrame } from './chart-frame';

export interface TimelineRun {
  id: string;
  stage: string;
  attempt: number;
  round: number;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
}

const COLOR: Record<string, string> = {
  succeeded: 'var(--status-green)',
  failed: 'var(--status-red)',
  killed: 'var(--status-amber)',
  needs_input: 'var(--status-amber)',
  running: 'var(--accent)',
  queued: 'var(--status-grey)',
};
const label = (r: TimelineRun) => `${r.stage}${r.round > 0 ? ` r${r.round}` : ''}${r.attempt > 1 ? ` (attempt ${r.attempt})` : ''}`;
const seconds = (r: TimelineRun, now: number) => (r.startedAt ? Math.max(0, ((r.endedAt ? Date.parse(r.endedAt) : now) - Date.parse(r.startedAt)) / 1000) : 0);
const fmt = (s: number) => (s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);

/** One bar per stage run on a time axis, coloured by outcome (F17). Each bar links to the run's log. */
export function TicketTimeline({ runs, now = Date.now() }: { runs: TimelineRun[]; now?: number }) {
  const started = runs.filter((r) => r.startedAt);
  const t0 = started.length ? Math.min(...started.map((r) => Date.parse(r.startedAt as string))) : 0;
  const t1 = started.length ? Math.max(...started.map((r) => (r.endedAt ? Date.parse(r.endedAt) : now))) : 0;
  const span = Math.max(1, t1 - t0);
  return (
    <ChartFrame
      title="Timeline"
      summary={`${started.length} stage run(s) over ${fmt(span / 1000)}. Green succeeded, red failed, amber was killed or asked a question, indigo is running.`}
      empty={started.length === 0}
      emptyText="No stage has run for this ticket yet."
      table={{ columns: ['Stage', 'Outcome', 'Started', 'Duration'], rows: started.map((r) => [label(r), r.status, (r.startedAt as string).slice(0, 19).replace('T', ' '), fmt(seconds(r, now))]) }}
    >
      <ol className="space-y-1">
        {started.map((r) => {
          const left = ((Date.parse(r.startedAt as string) - t0) / span) * 100;
          const width = Math.max(0.8, (seconds(r, now) * 1000 / span) * 100);
          return (
            <li key={r.id} className="grid grid-cols-[9rem_1fr] items-center gap-2 text-xs">
              <span className="truncate text-muted">{label(r)}</span>
              <div className="relative h-4 rounded-sm" style={{ background: 'color-mix(in srgb, var(--border) 50%, transparent)' }}>
                <Link
                  href={`/runs/${r.id}`}
                  title={`${label(r)}: ${r.status}, ${fmt(seconds(r, now))}`}
                  aria-label={`${label(r)}: ${r.status}, ${fmt(seconds(r, now))}`}
                  className="absolute top-0 h-4 rounded-sm"
                  style={{ left: `${Math.min(left, 99.2)}%`, width: `${Math.min(width, 100 - Math.min(left, 99.2))}%`, background: COLOR[r.status] ?? 'var(--status-grey)' }}
                />
              </div>
            </li>
          );
        })}
      </ol>
    </ChartFrame>
  );
}
