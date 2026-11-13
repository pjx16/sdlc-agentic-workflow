import { notFound } from 'next/navigation';
import { AutoRefresh } from '@/components/auto-refresh';
import { DeleteProject } from '@/components/delete-project';
import { OnboardingPanel } from '@/components/onboarding-panel';
import { ProjectForm } from '@/components/project-form';
import { ProjectSummary } from '@/components/project-summary';
import { apiGet } from '@/lib/server-api';
import type { OnboardingView, ProjectView } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await apiGet<ProjectView>(`/projects/${encodeURIComponent(id)}`);
  if (!project) notFound();
  const confirmed = (project.onboardingStatus ?? 'confirmed') === 'confirmed';
  const onboarding = confirmed ? null : await apiGet<OnboardingView>(`/projects/${encodeURIComponent(id)}/onboarding`);
  return (
    <section>
      {!confirmed && <AutoRefresh />}
      <h1 className="mb-6 text-2xl font-semibold">{project.name}</h1>
      {onboarding ? (
        <OnboardingPanel projectId={project.id} initial={onboarding} />
      ) : (
        <>
          <ProjectSummary project={project} />
          {/* After onboarding only the settings people rarely touch are left, so they sit under Advanced. */}
          <details className="mt-6 rounded-md border border-border">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium">Advanced settings</summary>
            <div className="border-t border-border p-4">
              <ProjectForm project={project} />
            </div>
          </details>
        </>
      )}
      <DeleteProject project={project} />
    </section>
  );
}
