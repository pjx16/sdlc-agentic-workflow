'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { ProjectView } from '@/lib/types';

const POLL_MS = 3000;

/** Cloning / Ready / Failed, refreshing while the worker clones, with a retry button on failure. */
export function MirrorStatus({ project }: { project: ProjectView }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (project.mirrorStatus !== 'pending') return;
    const timer = setInterval(() => router.refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [project.mirrorStatus, router]);

  async function retry() {
    setBusy(true);
    try {
      await fetch(`/api/projects/${project.id}/mirror/retry`, { method: 'POST' });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const label = { pending: 'Cloning…', ok: 'Ready', failed: 'Failed' }[project.mirrorStatus];
  const color = { pending: 'bg-grey', ok: 'bg-green', failed: 'bg-red' }[project.mirrorStatus];

  return (
    <div className="flex flex-wrap items-center gap-3 panel p-4 text-sm">
      <span className="text-muted">Repository mirror</span>
      <span className="flex items-center gap-2" role="status">
        <span aria-hidden className={`inline-block h-2 w-2 rounded-full ${color}`} />
        {label}
      </span>
      {project.mirrorStatus === 'failed' && (
        <>
          <span className="text-red">{project.mirrorError}</span>
          <button type="button" onClick={retry} disabled={busy} className="rounded-md border border-border px-3 py-1 hover:text-text disabled:opacity-60">
            Retry
          </button>
        </>
      )}
      {project.mirrorStatus === 'pending' && <span className="text-muted">Tickets are accepted once the mirror is ready.</span>}
    </div>
  );
}
