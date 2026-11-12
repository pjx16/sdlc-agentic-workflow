'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { BrandMark } from './brand-mark';

const MIN_LENGTH = 12;

/** Step 1 of the setup wizard: the one-time setup code and the admin password. */
export function SetupAdminForm() {
  const router = useRouter();
  const [setupCode, setSetupCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < MIN_LENGTH) return setError(`The password must be at least ${MIN_LENGTH} characters.`);
    if (password !== confirm) return setError('The two passwords do not match.');
    setBusy(true);
    try {
      const res = await fetch('/api/setup/admin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ setupCode, password }),
      });
      if (res.ok) {
        router.replace('/setup/connections');
        router.refresh();
        return;
      }
      if (res.status === 401) setError('Wrong setup code.');
      else if (res.status === 429) setError('Too many failed attempts. Try again in 15 minutes.');
      else if (res.status === 409) setError('The admin account already exists. Sign in instead.');
      else setError('Something went wrong. Please try again.');
    } catch {
      setError('Cannot reach the server.');
    } finally {
      setBusy(false);
    }
  }

  const input = 'mt-1 w-full rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent';
  return (
    <form onSubmit={submit} className="w-full max-w-sm panel p-8">
      <div className="flex items-center gap-3">
        <BrandMark />
        <div>
          <h1 className="text-lg font-semibold leading-tight tracking-wide">SDLC AGENT</h1>
          <div className="eyebrow">First-run setup</div>
        </div>
      </div>
      <p className="mt-6 text-sm text-muted">Create the admin password. You need the one-time setup code.</p>
      <label htmlFor="setupCode" className="mt-6 block text-sm">
        Setup code
      </label>
      <input id="setupCode" autoFocus required autoComplete="off" value={setupCode} onChange={(e) => setSetupCode(e.target.value)} className={input} />
      <p className="mt-1 text-xs text-muted">
        Printed by <code>sdlc-agent init</code>, or run <code>docker compose logs api | grep &apos;setup code&apos;</code>.
      </p>
      <label htmlFor="password" className="mt-4 block text-sm">
        Password
      </label>
      <input id="password" type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} className={input} />
      <p className="mt-1 text-xs text-muted">At least {MIN_LENGTH} characters.</p>
      <label htmlFor="confirm" className="mt-4 block text-sm">
        Confirm password
      </label>
      <input id="confirm" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} className={input} />
      {error && (
        <p role="alert" className="mt-3 text-sm text-red">
          {error}
        </p>
      )}
      <button type="submit" disabled={busy} className="mt-6 w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-text disabled:opacity-60">
        {busy ? 'Creating…' : 'Create admin'}
      </button>
    </form>
  );
}
