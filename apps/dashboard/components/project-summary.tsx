import type { ProjectView } from '@/lib/types';

/** What a confirmed project is, at a glance. Everything else is under Advanced settings. */
export function ProjectSummary({ project }: { project: ProjectView }) {
  const routing = Object.entries(project.settings.jiraIssueTypeRouting ?? {});
  return (
    <div className="panel p-4 text-sm">
      <dl className="grid grid-cols-[auto,1fr] gap-x-6 gap-y-1">
        <dt className="text-muted">Repository</dt>
        <dd>{project.repoUrl}</dd>
        <dt className="text-muted">Branch</dt>
        <dd className="font-mono text-xs">{project.baseBranch}</dd>
        <dt className="text-muted">Stack</dt>
        <dd>{project.stack}</dd>
        <dt className="text-muted">Tickets</dt>
        <dd>{project.jiraMode === 'rest' && project.jiraProjectKey ? `Jira ${project.jiraProjectKey}, and pasted tickets` : 'Pasted tickets only'}</dd>
        {routing.length > 0 && (
          <>
            <dt className="text-muted">Issue types</dt>
            <dd>{routing.map(([t, k]) => `${t} → ${k === 'ignore' ? 'ignored' : k}`).join(', ')}</dd>
          </>
        )}
        <dt className="text-muted">Plans</dt>
        <dd>{project.settings.confluence ? `Confluence space ${project.settings.confluence.spaceKey}` : 'Jira comments'}</dd>
      </dl>
    </div>
  );
}
