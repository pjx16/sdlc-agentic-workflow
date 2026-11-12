import Link from 'next/link';
import { formatDateTime, humanizeStatus } from '@/lib/ticket-status';
import type { MetricsRange, MetricsSummary, SystemView, TicketListItem } from '@/lib/types';
import { StateBadge } from './state-badge';

export const RANGES: MetricsRange[] = ['24h', '7d', '30d'];

export function RangeSwitch({ range, hrefFor }: { range: MetricsRange; hrefFor: (r: MetricsRange) => string }) {
  return (
    <nav aria-label="Range" className="flex gap-1 text-sm">
      {RANGES.map((r) => (
        <Link key={r} href={hrefFor(r)} aria-current={range === r ? 'true' : undefined} className={`rounded-md px-3 py-1 ${range === r ? 'bg-accent text-accent-text' : 'border border-border text-muted hover:text-text'}`}>
          {r}
        </Link>
      ))}
    </nav>
  );
}

const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);

export function NumberCards({ summary }: { summary: MetricsSummary }) {
  const cards = [
    { label: `Tickets done (${summary.range})`, value: String(summary.ticketsDone) },
    { label: 'First-pass rate', value: pct(summary.firstPassRate), hint: 'Subtasks done without a tests fix round' },
    { label: 'Tokens, last 5 hours', value: summary.tokensInWindow.toLocaleString('en-US') },
    { label: 'Queue length', value: String(summary.queueLength), hint: 'Tickets waiting for a stage' },
  ];
  return (
    <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {cards.map((c) => (
        <div key={c.label} className="rounded-lg border border-border bg-surface p-4">
          <dt className="text-xs text-muted">{c.label}</dt>
          <dd className="mt-1 text-2xl font-semibold">{c.value}</dd>
          {c.hint && <p className="mt-1 text-xs text-muted">{c.hint}</p>}
        </div>
      ))}
    </dl>
  );
}

const elapsed = (from: string | null, now: number) => {
  if (!from) return '—';
  const s = Math.max(0, Math.round((now - Date.parse(from)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

/** What the worker is doing right now (6.10). */
export function ActivityCard({ system, now }: { system: SystemView | null; now: number }) {
  const run = system?.runningStage ?? null;
  return (
    <section aria-label="Current activity" className="rounded-lg border border-border bg-surface p-4">
      <h2 className="text-sm font-medium">Current activity</h2>
      {system?.settings.pipelinePaused ? (
        <p className="mt-2 text-sm text-amber">Paused. {system.settings.pausedReason === 'manual' ? 'Paused by you.' : (system.settings.pausedReason ?? '')}</p>
      ) : run ? (
        <p className="mt-2 text-sm">
          Running <span className="font-mono">{run.stage}</span> with {run.model}, for {elapsed(run.startedAt, now)}.{' '}
          <Link href={`/runs/${run.id}`} className="text-accent hover:underline">
            Watch the log
          </Link>
          {run.ticketId && (
            <>
              {' · '}
              <Link href={`/tickets/${run.ticketId}`} className="text-accent hover:underline">
                Ticket
              </Link>
            </>
          )}
        </p>
      ) : (
        <p className="mt-2 text-sm text-muted">Idle. Nothing is running.</p>
      )}
    </section>
  );
}

/** Tickets that are waiting for a stage, oldest first (the order the worker takes them). */
export function QueueList({ tickets }: { tickets: TicketListItem[] }) {
  return (
    <section aria-label="Queue" className="rounded-lg border border-border bg-surface p-4">
      <h2 className="text-sm font-medium">Queue</h2>
      {tickets.length === 0 ? (
        <p className="mt-2 text-sm text-muted">No ticket is waiting for a stage.</p>
      ) : (
        <ol className="mt-2 divide-y divide-border text-sm">
          {tickets.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-3 py-2">
              <Link href={`/tickets/${t.id}`} className="min-w-0 truncate hover:underline">
                <span className="font-mono text-xs text-muted">{t.key}</span> {t.title}
              </Link>
              <span className="flex shrink-0 items-center gap-3">
                <StateBadge status={t.status} />
                <span className="text-xs text-muted">{formatDateTime(t.updatedAt)}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export const queueStatuses = ['NEW', 'KB', 'PLANNING', 'BREAKDOWN', 'IN_PROGRESS', 'REVIEW', 'KB_UPDATE'];
export { humanizeStatus };
