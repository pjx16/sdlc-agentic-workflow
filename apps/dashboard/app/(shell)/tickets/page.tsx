import Link from 'next/link';
import { TicketFilters, TicketsTable } from '@/components/tickets-table';
import { apiGet } from '@/lib/server-api';
import type { ProjectView, TicketListItem } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function TicketsPage({ searchParams }: { searchParams: Promise<{ project?: string; status?: string }> }) {
  const { project, status } = await searchParams;
  const query = new URLSearchParams();
  if (project) query.set('projectId', project);
  if (status) query.set('status', status);
  const [tickets, projects] = await Promise.all([
    apiGet<TicketListItem[]>(`/tickets${query.size > 0 ? `?${query}` : ''}`).then((r) => r ?? []),
    apiGet<ProjectView[]>('/projects').then((r) => r ?? []),
  ]);
  return (
    <section>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Tickets</h1>
        <Link href="/tickets/new" className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-text">
          New ticket
        </Link>
      </div>
      <div className="mt-6">
        <TicketFilters projects={projects.map((p) => ({ id: p.id, name: p.name }))} filters={{ projectId: project, status }} />
      </div>
      <TicketsTable tickets={tickets} filtered={Boolean(project || status)} />
    </section>
  );
}
