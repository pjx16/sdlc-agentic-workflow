import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BreakdownPanel } from '@/components/breakdown-panel';
import { EventTimeline } from '@/components/event-timeline';
import { HoldPanel } from '@/components/hold-panel';
import { PlanPanel } from '@/components/plan-panel';
import { TicketTimeline } from '@/components/charts/ticket-timeline';
import { RunsTable } from '@/components/runs-table';
import { TicketActions } from '@/components/ticket-actions';
import { StateBadge } from '@/components/state-badge';
import { TransitionHistory } from '@/components/transition-history';
import { apiGet } from '@/lib/server-api';
import { formatDateTime, humanizeStatus } from '@/lib/ticket-status';
import type { HoldInfo, TicketEventView, TicketFull, TransitionView } from '@/lib/types';

export const dynamic = 'force-dynamic';

const TABS = [
  { id: 'plan', label: 'Plan' },
  { id: 'breakdown', label: 'Breakdown' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'history', label: 'History' },
  { id: 'runs', label: 'Runs' },
] as const;

export default async function TicketPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { id } = await params;
  const { tab } = await searchParams;
  const ticket = await apiGet<TicketFull>(`/tickets/${encodeURIComponent(id)}`);
  if (!ticket) notFound();
  // A ticket waiting at a gate opens on that gate; otherwise on its history.
  const active = tab === 'runs' || tab === 'plan' || tab === 'breakdown' || tab === 'history' || tab === 'timeline' ? tab : ticket.status === 'AWAITING_PLAN_APPROVAL' ? 'plan' : ticket.status === 'AWAITING_BREAKDOWN_APPROVAL' ? 'breakdown' : 'timeline';
  const stopped = ticket.status === 'ON_HOLD' || ticket.status === 'FAILED';
  const hold = stopped ? await apiGet<HoldInfo>(`/tickets/${encodeURIComponent(id)}/hold`).catch(() => null) : null;
  const events = active === 'timeline' ? ((await apiGet<TicketEventView[]>(`/tickets/${encodeURIComponent(id)}/events`)) ?? []) : [];
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
      {hold ? <HoldPanel ticketId={ticket.id} info={hold} /> : <TicketActions ticketId={ticket.id} status={ticket.status} />}
      {ticket.body && <pre className="mt-6 whitespace-pre-wrap panel p-4 font-sans text-sm">{ticket.body}</pre>}

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
        {active === 'timeline' && <EventTimeline events={events} runs={ticket.stageRuns} />}
        {active === 'history' && <TransitionHistory transitions={transitions} />}
        {active === 'runs' && (
          <div className="space-y-6">
            <TicketTimeline runs={ticket.stageRuns} />
            <RunsTable runs={ticket.stageRuns} />
          </div>
        )}
      </div>
    </section>
  );
}
