'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';

/** Changes the admin password (hidden when DASHBOARD_PASSWORD in .env sets it). Other sessions are signed out. */
export function ChangePasswordForm() {
  const router = useRouter();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setMessage(null);
    if (next.length < 12) return setMessage({ ok: false, text: 'The new password must be at least 12 characters.' });
    setBusy(true);
    try {
      const res = await fetch('/api/auth/password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ current, next }) });
      if (res.ok) {
        setCurrent('');
        setNext('');
        setMessage({ ok: true, text: 'Password changed. Other sessions were signed out.' });
        router.refresh();
      } else if (res.status === 401) setMessage({ ok: false, text: 'The current password is wrong.' });
      else setMessage({ ok: false, text: (await res.json().catch(() => ({}))).message ?? 'Something went wrong.' });
    } catch {
      setMessage({ ok: false, text: 'Cannot reach the server.' });
    } finally {
      setBusy(false);
    }
  }

  const input = 'mt-1 w-full rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent';
  return (
    <form onSubmit={submit} className="mb-8 panel max-w-md p-6">
      <h2 className="text-lg font-semibold">Change password</h2>
      <label htmlFor="current-password" className="mt-4 block text-sm">
        Current password
      </label>
      <input id="current-password" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} className={input} />
      <label htmlFor="new-password" className="mt-4 block text-sm">
        New password
      </label>
      <input id="new-password" type="password" autoComplete="new-password" required value={next} onChange={(e) => setNext(e.target.value)} className={input} />
      {message && (
        <p role={message.ok ? 'status' : 'alert'} className={`mt-3 text-sm ${message.ok ? 'text-green' : 'text-red'}`}>
          {message.text}
        </p>
      )}
      <button type="submit" disabled={busy} className="mt-4 rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-text disabled:opacity-60">
        {busy ? 'Changing…' : 'Change password'}
      </button>
    </form>
  );
}
