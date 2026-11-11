import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BreakdownPanel } from '@/components/breakdown-panel';
import { PlanPanel } from '@/components/plan-panel';
import { RunsTable } from '@/components/runs-table';
import { StateBadge } from '@/components/state-badge';
import { TransitionHistory } from '@/components/transition-history';
import { apiGet } from '@/lib/server-api';
import { formatDateTime, humanizeStatus } from '@/lib/ticket-status';
import type { TicketFull, TransitionView } from '@/lib/types';

export const dynamic = 'force-dynamic';

const TABS = [
  { id: 'plan', label: 'Plan' },
  { id: 'breakdown', label: 'Breakdown' },
  { id: 'history', label: 'History' },
  { id: 'runs', label: 'Runs' },
] as const;

export default async function TicketPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { id } = await params;
  const { tab } = await searchParams;
  const ticket = await apiGet<TicketFull>(`/tickets/${encodeURIComponent(id)}`);
  if (!ticket) notFound();
  // A ticket waiting at a gate opens on that gate; otherwise on its history.
  const active = tab === 'runs' || tab === 'plan' || tab === 'breakdown' || tab === 'history' ? tab : ticket.status === 'AWAITING_PLAN_APPROVAL' ? 'plan' : ticket.status === 'AWAITING_BREAKDOWN_APPROVAL' ? 'breakdown' : 'history';
  const transitions = active === 'history' ? ((await apiGet<TransitionView[]>(`/tickets/${encodeURIComponent(id)}/transitions`)) ?? []) : [];

  return (
    <section>
      <p className="font-mono text-xs text-muted">
        {ticket.key} · {ticket.projectName} · {ticket.source === 'jira' ? 'from Jira' : 'pasted'}
      </p>
      <h1 className="mt-1 text-xl font-semibold">{ticket.title}</h1>
      <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
        <StateBadge status={ticket.status} />
        {ticket.status === 'ON_HOLD' && ticket.holdReason && (
          <span className="text-amber">
            On hold: {humanizeStatus(ticket.holdReason)}
            {ticket.holdFromStatus ? ` (was ${humanizeStatus(ticket.holdFromStatus)})` : ''}
          </span>
        )}
        <span className="text-muted">Updated {formatDateTime(ticket.updatedAt)}</span>
      </div>
      {ticket.body && <pre className="mt-6 whitespace-pre-wrap rounded-lg border border-border bg-surface p-4 font-sans text-sm">{ticket.body}</pre>}

      <nav aria-label="Ticket sections" className="mt-8 flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <Link
            key={t.id}
            href={`/tickets/${ticket.id}?tab=${t.id}`}
            aria-current={active === t.id ? 'page' : undefined}
            className={`-mb-px border-b-2 px-4 py-2 text-sm ${active === t.id ? 'border-accent text-text' : 'border-transparent text-muted hover:text-text'}`}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      <div className="mt-6">
        {active === 'plan' && <PlanPanel ticketId={ticket.id} status={ticket.status} planMarkdown={ticket.planMarkdown} />}
        {active === 'breakdown' && <BreakdownPanel key={ticket.updatedAt} ticketId={ticket.id} status={ticket.status} draft={ticket.breakdownDraft} subtasks={ticket.subtasks} maxSubtasks={ticket.maxSubtasks} />}
        {active === 'history' && <TransitionHistory transitions={transitions} />}
        {active === 'runs' && <RunsTable runs={ticket.stageRuns} />}
      </div>
    </section>
  );
}
