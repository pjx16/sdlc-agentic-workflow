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
  /** Used in test ids: `card-<id>`. */
  id: string;
  optional?: boolean;
  help: React.ReactNode;
  keys: CredentialKey[];
  /** The credential the card's Test button checks (it tests the connection as a whole). */
  testKey: CredentialKey;
}

/** GitHub's "new fine-grained token" page with the name and permissions pre-filled (the repositories are chosen on the page). */
const GITHUB_TOKEN_URL =
  'https://github.com/settings/personal-access-tokens/new?name=sdlc-agent&description=Used+by+sdlc-agent+to+clone%2C+push+branches+and+open+pull+requests&contents=write&pull_requests=write&metadata=read&actions=read&statuses=read';

const PERMISSIONS: { name: string; level: string; why: string }[] = [
  { name: 'Contents', level: 'Read and write', why: 'clone the repository and push the ticket branch' },
  { name: 'Pull requests', level: 'Read and write', why: 'open the draft PR, mark it ready, comment on it' },
  { name: 'Actions', level: 'Read', why: 'read CI results and failing logs' },
  { name: 'Commit statuses', level: 'Read', why: 'read check status on the PR' },
  { name: 'Metadata', level: 'Read', why: 'required by GitHub for every token' },
];

const CARDS: Card[] = [
  {
    title: 'Claude',
    help: (
      <>
        Run <code>claude setup-token</code> on a machine logged in to your Claude account and paste the token (it starts with <code>sk-ant-</code>). It needs no other permissions.
      </>
    ),
    keys: ['claude_token'],
    id: 'claude',
    testKey: 'claude_token',
  },
  {
    title: 'GitHub',
    help: (
      <div className="space-y-3">
        <p>
          Create a <strong>fine-grained personal access token</strong>.{' '}
          <a href={GITHUB_TOKEN_URL} target="_blank" rel="noopener noreferrer" className="text-accent underline">
            Open GitHub with the permissions pre-filled ↗
          </a>
        </p>
        <div>
          <p className="font-medium text-text">Repository access</p>
          <p>
            Choose <strong>Only select repositories</strong> and add every repository you will use here. The token owner must be the account or organisation that owns them. A token that cannot see a repository
            makes it fail with a 404.
          </p>
        </div>
        <div>
          <p className="font-medium text-text">Repository permissions</p>
          <ul className="mt-1 space-y-0.5" data-testid="github-permissions">
            {PERMISSIONS.map((p) => (
              <li key={p.name}>
                <span className="font-medium text-text">{p.name}</span>: {p.level} <span className="text-muted">— {p.why}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1">Do not grant Administration or any account permission.</p>
        </div>
        <p>
          A classic token also works: it needs the <code>repo</code> scope (and SSO authorisation for an organisation). The name and email below are used for every commit.
        </p>
      </div>
    ),
    keys: ['github_token', 'git_author_name', 'git_author_email'],
    id: 'github',
    testKey: 'github_token',
  },
  {
    title: 'Jira',
    optional: true,
    help: (
      <div className="space-y-2">
        <p>
          Only needed for Jira REST mode. Use your Jira Cloud base URL (<code>https://your-site.atlassian.net</code>), the email of your Atlassian account, and an API token from{' '}
          <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noopener noreferrer" className="text-accent underline">
            id.atlassian.com ↗
          </a>
          .
        </p>
        <p>The account behind it must be able to browse the project, comment, create subtasks and transition issues, because the pipeline reads tickets, posts plans and moves statuses.</p>
      </div>
    ),
    keys: ['jira_base_url', 'jira_email', 'jira_api_token'],
    id: 'jira',
    testKey: 'jira_api_token',
  },
];

const BADGE: Record<CredentialView['source'], { text: string; cls: string }> = {
  env: { text: 'Set in .env', cls: 'border-border text-muted' },
  db: { text: 'Saved', cls: 'border-green text-green' },
  unset: { text: 'Not set', cls: 'border-amber text-amber' },
};

/** What a field starts with: plain values are shown so they can be edited, secrets are never pre-filled. */
const initialValue = (view: CredentialView, secret: boolean) => (!secret && view.source === 'db' ? (view.hint ?? '') : '');

function Field({ view, value, onChange, error }: { view: CredentialView; value: string; onChange: (v: string) => void; error?: string }) {
  const def = CREDENTIAL_KEYS.find((c) => c.key === view.key)!;
  const readOnly = view.source === 'env';
  const badge = BADGE[view.source];
  const id = `cred-${view.key}`;
  return (
    <div data-testid={`field-${view.key}`}>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={id} className="text-sm">
          {def.label}
        </label>
        <span className={`rounded border px-1.5 py-0.5 text-xs ${badge.cls}`}>{badge.text}</span>
        {def.secret && view.hint && view.source !== 'unset' && <span className="text-xs text-muted">••••{view.hint}</span>}
      </div>
      <input
        id={id}
        type={def.secret ? 'password' : 'text'}
        autoComplete="off"
        disabled={readOnly}
        placeholder={readOnly ? 'Set in .env' : def.secret ? (view.source === 'db' ? 'Paste a new value to replace it' : 'Paste the value') : 'Enter a value'}
        value={readOnly ? '' : value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-2 w-full rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-60"
      />
      {error && (
        <p role="alert" className="mt-1 text-xs text-red">
          {error}
        </p>
      )}
    </div>
  );
}

interface TestState {
  ok: boolean;
  message: string;
  at: string;
}

function CardView({ card, views, onSaved }: { card: Card; views: Map<CredentialKey, CredentialView>; onSaved: (v: CredentialView[]) => void }) {
  const fields = card.keys.map((k) => views.get(k)).filter((v): v is CredentialView => Boolean(v));
  const secretOf = (k: CredentialKey) => CREDENTIAL_KEYS.find((c) => c.key === k)!.secret;
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((v) => [v.key, initialValue(v, secretOf(v.key))])));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [test, setTest] = useState<TestState | null>(null);

  // Only fields that are editable and changed (a secret: anything typed) are sent.
  const changed = fields.filter((v) => v.source !== 'env' && values[v.key]?.trim() && values[v.key]!.trim() !== initialValue(v, secretOf(v.key)));
  const primary = views.get(card.testKey);
  const testable = primary !== undefined && primary.source !== 'unset';
  const allEnv = fields.every((v) => v.source === 'env');

  async function save() {
    setBusy('save');
    setMessage(null);
    setErrors({});
    const failed: Record<string, string> = {};
    const saved: CredentialView[] = [];
    for (const v of changed) {
      try {
        const res = await fetch(`/api/credentials/${v.key}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: values[v.key] }) });
        const data = await res.json().catch(() => ({}));
        if (res.ok) saved.push(data as CredentialView);
        else failed[v.key] = data.fields?.value ?? data.message ?? 'Could not save.';
      } catch {
        failed[v.key] = 'Cannot reach the server.';
      }
    }
    if (saved.length > 0) {
      setValues((cur) => ({ ...cur, ...Object.fromEntries(saved.map((s) => [s.key, initialValue(s, secretOf(s.key))])) }));
      setTest(null);
      onSaved(saved);
    }
    setErrors(failed);
    if (Object.keys(failed).length === 0) setMessage(`Saved ${saved.length} ${saved.length === 1 ? 'value' : 'values'}.`);
    setBusy(null);
  }

  async function runTest() {
    setBusy('test');
    setMessage(null);
    try {
      const res = await fetch(`/api/credentials/${card.testKey}/test`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setTest({ ok: data.ok, message: data.message, at: new Date().toISOString() });
      else setMessage(data.message ?? 'The test failed to run.');
    } catch {
      setMessage('Cannot reach the server.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section data-testid={`card-${card.id}`} className="panel p-6" aria-labelledby={`card-${card.title}`}>
      <div className="flex items-baseline justify-between gap-4">
        <h2 id={`card-${card.title}`} className="text-lg font-semibold">
          {card.title}
          {card.optional && <span className="ml-2 text-xs font-normal text-muted">optional</span>}
        </h2>
        <a href={NEXT_ANCHOR[card.id] ?? '/'} className="text-xs text-muted underline">
          Skip for now
        </a>
      </div>
      <div className="mt-2 text-sm text-muted">{card.help}</div>
      <div className="mt-4 space-y-4">
        {fields.map((v) => (
          <Field key={v.key} view={v} value={values[v.key] ?? ''} onChange={(text) => setValues((cur) => ({ ...cur, [v.key]: text }))} error={errors[v.key]} />
        ))}
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        {!allEnv && (
          <button type="button" onClick={save} disabled={busy !== null || changed.length === 0} className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-text disabled:opacity-50">
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
        )}
        <button
          type="button"
          onClick={runTest}
          disabled={busy !== null || !testable || changed.length > 0}
          title={changed.length > 0 ? 'Save your changes first' : undefined}
          className="rounded-md border border-border px-4 py-2 text-sm disabled:opacity-50"
        >
          {busy === 'test' ? 'Testing…' : 'Test'}
        </button>
      </div>
      {message && (
        <p role="status" className="mt-3 text-xs text-muted">
          {message}
        </p>
      )}
      {test && (
        <p role="status" className={`mt-3 text-xs ${test.ok ? 'text-green' : 'text-red'}`}>
          {test.ok ? '✔' : '✖'} {test.message} <span className="text-muted">({formatDateTime(test.at)})</span>
        </p>
      )}
      {!test && primary?.verifyError && <p className="mt-3 text-xs text-red">{primary.verifyError}</p>}
      {!test && !primary?.verifyError && primary?.verifiedAt && <p className="mt-3 text-xs text-muted">Last verified {formatDateTime(primary.verifiedAt)}</p>}
    </section>
  );
}

const NEXT_ANCHOR: Record<string, string> = { claude: '#card-GitHub', github: '#card-Jira' };

/** The connection cards of the setup wizard and the settings page: one Save and one Test per card. Secrets are never rendered, only a hint of the last 4 characters. */
export function CredentialsForm({ initial, encryptionKeyOk = true }: { initial: CredentialView[]; encryptionKeyOk?: boolean }) {
  const router = useRouter();
  const [views, setViews] = useState(initial);
  const byKey = new Map(views.map((v) => [v.key, v]));
  const onSaved = (saved: CredentialView[]) => {
    setViews((all) => all.map((x) => saved.find((s) => s.key === x.key) ?? x));
    router.refresh(); // the setup banner lives in the shell layout, which stays mounted: re-fetch it
  };

  return (
    <div className="space-y-6">
      {!encryptionKeyOk && (
        <p role="alert" className="rounded-md border border-amber px-3 py-2 text-sm">
          ENCRYPTION_KEY is not set, so tokens cannot be saved here. Add it to .env (<code>openssl rand -base64 32</code>) and restart.
        </p>
      )}
      {CARDS.map((card) => (
        <CardView key={card.id} card={card} views={byKey} onSaved={onSaved} />
      ))}
    </div>
  );
}
