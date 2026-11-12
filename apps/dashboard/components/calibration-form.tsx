'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface Props {
  current: number | null;
  suggested: number | null;
}

/** The calibration field (BUILD_PLAN 6.7): `calibratedWindowTokens` is only used when the CLI gives no utilization. */
export function CalibrationForm({ current, suggested }: Props) {
  const router = useRouter();
  const [value, setValue] = useState(current === null ? '' : String(current));
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(text: string) {
    setBusy(true);
    setMsg(null);
    try {
      const trimmed = text.trim();
      const res = await fetch('/api/system/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ calibratedWindowTokens: trimmed === '' ? null : Number(trimmed) }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setMsg({ kind: 'ok', text: 'Saved.' });
        router.refresh();
      } else {
        setMsg({ kind: 'error', text: data.fields?.calibratedWindowTokens ?? data.message ?? 'Something went wrong.' });
      }
    } catch {
      setMsg({ kind: 'error', text: 'Cannot reach the server.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <h2 className="text-sm font-medium">Calibration</h2>
      <p className="mt-1 text-sm text-muted">
        Used to estimate the 5-hour share when Claude does not report it: tokens in the last 5 hours divided by this value.
        {suggested !== null ? ` Suggested: ${suggested.toLocaleString('en-US')} tokens, the 5-hour total when Claude last rejected a request.` : ' A suggestion appears after Claude rejects a request.'}
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor="calibration" className="block text-sm">
            Calibrated window tokens
          </label>
          <input
            id="calibration"
            inputMode="numeric"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="mt-1 w-48 rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </div>
        <button type="button" disabled={busy} onClick={() => save(value)} className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-text disabled:opacity-50">
          Save
        </button>
        {suggested !== null && String(suggested) !== value && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setValue(String(suggested));
              void save(String(suggested));
            }}
            className="rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50"
          >
            Use suggestion
          </button>
        )}
      </div>
      {msg && (
        <p role={msg.kind === 'error' ? 'alert' : 'status'} className={`mt-2 text-xs ${msg.kind === 'error' ? 'text-red' : 'text-muted'}`}>
          {msg.text}
        </p>
      )}
    </div>
  );
}
