'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface Props {
  ticketId: string;
  status: string;
  planMarkdown: string | null;
  /** The Confluence page of the current plan, when the project publishes plans there. */
  confluenceUrl?: string | null;
}

type Notice = { kind: 'ok' | 'error'; text: string } | null;

/**
 * The plan and its gate (F7). While the ticket awaits plan approval the plan can be edited, approved or rejected with a
 * note; at any other time it is shown read-only.
 */
export function PlanPanel({ ticketId, status, planMarkdown, confluenceUrl }: Props) {
  const router = useRouter();
  const awaiting = status === 'AWAITING_PLAN_APPROVAL';
  const [text, setText] = useState(planMarkdown ?? '');
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);

  async function send(action: 'approve' | 'reject', body: Record<string, string>) {
    setBusy(true);
    setNotice(null);
    setErrors({});
    try {
      const res = await fetch(`/api/tickets/${encodeURIComponent(ticketId)}/plan/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setNotice({ kind: 'ok', text: action === 'approve' ? 'Plan approved. The ticket moves on to breakdown.' : 'Plan rejected. It will be planned again with your note.' });
        router.refresh();
        return;
      }
      if (res.status === 400 && data.fields) setErrors(data.fields);
      setNotice({ kind: 'error', text: res.status === 409 ? (data.message ?? 'The ticket is no longer awaiting plan approval.') : (data.message ?? 'Something went wrong.') });
    } catch {
      setNotice({ kind: 'error', text: 'Cannot reach the server.' });
    } finally {
      setBusy(false);
    }
  }

  const pageLink = confluenceUrl ? (
    <a href={confluenceUrl} className="text-sm text-accent hover:underline">
      Open in Confluence
    </a>
  ) : null;

  if (!awaiting) {
    return planMarkdown ? (
      <div className="space-y-2">
        {pageLink}
        <pre className="whitespace-pre-wrap panel p-4 font-sans text-sm">{planMarkdown}</pre>
      </div>
    ) : (
      <p className="text-sm text-muted">No plan yet. It appears here once the plan stage has run.</p>
    );
  }

  const edited = text.trim() !== (planMarkdown ?? '').trim();
  return (
    <div className="space-y-4">
      {pageLink}
      <p className="text-sm text-muted">Review the plan. You can edit it before approving; the edited text is what the next stages use.</p>
      <div>
        <label htmlFor="plan-text" className="block text-sm">
          Plan
        </label>
        <textarea
          id="plan-text"
          rows={18}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-invalid={errors.planMarkdown ? true : undefined}
          className="mt-1 w-full rounded-md border border-border bg-bg px-3 py-2 font-mono text-sm outline-none focus:border-accent"
        />
        {errors.planMarkdown && (
          <p role="alert" className="mt-1 text-xs text-red">
            {errors.planMarkdown}
          </p>
        )}
      </div>

      {rejecting && (
        <div>
          <label htmlFor="reject-note" className="block text-sm">
            What should change?
          </label>
          <textarea
            id="reject-note"
            rows={4}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-invalid={errors.note ? true : undefined}
            className="mt-1 w-full rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
          />
          {errors.note && (
            <p role="alert" className="mt-1 text-xs text-red">
              {errors.note}
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy || text.trim() === ''}
          onClick={() => send('approve', edited ? { planMarkdown: text } : {})}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-text disabled:opacity-60"
        >
          {edited ? 'Approve with edits' : 'Approve'}
        </button>
        {!rejecting ? (
          <button type="button" disabled={busy} onClick={() => setRejecting(true)} className="rounded-md border border-border px-4 py-2 text-sm hover:text-text">
            Reject…
          </button>
        ) : (
          <>
            <button type="button" disabled={busy} onClick={() => send('reject', { note })} className="rounded-md border border-border px-4 py-2 text-sm hover:text-text disabled:opacity-60">
              Send rejection
            </button>
            <button type="button" disabled={busy} onClick={() => { setRejecting(false); setErrors({}); }} className="px-2 py-2 text-sm text-muted hover:text-text">
              Cancel
            </button>
          </>
        )}
        {notice && (
          <p role={notice.kind === 'error' ? 'alert' : 'status'} className={`text-sm ${notice.kind === 'error' ? 'text-red' : 'text-green'}`}>
            {notice.text}
          </p>
        )}
      </div>
    </div>
  );
}
