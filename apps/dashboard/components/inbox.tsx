'use client';

import { INBOX_GROUPS, INBOX_GROUP_LABEL } from '@sdlc/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ago } from '@/lib/activity';
import type { InboxGroupView, SupportTicketView } from '@/lib/types';

const KIND_LABEL: Record<SupportTicketView['kind'], string> = {
  approval: 'Approval', question: 'Question', open_question: 'Open question', hold: 'Hold', ci_infra: 'CI problem', onboarding: 'Onboarding', credential: 'Credential', pr_ready: 'PR ready',
};

type Busy = string | null;

/** One box for the person's text: an answer, or the note of a rejection. */
function TextAction({ id, label, placeholder, action, submit, disabled, onDone, busy, setBusy, tone = 'primary', allowEmpty = false }: {
  id: string; label: string; placeholder: string; action: string; submit: string; disabled?: boolean; onDone: (error: string | null) => void; busy: Busy; setBusy: (b: Busy) => void; tone?: 'primary' | 'plain'; allowEmpty?: boolean;
}) {
  const [text, setText] = useState('');
  async function send() {
    setBusy(action);
    const res = await post(id, action, action === 'answer' ? { answer: text } : { note: text });
    setBusy(null);
    onDone(res);
  }
  return (
    <div className="mt-3">
      <label htmlFor={`${action}-${id}`} className="block text-sm">
        {label}
      </label>
      <textarea id={`${action}-${id}`} rows={2} value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} className="mt-1 w-full rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent" />
      <button
        type="button"
        onClick={send}
        disabled={disabled || busy !== null || (!allowEmpty && text.trim() === '')}
        className={`mt-2 rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50 ${tone === 'primary' ? 'bg-accent text-accent-text' : 'border border-border'}`}
      >
        {busy === action ? 'Sending…' : submit}
      </button>
    </div>
  );
}

/** Posts an action; returns an error message, or null when it worked. */
async function post(id: string, action: string, extra: Record<string, unknown> = {}): Promise<string | null> {
  try {
    const res = await fetch(`/api/support-tickets/${encodeURIComponent(id)}/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...extra }) });
    if (res.ok) return null;
    const data = await res.json().catch(() => ({}));
    return (data.fields && Object.values(data.fields)[0]) || data.message || 'Something went wrong.';
  } catch {
    return 'Cannot reach the server.';
  }
}

function Item({ t, now }: { t: SupportTicketView; now: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const open = t.status === 'open' || (t.status === 'answered' && t.kind === 'open_question');
  const has = (a: string) => t.actions.includes(a);

  const done = (err: string | null) => {
    setError(err);
    if (!err) router.refresh();
    else if (/already/i.test(err)) router.refresh();
  };
  async function simple(action: string, extra: Record<string, unknown> = {}) {
    setBusy(action);
    done(await post(t.id, action, extra));
    setBusy(null);
  }
  const button = (action: string, label: string, primary = false) => (
    <button key={action} type="button" onClick={() => simple(action)} disabled={busy !== null} className={`rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${primary ? 'bg-accent text-accent-text' : 'border border-border'}`}>
      {busy === action ? 'Working…' : label}
    </button>
  );
  const ticketLink = t.ticketId && (
    <Link href={`/tickets/${t.ticketId}${t.kind === 'approval' ? `?tab=${t.stage === 'breakdown' ? 'breakdown' : 'plan'}` : ''}`} className="font-medium text-fg underline">
      {t.ticketKey}
    </Link>
  );

  return (
    <li data-kind={t.kind} className={`panel p-4 ${open ? '' : 'opacity-70'}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span className="rounded border border-border px-1.5 py-0.5">{KIND_LABEL[t.kind]}</span>
        {ticketLink}
        {t.ticketTitle && <span>· {t.ticketTitle}</span>}
        {t.stage && (
          <span>
            · stage <span className="font-mono">{t.stage}</span>
          </span>
        )}
        <span className="ml-auto">{open ? `waiting ${ago(t.createdAt, now).replace(' ago', '')}` : `${t.status} ${ago(t.resolvedAt, now)}${t.resolvedBy ? ` by ${t.resolvedBy}` : ''}`}</span>
      </div>
      <h3 className="mt-2 text-sm font-medium">{t.title}</h3>
      {t.body && t.body !== t.title && <p className="mt-1 whitespace-pre-wrap text-sm text-muted">{t.body}</p>}
      {t.defaultAnswer && <p className="mt-1 text-sm text-muted">The plan assumed: {t.defaultAnswer}</p>}
      {t.response && (
        <p className="mt-2 whitespace-pre-wrap text-sm">
          <span className="text-muted">{t.kind === 'question' || t.kind === 'open_question' ? 'Answer: ' : 'Outcome: '}</span>
          {t.response}
        </p>
      )}

      {open && (
        <div className="mt-3">
          <div className="flex flex-wrap items-center gap-2">
            {has('approve') && button('approve', 'Approve', true)}
            {has('reject') && (
              <button type="button" onClick={() => setRejecting((v) => !v)} aria-expanded={rejecting} className="rounded-md border border-border px-3 py-1.5 text-sm font-medium">
                Reject with a note
              </button>
            )}
            {has('resume') && button('resume', 'Resume', true)}
            {has('retry') && button('retry', 'Retry')}
            {has('fail') && button('fail', 'Mark failed')}
            {has('fixed') && button('fixed', 'Fixed, re-run CI', true)}
            {has('hold') && button('hold', 'Hold the ticket')}
            {has('rerun_with_answers') && t.status === 'answered' && button('rerun_with_answers', 'Rerun the plan with answers', true)}
            {t.kind === 'credential' && (
              <Link href="/setup/connections" className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-text">
                Open Settings → Connections
              </Link>
            )}
            {t.kind === 'onboarding' && t.projectId && (
              <Link href={`/projects/${t.projectId}`} className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-text">
                Review the proposal
              </Link>
            )}
            {has('dismiss') && button('dismiss', 'Dismiss')}
          </div>
          {rejecting && <TextAction id={t.id} label="What should change?" placeholder="The note goes back to the stage with the previous attempt" action="reject" submit="Send back" onDone={done} busy={busy} setBusy={setBusy} />}
          {has('answer') && t.status === 'open' && <TextAction id={t.id} label="Your answer" placeholder="" action="answer" submit="Answer" onDone={done} busy={busy} setBusy={setBusy} />}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-red">
          {error}
        </p>
      )}
    </li>
  );
}

/**
 * The inbox (BUILD_PLAN v1 6.5): everything that needs a person, grouped as Blocking, Approvals, Questions and FYI, oldest
 * first in each group, each with one-click actions. Resolved items are in the History tab.
 */
export function Inbox({ tickets, tab, now = Date.now() }: { tickets: SupportTicketView[]; tab: 'open' | 'history'; now?: number }) {
  if (tab === 'history') {
    if (tickets.length === 0) return <p className="mt-4 text-sm text-muted">Nothing has been resolved yet.</p>;
    return (
      <ul className="mt-4 space-y-3">
        {tickets.map((t) => (
          <Item key={t.id} t={t} now={now} />
        ))}
      </ul>
    );
  }
  if (tickets.length === 0) return <p className="mt-4 text-sm text-muted">Nothing is waiting for you. When the pipeline needs an approval, an answer or help, it appears here.</p>;
  const by = (g: InboxGroupView) => tickets.filter((t) => t.group === g).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return (
    <div className="mt-4 space-y-8">
      {INBOX_GROUPS.map((g) => {
        const items = by(g);
        if (items.length === 0) return null;
        return (
          <section key={g} aria-label={INBOX_GROUP_LABEL[g]}>
            <h2 className="text-sm font-medium">
              {INBOX_GROUP_LABEL[g]} ({items.length})
            </h2>
            <ul className="mt-2 space-y-3">
              {items.map((t) => (
                <Item key={t.id} t={t} now={now} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** "Needs you" at the top of the overview: the oldest blocking items, with a link to the whole inbox. */
export function NeedsYou({ tickets, counts, now = Date.now() }: { tickets: SupportTicketView[]; counts: { badge: number }; now?: number }) {
  if (counts.badge === 0) return null;
  const top = tickets.filter((t) => t.status === 'open' && (t.kind === 'approval' || t.priority === 'blocking')).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, 5);
  return (
    <section aria-label="Needs you" className="panel border-amber p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Needs you ({counts.badge})</h2>
        <Link href="/inbox" className="text-sm text-accent hover:underline">
          Open the inbox
        </Link>
      </div>
      <ul className="mt-2 space-y-1 text-sm">
        {top.map((t) => (
          <li key={t.id}>
            <span className="mr-2 rounded border border-border px-1.5 py-0.5 text-xs text-muted">{KIND_LABEL[t.kind]}</span>
            {t.title} <span className="text-xs text-muted">· waiting {ago(t.createdAt, now).replace(' ago', '')}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
