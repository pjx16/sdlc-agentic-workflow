'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { type HoldAction, holdGuidance } from '@/lib/hold-guidance';
import type { HoldInfo } from '@/lib/types';

/** Explains why a ticket is on hold or failed, lists the steps to keep it moving, and offers the actions that apply. */
export function HoldPanel({ ticketId, info }: { ticketId: string; info: HoldInfo }) {
  const router = useRouter();
  const guidance = holdGuidance(info);
  const [busy, setBusy] = useState<HoldAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [redoOpen, setRedoOpen] = useState(false);
  const [note, setNote] = useState('');

  async function run(action: HoldAction) {
    setBusy(action);
    setError(null);
    try {
      // "Redo tests" is the rerun of one subtask's tests (BUILD_PLAN v1 6.8); resume and retry are plain actions.
      const url = action === 'redo-tests' ? `/api/tickets/${encodeURIComponent(ticketId)}/subtasks/${info.subtask?.seq ?? 1}/rerun` : `/api/tickets/${encodeURIComponent(ticketId)}/${action}`;
      const res = await fetch(url, {
        method: 'POST',
        ...(action === 'redo-tests' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ part: 'tests', note: note.trim() || undefined }) } : {}),
      });
      if (res.ok) {
        setRedoOpen(false);
        setNote('');
        router.refresh();
        return;
      }
      setError((await res.json().catch(() => ({}))).message ?? 'Something went wrong.');
      if (res.status === 409) router.refresh();
    } catch {
      setError('Cannot reach the server.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-label="Why this ticket is stopped" className="mt-4 rounded-md border border-amber bg-surface p-5">
      <h2 className="text-base font-semibold text-amber">{guidance.title}</h2>

      <h3 className="mt-3 text-xs font-medium uppercase tracking-wide text-muted">What happened</h3>
      <p className="mt-1 text-sm">{guidance.happened}</p>
      {guidance.detail && (
        <blockquote className="mt-2 whitespace-pre-wrap rounded-md border-l-2 border-border bg-bg px-3 py-2 text-sm text-muted" data-testid="hold-detail">
          {guidance.detail}
        </blockquote>
      )}

      <h3 className="mt-4 text-xs font-medium uppercase tracking-wide text-muted">What to do</h3>
      <ol className="mt-1 list-decimal space-y-1.5 pl-5 text-sm">
        {guidance.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      {guidance.links.length > 0 && (
        <p className="mt-2 flex flex-wrap gap-x-4 text-sm">
          {guidance.links.map((l) => (
            <Link key={l.href} href={l.href} className="text-accent hover:underline">
              {l.text}
            </Link>
          ))}
        </p>
      )}

      {guidance.actions.length > 0 && (
        <div className="mt-4 space-y-3">
          {guidance.actions.map((a, i) => (
            <div key={a.id} className="flex flex-wrap items-start gap-3">
              <button
                type="button"
                onClick={() => (a.id === 'redo-tests' ? setRedoOpen((v) => !v) : run(a.id))}
                disabled={busy !== null}
                className={`w-28 shrink-0 rounded-md px-3 py-1.5 text-sm disabled:opacity-50 ${i === 0 ? 'bg-accent font-medium text-accent-text' : 'border border-border'}`}
              >
                {busy === a.id ? 'Working…' : a.label}
              </button>
              <p className="min-w-0 flex-1 pt-1.5 text-xs text-muted">{a.description}</p>
            </div>
          ))}
        </div>
      )}

      {redoOpen && (
        <div role="group" aria-label="Redo tests" className="mt-4 rounded-md border border-border bg-bg p-4">
          <p className="text-sm">This throws away the tests and the code written so far for this subtask and starts it again at the tests stage. Commits made after the tests are never touched.</p>
          <label htmlFor="redo-note" className="mt-3 block text-sm">
            Tell the agent what to change <span className="text-muted">(optional)</span>
          </label>
          <textarea
            id="redo-note"
            rows={3}
            value={note}
            maxLength={2000}
            onChange={(e) => setNote(e.target.value)}
            placeholder="For example: accept both `export const` and `export function`"
            className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
          />
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={() => run('redo-tests')} disabled={busy !== null} className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-text disabled:opacity-50">
              {busy === 'redo-tests' ? 'Working…' : 'Discard and redo the tests'}
            </button>
            <button type="button" onClick={() => setRedoOpen(false)} disabled={busy !== null} className="rounded-md border border-border px-3 py-1.5 text-sm">
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 text-sm text-red">
          {error}
        </p>
      )}
    </section>
  );
}
