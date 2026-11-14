'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

type Action = 'pipeline' | 'intake';

/** Pause or resume the whole pipeline, and pause or resume reading Jira (intake), from the top bar. */
export function RunControls({ pipelinePaused, intakePaused }: { pipelinePaused: boolean; intakePaused: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(action: Action, paused: boolean) {
    setBusy(action);
    setError(null);
    const path = action === 'pipeline' ? (paused ? 'resume' : 'pause') : paused ? 'intake/resume' : 'intake/pause';
    try {
      const res = await fetch(`/api/system/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (!res.ok) setError((await res.json().catch(() => ({}))).message ?? 'Something went wrong.');
      router.refresh();
    } catch {
      setError('Cannot reach the server.');
    } finally {
      setBusy(null);
    }
  }

  const button = 'rounded-md border px-3 py-1.5 text-sm disabled:opacity-50';
  return (
    <div className="flex items-center gap-2">
      {error && (
        <span role="alert" className="text-xs text-red">
          {error}
        </span>
      )}
      <button
        type="button"
        onClick={() => toggle('intake', intakePaused)}
        disabled={busy !== null}
        title={intakePaused ? 'Start reading tickets from Jira again' : 'Stop reading tickets from Jira. Tickets already in the pipeline keep going.'}
        className={`${button} ${intakePaused ? 'border-amber text-amber' : 'border-border text-muted hover:text-text'}`}
      >
        {intakePaused ? 'Resume intake' : 'Pause intake'}
      </button>
      <button
        type="button"
        onClick={() => toggle('pipeline', pipelinePaused)}
        disabled={busy !== null}
        title={pipelinePaused ? 'Let the pipeline run stages again' : 'Stop starting new stages. A running stage finishes.'}
        className={`${button} ${pipelinePaused ? 'border-amber text-amber' : 'border-border text-muted hover:text-text'}`}
      >
        {pipelinePaused ? 'Resume pipeline' : 'Pause pipeline'}
      </button>
    </div>
  );
}
