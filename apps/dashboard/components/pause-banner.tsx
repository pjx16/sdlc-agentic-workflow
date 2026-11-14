'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ERROR_POLICY, isErrorCode } from '@sdlc/shared';
import { formatDateTime } from '@/lib/ticket-status';
import { SourceBadge } from './error-note';

interface Props {
  code?: string | null;
  reason: string | null;
  resetsAt: string | null;
}

/** Shown while the pipeline is paused (F14): why, when the window resets, and the two ways forward. */
export function PauseBanner({ code, reason, resetsAt }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<'resume' | 'ignore' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const manual = reason === 'manual';

  async function send(action: 'resume' | 'ignore') {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(action === 'resume' ? '/api/system/resume' : '/api/system/usage/ignore', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
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
    <div role="alert" className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-amber bg-surface px-8 py-3 text-sm">
      <p className="min-w-0 flex-1">
        <span className="font-medium">Pipeline paused.</span> {isErrorCode(code) && <SourceBadge code={code} />} {manual ? 'Paused by you.' : (reason ?? 'No reason recorded.')}
        {isErrorCode(code) && <span className="text-muted"> {ERROR_POLICY[code].action}</span>}
        {resetsAt && <span className="text-muted"> The usage window resets {formatDateTime(resetsAt)}.</span>}
      </p>
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => send('resume')} disabled={busy !== null} className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-text disabled:opacity-50">
          {busy === 'resume' ? 'Resuming…' : 'Resume'}
        </button>
        {!manual && (
          <button type="button" onClick={() => send('ignore')} disabled={busy !== null} className="rounded-md border border-border px-3 py-1.5 disabled:opacity-50">
            {busy === 'ignore' ? 'Working…' : 'Ignore usage for this window'}
          </button>
        )}
      </div>
      {error && <p className="w-full text-xs text-red">{error}</p>}
    </div>
  );
}
