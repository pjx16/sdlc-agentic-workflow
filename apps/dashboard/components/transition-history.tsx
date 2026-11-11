import { StateBadge } from './state-badge';
import { formatDateTime } from '@/lib/ticket-status';
import type { TransitionView } from '@/lib/types';

function JiraSync({ t }: { t: TransitionView }) {
  if (t.jiraSyncResult === 'applied') return <span className="text-green">Moved to “{t.jiraStatusApplied}”</span>;
  if (t.jiraSyncResult === 'failed') {
    return (
      <span role="alert" className="text-amber">
        ⚠ Jira move to “{t.jiraStatusApplied}” failed: {t.jiraSyncError}
      </span>
    );
  }
  return <span className="text-muted">—</span>;
}

/** Every state change of a ticket, oldest first, with what happened in Jira (F15). A failed Jira move is a warning only. */
export function TransitionHistory({ transitions }: { transitions: TransitionView[] }) {
  if (transitions.length === 0) return <p className="text-sm text-muted">No state changes yet.</p>;
  return (
    <table className="w-full text-left text-sm">
      <thead className="text-muted">
        <tr>
          <th className="py-2 font-normal">When</th>
          <th className="py-2 font-normal">Change</th>
          <th className="py-2 font-normal">By</th>
          <th className="py-2 font-normal">Reason</th>
          <th className="py-2 font-normal">Jira</th>
        </tr>
      </thead>
      <tbody>
        {transitions.map((t) => (
          <tr key={t.id} className="border-t border-border align-top">
            <td className="py-3 whitespace-nowrap text-muted">{formatDateTime(t.at)}</td>
            <td className="py-3">
              <span className="flex flex-wrap items-center gap-2">
                <StateBadge status={t.fromStatus} />
                <span aria-label="to">→</span>
                <StateBadge status={t.toStatus} />
              </span>
            </td>
            <td className="py-3 text-muted">{t.actor}</td>
            <td className="py-3">{t.reason ?? <span className="text-muted">—</span>}</td>
            <td className="py-3">
              <JiraSync t={t} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
