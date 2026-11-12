import Link from 'next/link';
import { type Tone, ago, describeActivity } from '@/lib/activity';
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
        <div key={c.label} className="panel p-4">
          <dt className="eyebrow">{c.label}</dt>
          <dd className="mt-2 font-mono text-3xl font-medium tracking-tight">{c.value}</dd>
          {c.hint && <p className="mt-1 text-xs text-muted">{c.hint}</p>}
        </div>
      ))}
    </dl>
  );
}

const TONE: Record<Tone, string> = { green: 'bg-green', amber: 'bg-amber', red: 'bg-red', grey: 'bg-grey' };

/** What the worker is doing right now: is it alive, what the pipeline is doing, what Jira intake last did, and recent events. */
export function ActivityCard({ system, now }: { system: SystemView | null; now: number }) {
  const lines = describeActivity(system, now);
  const events = system?.recentEvents ?? [];
  return (
    <section aria-label="Current activity" className="panel p-4">
      <h2 className="text-sm font-medium">Activity</h2>
      <dl className="mt-3 space-y-2 text-sm">
        {lines.map((l) => (
          <div key={l.key} className="flex gap-3" data-testid={`activity-${l.key}`}>
            <dt className="flex w-36 shrink-0 items-center gap-2 text-muted">
              <span aria-hidden className={`inline-block h-2 w-2 rounded-full ${TONE[l.tone]}`} />
              {l.label}
            </dt>
            <dd className={l.tone === 'red' ? 'text-red' : ''}>
              {l.text}
              {l.link && (
                <>
                  {' '}
                  <Link href={l.link.href} className="text-accent hover:underline">
                    {l.link.text}
                  </Link>
                </>
              )}
            </dd>
          </div>
        ))}
      </dl>
      {events.length > 0 && (
        <div className="mt-4 border-t border-border pt-3">
          <h3 className="text-xs font-medium text-muted">Recent events</h3>
          <ul className="mt-2 space-y-1 text-xs">
            {events.map((e) => (
              <li key={e.id} className="flex gap-3">
                <span className="w-24 shrink-0 text-muted">{ago(e.at, now)}</span>
                <span className="min-w-0">
                  {e.ticketKey && e.ticketId && (
                    <Link href={`/tickets/${e.ticketId}`} className="mr-1 text-accent hover:underline">
                      {e.ticketKey}
                    </Link>
                  )}
                  {e.message}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** Tickets that are waiting for a stage, oldest first (the order the worker takes them). */
export function QueueList({ tickets }: { tickets: TicketListItem[] }) {
  return (
    <section aria-label="Queue" className="panel p-4">
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
