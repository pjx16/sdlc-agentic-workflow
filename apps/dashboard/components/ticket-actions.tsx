'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

type Action = 'hold' | 'resume' | 'retry' | 'kb-update/rerun';

const LABEL: Record<Action, string> = { hold: 'Hold', resume: 'Resume', retry: 'Retry', 'kb-update/rerun': 'Re-run KB update' };

/** Which actions make sense for a ticket in `status` (BUILD_PLAN 6.6 rows 16 to 18, F11). */
export function actionsFor(status: string): Action[] {
  if (status === 'ON_HOLD') return ['resume', 'retry'];
  if (status === 'FAILED') return ['retry'];
  if (status === 'IN_HUMAN_REVIEW') return ['kb-update/rerun', 'hold'];
  if (status === 'DONE') return [];
  return ['hold'];
}

export function TicketActions({ ticketId, status }: { ticketId: string; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const actions = actionsFor(status);
  if (actions.length === 0) return null;

  async function run(action: Action) {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`/api/tickets/${encodeURIComponent(ticketId)}/${action}`, { method: 'POST' });
      if (res.ok) {
        router.refresh();
        return;
      }
      const data = await res.json().catch(() => ({}));
      setError(data.message ?? 'Something went wrong.');
      if (res.status === 409) router.refresh();
    } catch {
      setError('Cannot reach the server.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      {actions.map((a) => (
        <button
          key={a}
          type="button"
          onClick={() => run(a)}
          disabled={busy !== null}
          className={`rounded-md px-3 py-1.5 text-sm ${a === 'retry' || a === 'resume' ? 'bg-accent font-medium text-accent-text' : 'border border-border'} disabled:opacity-50`}
        >
          {busy === a ? 'Working…' : LABEL[a]}
        </button>
      ))}
      {error && (
        <p role="alert" className="text-xs text-red">
          {error}
        </p>
      )}
    </div>
  );
}
