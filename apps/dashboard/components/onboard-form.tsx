'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

/** The two-field start of a project (BUILD_PLAN v1 6.7): a repo URL and, optionally, a Jira project key. Everything else is proposed. */
export function OnboardForm() {
  const router = useRouter();
  const [repoUrl, setRepoUrl] = useState('');
  const [jiraProjectKey, setKey] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setMessage(null);
    try {
      const res = await fetch('/api/projects/onboard', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repoUrl, jiraProjectKey }) });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        router.push(`/projects/${body.id}`);
        return;
      }
      if (res.status === 400 && body.fields) {
        setErrors(body.fields);
        setMessage('Some fields need attention.');
      } else setMessage(body.message ?? 'Could not start the project.');
    } catch {
      setMessage('Cannot reach the server.');
    } finally {
      setBusy(false);
    }
  }

  const field = (id: string, label: string, value: string, set: (v: string) => void, hint: string, placeholder: string) => (
    <div>
      <label htmlFor={id} className="block text-sm">
        {label}
      </label>
      <input
        id={id}
        value={value}
        onChange={(e) => set(e.target.value)}
        placeholder={placeholder}
        aria-invalid={errors[id] ? true : undefined}
        aria-describedby={`${id}-hint`}
        className="mt-1 w-full rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
      />
      <p id={`${id}-hint`} className="mt-1 text-xs text-muted">
        {hint}
      </p>
      {errors[id] && (
        <p role="alert" className="mt-1 text-xs text-red">
          {errors[id]}
        </p>
      )}
    </div>
  );

  return (
    <form onSubmit={submit} className="max-w-xl space-y-5" noValidate>
      {field('repoUrl', 'Repository URL', repoUrl, setRepoUrl, 'The GitHub repository the agent works in.', 'https://github.com/acme/billing')}
      {field('jiraProjectKey', 'Jira project key (optional)', jiraProjectKey, setKey, 'Leave it empty to work from pasted tickets only. The Atlassian credential is set once in Settings → Connections.', 'SDA')}
      <p className="text-sm text-muted">The pipeline then reads the repository and your Jira project and proposes the commands, the status mapping, the issue types and the label. You review it before anything is used.</p>
      <div className="flex items-center gap-4">
        <button type="submit" disabled={busy || repoUrl.trim() === ''} className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-text disabled:opacity-60">
          {busy ? 'Starting…' : 'Start'}
        </button>
        {message && (
          <p role="alert" className="text-sm text-red">
            {message}
          </p>
        )}
      </div>
    </form>
  );
}
