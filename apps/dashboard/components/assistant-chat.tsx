'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AssistantView } from '@/lib/types';

const APPLY_LABEL = { answer: 'Use this answer', plan_edit: 'Approve with this plan', rerun_note: 'Reject with this note' } as const;
const POLL_MS = 2000;

/**
 * The assistant for one support ticket (BUILD_PLAN v1 6.6). It only drafts: a draft is applied with one click, and that goes
 * through the same action as the buttons on the ticket. While the assistant is answering, the chat asks the server every two seconds.
 */
export function AssistantChat({ supportTicketId }: { supportTicketId: string }) {
  const router = useRouter();
  const [state, setState] = useState<AssistantView | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const base = `/api/support-tickets/${encodeURIComponent(supportTicketId)}/assistant`;
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch(base);
      if (res.ok && alive.current) setState((await res.json()) as AssistantView);
    } catch {
      /* the next poll tries again */
    }
  }, [base]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  useEffect(() => {
    if (!state?.pending) return;
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [state?.pending, load]);

  async function send() {
    setBusy('send');
    setError(null);
    try {
      const res = await fetch(`${base}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setState(body as AssistantView);
        setText('');
      } else setError((body.fields && Object.values(body.fields)[0]) || body.message || 'Something went wrong.');
    } catch {
      setError('Cannot reach the server.');
    } finally {
      setBusy(null);
    }
  }

  async function apply(messageId: string) {
    setBusy(messageId);
    setError(null);
    try {
      const res = await fetch(`${base}/messages/${encodeURIComponent(messageId)}/apply`, { method: 'POST' });
      if (res.ok) {
        await load();
        router.refresh();
      } else setError((await res.json().catch(() => ({}))).message ?? 'Something went wrong.');
    } catch {
      setError('Cannot reach the server.');
    } finally {
      setBusy(null);
    }
  }

  if (!state) return <p className="mt-3 text-sm text-muted">Loading the conversation…</p>;
  return (
    <div className="mt-3 rounded-md border border-border p-3" aria-label="Assistant">
      <p className="text-xs text-muted">
        The assistant knows only this item. It drafts, you decide: nothing changes until you apply a draft.
        <span className="ml-2">
          {state.tokens.toLocaleString('en-US')} / {state.tokenCap.toLocaleString('en-US')} tokens used
        </span>
      </p>
      <ol className="mt-3 space-y-3" aria-label="Messages">
        {state.messages.map((m) => (
          <li key={m.id} data-role={m.role} className={m.role === 'user' ? 'text-right' : ''}>
            <div className={`inline-block max-w-full whitespace-pre-wrap rounded-md px-3 py-2 text-left text-sm ${m.role === 'user' ? 'bg-accent-soft' : 'bg-surface-2'}`}>
              <span className="sr-only">{m.role === 'user' ? 'You: ' : 'Assistant: '}</span>
              {m.text}
            </div>
            {m.draft && (
              <div className="mt-2 rounded-md border border-border p-3 text-left text-sm">
                <p className="text-xs text-muted">Draft: {m.draft.kind.replace('_', ' ')}</p>
                {m.draft.diff ? (
                  <pre aria-label="Changes to the plan" className="mt-1 overflow-auto whitespace-pre-wrap font-mono text-xs">
                    {m.draft.diff.split('\n').map((line, i) => (
                      <span key={i} className={line.startsWith('+ ') ? 'block text-green' : line.startsWith('- ') ? 'block text-red' : 'block'}>
                        {line}
                      </span>
                    ))}
                  </pre>
                ) : (
                  <p className="mt-1 whitespace-pre-wrap">{m.draft.text}</p>
                )}
                {m.draft.appliedAt ? (
                  <p className="mt-2 text-xs text-muted">Applied.</p>
                ) : (
                  <button type="button" onClick={() => apply(m.id)} disabled={busy !== null} className="mt-2 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-text disabled:opacity-50">
                    {busy === m.id ? 'Applying…' : APPLY_LABEL[m.draft.kind]}
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
        {state.pending && (
          <li className="text-sm text-muted" role="status">
            The assistant is working on it…
          </li>
        )}
      </ol>
      {state.blockedReason && !state.pending && <p className="mt-3 text-sm text-amber">{state.blockedReason}</p>}
      <label htmlFor={`chat-${supportTicketId}`} className="mt-3 block text-sm">
        Ask a question
      </label>
      <textarea
        id={`chat-${supportTicketId}`}
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={!state.canSend}
        className="mt-1 w-full rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-50"
      />
      {error && (
        <p role="alert" className="mt-1 text-xs text-red">
          {error}
        </p>
      )}
      <button type="button" onClick={send} disabled={!state.canSend || busy !== null || text.trim() === ''} className="mt-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-text disabled:opacity-50">
        {busy === 'send' ? 'Sending…' : 'Send'}
      </button>
    </div>
  );
}

/** "Ask the assistant": opens the chat under an inbox item or on the ticket page. */
export function AssistantToggle({ supportTicketId }: { supportTicketId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="rounded-md border border-border px-3 py-1.5 text-sm font-medium">
        {open ? 'Hide the assistant' : 'Ask the assistant'}
      </button>
      {open && <AssistantChat supportTicketId={supportTicketId} />}
    </div>
  );
}
