'use client';

import { CREDENTIAL_KEYS, type CredentialKey, type CredentialView } from '@sdlc/shared';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { formatDateTime } from '@/lib/ticket-status';

interface TestState {
  ok: boolean;
  message: string;
  at: string;
}

interface Card {
  title: string;
  optional?: boolean;
  help: React.ReactNode;
  keys: CredentialKey[];
}

const CARDS: Card[] = [
  {
    title: 'Claude',
    help: (
      <>
        Run <code>claude setup-token</code> on a machine logged in to your Claude account and paste the token.
      </>
    ),
    keys: ['claude_token'],
  },
  {
    title: 'GitHub',
    help: (
      <>
        A fine-grained personal access token limited to the target repositories, with Contents (read/write), Pull requests (read/write), Actions (read), Commit statuses
        (read) and Metadata (read). Do not grant administration permission. The name and email are used for every commit.
      </>
    ),
    keys: ['github_token', 'git_author_name', 'git_author_email'],
  },
  {
    title: 'Jira',
    optional: true,
    help: <>Only needed for Jira REST mode. Use a Jira Cloud base URL (https://your-site.atlassian.net) and an API token.</>,
    keys: ['jira_base_url', 'jira_email', 'jira_api_token'],
  },
];

const BADGE: Record<CredentialView['source'], { text: string; cls: string }> = {
  env: { text: 'Set in .env', cls: 'border-border text-muted' },
  db: { text: 'Saved', cls: 'border-green text-green' },
  unset: { text: 'Not set', cls: 'border-amber text-amber' },
};

function Field({ view, onChange }: { view: CredentialView; onChange: (v: CredentialView) => void }) {
  const def = CREDENTIAL_KEYS.find((c) => c.key === view.key)!;
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<TestState | null>(null);
  const readOnly = view.source === 'env';
  const badge = BADGE[view.source];

  async function save() {
    setBusy('save');
    setError(null);
    try {
      const res = await fetch(`/api/credentials/${view.key}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value }) });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setValue('');
        setTest(null);
        onChange(data as CredentialView);
        return;
      }
      setError(data.fields?.value ?? data.message ?? 'Could not save.');
    } catch {
      setError('Cannot reach the server.');
    } finally {
      setBusy(null);
    }
  }

  async function runTest() {
    setBusy('test');
    setError(null);
    try {
      const res = await fetch(`/api/credentials/${view.key}/test`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setTest({ ok: data.ok, message: data.message, at: new Date().toISOString() });
      else setError(data.message ?? 'The test failed to run.');
    } catch {
      setError('Cannot reach the server.');
    } finally {
      setBusy(null);
    }
  }

  const id = `cred-${view.key}`;
  return (
    <div data-testid={`field-${view.key}`} className="border-t border-border pt-4 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={id} className="text-sm">
          {def.label}
        </label>
        <span className={`rounded border px-1.5 py-0.5 text-xs ${badge.cls}`}>{badge.text}</span>
        {view.hint && view.source !== 'unset' && <span className="text-xs text-muted">{def.secret ? `••••${view.hint}` : view.hint}</span>}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          id={id}
          type={def.secret ? 'password' : 'text'}
          autoComplete="off"
          disabled={readOnly}
          placeholder={readOnly ? 'Set in .env' : def.secret ? 'Paste a new value' : 'Enter a value'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="min-w-0 flex-1 rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-60"
        />
        {!readOnly && (
          <button type="button" onClick={save} disabled={busy !== null || value.trim() === ''} className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-text disabled:opacity-50">
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
        )}
        <button type="button" onClick={runTest} disabled={busy !== null || view.source === 'unset'} className="rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50">
          {busy === 'test' ? 'Testing…' : 'Test'}
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-red">
          {error}
        </p>
      )}
      {test && (
        <p role="status" className={`mt-2 text-xs ${test.ok ? 'text-green' : 'text-red'}`}>
          {test.ok ? '✔' : '✖'} {test.message} <span className="text-muted">({formatDateTime(test.at)})</span>
        </p>
      )}
      {!test && view.verifyError && <p className="mt-2 text-xs text-red">{view.verifyError}</p>}
      {!test && !view.verifyError && view.verifiedAt && <p className="mt-2 text-xs text-muted">Last verified {formatDateTime(view.verifiedAt)}</p>}
    </div>
  );
}

/** The connection cards of the setup wizard and the settings page. Secrets are never rendered, only a hint of the last 4 characters. */
export function CredentialsForm({ initial, encryptionKeyOk = true }: { initial: CredentialView[]; encryptionKeyOk?: boolean }) {
  const router = useRouter();
  const [views, setViews] = useState(initial);
  const byKey = new Map(views.map((v) => [v.key, v]));
  const update = (v: CredentialView) => {
    setViews((all) => all.map((x) => (x.key === v.key ? v : x)));
    router.refresh(); // the setup banner lives in the shell layout, which stays mounted: re-fetch it
  };

  return (
    <div className="space-y-6">
      {!encryptionKeyOk && (
        <p role="alert" className="rounded-md border border-amber px-3 py-2 text-sm">
          ENCRYPTION_KEY is not set, so tokens cannot be saved here. Add it to .env (<code>openssl rand -base64 32</code>) and restart.
        </p>
      )}
      {CARDS.map((card, i) => (
        <section key={card.title} className="panel p-6" aria-labelledby={`card-${card.title}`}>
          <div className="flex items-baseline justify-between gap-4">
            <h2 id={`card-${card.title}`} className="text-lg font-semibold">
              {card.title}
              {card.optional && <span className="ml-2 text-xs font-normal text-muted">optional</span>}
            </h2>
            <a href={CARDS[i + 1] ? `#card-${CARDS[i + 1]?.title}` : '/'} className="text-xs text-muted underline">
              Skip for now
            </a>
          </div>
          <p className="mt-2 text-sm text-muted">{card.help}</p>
          <div className="mt-4 space-y-4">
            {card.keys.map((k) => {
              const view = byKey.get(k);
              return view ? <Field key={k} view={view} onChange={update} /> : null;
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
