import Link from 'next/link';
import { KillRunButton } from './kill-run-button';
import { formatDateTime, formatDuration } from '@/lib/ticket-status';
import type { RunView } from '@/lib/types';
import { ErrorNote } from './error-note';

/** The stage runs of a ticket; each links to its live or finished log. */
export function RunsTable({ runs }: { runs: RunView[] }) {
  if (runs.length === 0) return <p className="text-sm text-muted">No stage has run for this ticket yet.</p>;
  return (
    <table className="w-full text-left text-sm">
      <thead className="text-muted">
        <tr>
          <th className="py-2 font-normal">Stage</th>
          <th className="py-2 font-normal">Attempt</th>
          <th className="py-2 font-normal">Outcome</th>
          <th className="py-2 font-normal">Started</th>
          <th className="py-2 font-normal">Duration</th>
          <th className="py-2 font-normal">Tokens</th>
          <th className="py-2 font-normal">Log</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => (
          <tr key={r.id} data-stale={Boolean(r.supersededAt)} className={`border-t border-border align-top ${r.supersededAt ? 'opacity-50' : ''}`}>
            <td className="py-3">
              {r.stage}
              {r.supersededAt && <span className="ml-2 rounded border border-border px-1 text-xs text-muted">stale</span>}
              {r.trigger === 'user' && <span className="ml-2 rounded border border-border px-1 text-xs text-muted">by you</span>}
            </td>
            <td className="py-3">{r.attempt}</td>
            <td className="py-3">
              {r.status}
              {r.status === 'running' && (
                <>
                  {' '}
                  <KillRunButton runId={r.id} />
                </>
              )}
              {r.error && <ErrorNote code={r.errorCode} message={r.error} retryAt={r.retryAt} />}
            </td>
            <td className="py-3 text-muted">{formatDateTime(r.startedAt)}</td>
            <td className="py-3 text-muted">{formatDuration(r.startedAt, r.endedAt)}</td>
            <td className="py-3 text-muted">{(r.inputTokens + r.outputTokens).toLocaleString('en-US')}</td>
            <td className="py-3">
              <Link href={`/runs/${r.id}`} className="text-accent hover:underline">
                View
              </Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
