import Link from 'next/link';
import { TICKET_STATUSES } from '@sdlc/shared';
import { StateBadge } from './state-badge';
import { formatDateTime, humanizeStatus } from '@/lib/ticket-status';
import type { TicketListItem } from '@/lib/types';

/** The states where the pipeline waits for a person, and what it waits for. */
export const ATTENTION: Record<string, string> = {
  AWAITING_PLAN_APPROVAL: 'Approve the plan',
  AWAITING_BREAKDOWN_APPROVAL: 'Approve the breakdown',
  IN_HUMAN_REVIEW: 'Review the PR',
  ON_HOLD: 'On hold',
  FAILED: 'Failed',
};

export interface Filters {
  projectId?: string;
  status?: string;
}

/** Filters are a plain GET form, so they work without client-side code and survive a reload. */
export function TicketFilters({ projects, filters }: { projects: { id: string; name: string }[]; filters: Filters }) {
  return (
    <form method="get" className="flex flex-wrap items-end gap-4" aria-label="Filters">
      <label className="text-sm">
        <span className="block text-muted">Project</span>
        <select name="project" defaultValue={filters.projectId ?? ''} className="mt-1 rounded-md border border-border bg-bg px-3 py-2 text-sm">
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm">
        <span className="block text-muted">State</span>
        <select name="status" defaultValue={filters.status ?? ''} className="mt-1 rounded-md border border-border bg-bg px-3 py-2 text-sm">
          <option value="">All states</option>
          {TICKET_STATUSES.map((s) => (
            <option key={s} value={s}>
              {humanizeStatus(s)}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="rounded-md border border-border px-3 py-2 text-sm hover:text-text">
        Apply
      </button>
      {(filters.projectId || filters.status) && (
        <Link href="/tickets" className="py-2 text-sm text-muted hover:text-text">
          Clear
        </Link>
      )}
    </form>
  );
}

export function TicketsTable({ tickets, filtered }: { tickets: TicketListItem[]; filtered: boolean }) {
  if (tickets.length === 0) {
    return <p className="mt-6 text-sm text-muted">{filtered ? 'No tickets match these filters.' : 'No tickets yet. Paste one, or let the poller pick them up from Jira.'}</p>;
  }
  return (
    <table className="mt-6 w-full text-left text-sm">
      <thead className="text-muted">
        <tr>
          <th className="py-2 font-normal">Key</th>
          <th className="py-2 font-normal">Title</th>
          <th className="py-2 font-normal">Project</th>
          <th className="py-2 font-normal">State</th>
          <th className="py-2 font-normal">Updated</th>
        </tr>
      </thead>
      <tbody>
        {tickets.map((t) => (
          <tr key={t.id} className="border-t border-border">
            <td className="py-3">
              <Link href={`/tickets/${t.id}`} className="font-mono text-accent hover:underline">
                {t.key}
              </Link>
            </td>
            <td className="py-3">{t.title}</td>
            <td className="py-3 text-muted">{t.projectName}</td>
            <td className="py-3">
              <StateBadge status={t.status} />
              {ATTENTION[t.status] && <span className="ml-2 rounded border border-amber px-1.5 py-0.5 text-xs text-amber">{ATTENTION[t.status]}</span>}
            </td>
            <td className="py-3 text-muted">{formatDateTime(t.updatedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
