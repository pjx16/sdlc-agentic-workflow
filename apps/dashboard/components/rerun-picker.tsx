'use client';

import { STATE_LABEL, type TicketStatus } from '@sdlc/shared';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { MoveView } from '@/lib/types';

const READS: Partial<Record<TicketStatus, string>> = {
  KB: 'finds or writes the knowledge-base doc again',
  PLANNING: 'writes the plan again',
  BREAKDOWN: 'splits the plan into subtasks again (the current subtasks are removed)',
  IN_PROGRESS: 'does the implementation again from the first subtask',
  REVIEW: 'reviews the code again',
  KB_UPDATE: 'updates the knowledge-base doc again',
};

/**
 * "Rerun from here" (BUILD_PLAN v1 6.8): send the ticket back to a stage that already finished, with a note. Everything after that
 * stage becomes stale, and the code it wrote is removed with a revert commit. Nothing is deleted.
 */
export function RerunPicker({ ticketId, moves }: { ticketId: string; moves: MoveView[] }) {
  const router = useRouter();
  const targets = moves.filter((m) => m.kind === 'rerun');
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<string>('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (targets.length === 0) return null;
  const chosen = stage || (targets[0]?.to ?? '');

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/tickets/${encodeURIComponent(ticketId)}/rerun`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stage: chosen, note: note.trim() || undefined }) });
      if (res.ok) {
        setOpen(false);
        setNote('');
        router.refresh();
        return;
      }
      const body = await res.json().catch(() => ({}));
      setError(body.message ?? 'Something went wrong.');
      if (res.status === 409) router.refresh();
    } catch {
      setError('Cannot reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="rounded-md border border-border px-3 py-1.5 text-sm font-medium">
        Rerun from here
      </button>
      {open && (
        <div role="group" aria-label="Rerun" className="mt-3 rounded-md border border-border bg-bg p-4">
          <fieldset>
            <legend className="text-sm font-medium">Send the ticket back to</legend>
            <div className="mt-2 space-y-1">
              {targets.map((m) => (
                <label key={m.to} className="flex items-start gap-2 text-sm">
                  <input type="radio" name={`rerun-${ticketId}`} value={m.to} checked={chosen === m.to} onChange={() => setStage(m.to)} className="mt-1" />
                  <span>
                    <span className="font-medium">{STATE_LABEL[m.to as TicketStatus] ?? m.to}</span>
                    <span className="block text-xs text-muted">The agent {READS[m.to as TicketStatus] ?? 'runs again'}.</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <p className="mt-3 text-xs text-muted">Everything after this stage becomes stale: it stays on record, greyed out. The code it wrote is removed with a revert commit; nothing is rewritten or force-pushed.</p>
          <label htmlFor={`rerun-note-${ticketId}`} className="mt-3 block text-sm">
            Tell the agent what to change (optional)
          </label>
          <textarea id={`rerun-note-${ticketId}`} rows={3} value={note} onChange={(e) => setNote(e.target.value)} className="mt-1 w-full rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent" />
          {error && (
            <p role="alert" className="mt-2 text-xs text-red">
              {error}
            </p>
          )}
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={send} disabled={busy} className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-text disabled:opacity-50">
              {busy ? 'Sending…' : 'Send it back'}
            </button>
            <button type="button" onClick={() => setOpen(false)} disabled={busy} className="rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-50">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
