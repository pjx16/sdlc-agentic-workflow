import { notFound } from 'next/navigation';
import { DeleteProject } from '@/components/delete-project';
import { ProjectForm } from '@/components/project-form';
import { apiGet } from '@/lib/server-api';
import type { ProjectView } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await apiGet<ProjectView>(`/projects/${encodeURIComponent(id)}`);
  if (!project) notFound();
  return (
    <section>
      <h1 className="mb-6 text-2xl font-semibold">{project.name}</h1>
      <ProjectForm project={project} />
      <DeleteProject project={project} />
    </section>
  );
}
