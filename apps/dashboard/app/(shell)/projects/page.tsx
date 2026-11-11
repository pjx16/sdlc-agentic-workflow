import Link from 'next/link';
import { apiGet } from '@/lib/server-api';
import type { ProjectView } from '@/lib/types';

export const dynamic = 'force-dynamic';

const MIRROR = {
  pending: { label: 'Cloning…', color: 'bg-grey' },
  ok: { label: 'Ready', color: 'bg-green' },
  failed: { label: 'Failed', color: 'bg-red' },
} as const;

export default async function ProjectsPage() {
  const projects = (await apiGet<ProjectView[]>('/projects')) ?? [];
  return (
    <section>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Projects</h1>
        <Link href="/projects/new" className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-text">
          New project
        </Link>
      </div>
      {projects.length === 0 ? (
        <p className="mt-6 text-sm text-muted">No projects yet. Create one to start accepting tickets.</p>
      ) : (
        <table className="mt-6 w-full text-left text-sm">
          <thead className="text-muted">
            <tr>
              <th className="py-2 font-normal">Name</th>
              <th className="py-2 font-normal">Repository</th>
              <th className="py-2 font-normal">Stack</th>
              <th className="py-2 font-normal">Mirror</th>
              <th className="py-2 font-normal">State</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <tr key={p.id} className="border-t border-border">
                <td className="py-3">
                  <Link href={`/projects/${p.id}`} className="text-accent hover:underline">
                    {p.name}
                  </Link>
                </td>
                <td className="py-3 text-muted">{p.repoUrl}</td>
                <td className="py-3">{p.stack}</td>
                <td className="py-3">
                  <span className="flex items-center gap-2">
                    <span aria-hidden className={`inline-block h-2 w-2 rounded-full ${MIRROR[p.mirrorStatus].color}`} />
                    {MIRROR[p.mirrorStatus].label}
                  </span>
                </td>
                <td className="py-3 text-muted">{p.enabled ? 'Enabled' : 'Disabled'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
