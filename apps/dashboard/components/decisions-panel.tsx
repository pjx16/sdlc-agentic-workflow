import { formatDateTime } from '@/lib/ticket-status';
import type { DecisionView } from '@/lib/types';

/** What the orchestrator was asked at each decision point of a ticket: the options, its choice, and why (BUILD_PLAN v1 6.11). */
export function DecisionsPanel({ decisions }: { decisions: DecisionView[] }) {
  if (decisions.length === 0) return <p className="text-sm text-muted">The orchestrator has not been asked anything for this ticket. It is only called where several moves are possible.</p>;
  return (
    <ol className="space-y-3" aria-label="Orchestrator decisions">
      {decisions.map((d) => (
        <li key={d.id} className="panel p-4" data-fallback={d.fallbackUsed}>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <span>{formatDateTime(d.at)}</span>
            {d.model && <span>{d.model}</span>}
            <span>${d.costUsd.toFixed(4)}</span>
            {d.fallbackUsed && <span className="rounded border border-border px-1.5 py-0.5 text-amber">default used</span>}
          </div>
          <p className="mt-2 text-sm font-medium">{d.question}</p>
          <ul className="mt-2 space-y-1 text-sm">
            {d.options.map((o) => {
              const picked = d.chosen === `${o.kind} ${o.to}`;
              return (
                <li key={`${o.kind}-${o.to}`} aria-current={picked ? 'true' : undefined} className={picked ? 'font-medium text-green' : 'text-muted'}>
                  {picked ? '✓ ' : '· '}
                  {o.label}
                </li>
              );
            })}
          </ul>
          {d.reason && <p className="mt-2 text-sm">{d.reason}</p>}
        </li>
      ))}
    </ol>
  );
}
