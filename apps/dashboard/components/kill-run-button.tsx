'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** Stops a running stage (F5). The worker kills the container within a few seconds and the ticket goes on hold. */
export function KillRunButton({ runId }: { runId: string }) {
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'busy' | 'requested' | 'error'>('idle');

  async function kill() {
    setState('busy');
    try {
      const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/kill`, { method: 'POST' });
      setState(res.ok ? 'requested' : 'error');
      router.refresh();
    } catch {
      setState('error');
    }
  }

  if (state === 'requested') return <span className="text-xs text-muted">Stopping…</span>;
  return (
    <button type="button" onClick={kill} disabled={state === 'busy'} className="text-xs text-red hover:underline disabled:opacity-50">
      {state === 'error' ? 'Kill failed, retry' : 'Kill'}
    </button>
  );
}
