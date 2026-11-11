'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';

export function LoginForm() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        router.replace('/');
        router.refresh();
        return;
      }
      if (res.status === 401) setError('Wrong password.');
      else if (res.status === 429) setError('Too many failed attempts. Try again in 15 minutes.');
      else setError('Something went wrong. Please try again.');
    } catch {
      setError('Cannot reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="w-full max-w-sm rounded-lg border border-border bg-surface p-8">
      <h1 className="text-lg font-semibold">SDLC Agent</h1>
      <p className="mt-1 text-sm text-muted">Enter the dashboard password.</p>
      <label htmlFor="password" className="mt-6 block text-sm">
        Password
      </label>
      <input
        id="password"
        type="password"
        autoComplete="current-password"
        autoFocus
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="mt-1 w-full rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
      />
      {error && (
        <p role="alert" className="mt-3 text-sm text-red">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={busy}
        className="mt-6 w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-text disabled:opacity-60"
      >
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
