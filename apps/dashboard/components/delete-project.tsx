'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ProjectView } from '@/lib/types';

interface Impact {
  tickets: number;
  openTickets: number;
  stageRuns: number;
  runningStage: boolean;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Permanent delete with a warning dialog: shows what goes with it and asks for the project name. */
export function DeleteProject({ project }: { project: Pick<ProjectView, 'id' | 'name'> }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function show() {
    setOpen(true);
    setTyped('');
    setError(null);
    setImpact(null);
    try {
      const res = await fetch(`/api/projects/${project.id}/delete-impact`);
      if (res.ok) setImpact((await res.json()) as Impact);
      else setError('Could not load what would be deleted.');
    } catch {
      setError('Cannot reach the server.');
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${project.id}/permanent`, { method: 'DELETE' });
      if (res.ok) {
        router.replace('/projects');
        router.refresh();
        return;
      }
      setError((await res.json().catch(() => ({}))).message ?? 'Could not delete the project.');
    } catch {
      setError('Cannot reach the server.');
    } finally {
      setBusy(false);
    }
  }

  const blocked = impact?.runningStage === true;
  return (
    <section className="mt-10 rounded-md border border-red p-6" aria-labelledby="danger-zone">
      <h2 id="danger-zone" className="text-lg font-semibold text-red">
        Delete project
      </h2>
      <p className="mt-2 text-sm text-muted">Permanently removes this project and everything the pipeline recorded for it. To only stop new tickets, untick “Project enabled” instead.</p>
      <button type="button" onClick={show} className="mt-4 rounded-md border border-red px-3 py-2 text-sm text-red">
        Delete project…
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
          <div role="dialog" aria-modal="true" aria-labelledby="delete-title" className="w-full max-w-lg panel p-6">
            <h3 id="delete-title" className="text-lg font-semibold text-red">
              Delete “{project.name}”?
            </h3>
            <p className="mt-3 text-sm">This cannot be undone. It will delete:</p>
            <ul className="mt-2 list-disc pl-5 text-sm">
              {impact ? (
                <>
                  <li>
                    {plural(impact.tickets, 'ticket')}
                    {impact.openTickets > 0 && <span className="text-amber"> ({impact.openTickets} not finished)</span>}, with their plans, subtasks, review findings, questions and history
                  </li>
                  <li>{plural(impact.stageRuns, 'stage run')} and their usage records</li>
                </>
              ) : (
                <li className="text-muted">Loading…</li>
              )}
              <li>The repository mirror and workspaces on this machine</li>
            </ul>
            <p className="mt-3 text-sm text-muted">Nothing is changed on GitHub or Jira: branches and pull requests the agent already created stay where they are.</p>
            {blocked && <p className="mt-3 text-sm text-amber">A stage of this project is running right now. Wait for it to finish or stop it from the Runs page, then delete the project.</p>}
            <label htmlFor="confirm-name" className="mt-4 block text-sm">
              Type <span className="font-mono">{project.name}</span> to confirm
            </label>
            <input
              id="confirm-name"
              autoComplete="off"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-red"
            />
            {error && (
              <p role="alert" className="mt-3 text-sm text-red">
                {error}
              </p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setOpen(false)} disabled={busy} className="rounded-md border border-border px-3 py-2 text-sm">
                Cancel
              </button>
              <button
                type="button"
                onClick={remove}
                disabled={busy || blocked || !impact || typed !== project.name}
                className="rounded-md bg-red px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {busy ? 'Deleting…' : 'Delete permanently'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
