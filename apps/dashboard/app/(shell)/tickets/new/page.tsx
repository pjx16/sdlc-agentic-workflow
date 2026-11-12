import { TicketForm } from '@/components/ticket-form';
import { apiGet } from '@/lib/server-api';
import type { ProjectView } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function NewTicketPage() {
  const projects = (await apiGet<ProjectView[]>('/projects')) ?? [];
  return (
    <section>
      <h1 className="mb-6 text-2xl font-semibold">New ticket</h1>
      <TicketForm projects={projects.map((p) => ({ id: p.id, name: p.name, mirrorStatus: p.mirrorStatus, enabled: p.enabled }))} />
    </section>
  );
}
