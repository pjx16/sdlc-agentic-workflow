'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { validateBreakdown, type SubtaskDraft } from '@sdlc/shared';
import { addItem, moveItem, removeItem, toDrafts, toEditItems, type EditItem } from '@/lib/breakdown-edit';
import type { SubtaskRow } from '@/lib/types';

interface Props {
  ticketId: string;
  status: string;
  draft: SubtaskDraft[] | null;
  subtasks: SubtaskRow[];
  maxSubtasks: number;
}

type Notice = { kind: 'ok' | 'error'; text: string } | null;

const inputClass = 'mt-1 w-full rounded-md border bg-bg px-3 py-2 text-sm outline-none focus:border-accent';

function FieldError({ message }: { message?: string }) {
  return message ? (
    <p role="alert" className="mt-1 text-xs text-red">
      {message}
    </p>
  ) : null;
}

/**
 * The breakdown and its gate (F8). While the ticket awaits breakdown approval the list can be edited (titles, descriptions,
 * criteria, files, dependencies, order) with the same validation the server applies; afterwards the created subtasks are shown.
 */
export function BreakdownPanel({ ticketId, status, draft, subtasks, maxSubtasks }: Props) {
  const router = useRouter();
  const awaiting = status === 'AWAITING_BREAKDOWN_APPROVAL';
  // The stored draft comes back from a JSON column, which does not keep key order: compare it in the same normal form as the edited list.
  const original = useMemo(() => {
    const normal = validateBreakdown(draft ?? [], { maxSubtasks });
    return normal.ok ? normal.subtasks : (draft ?? []);
  }, [draft, maxSubtasks]);
  const [items, setItems] = useState<EditItem[]>(() => toEditItems(original));
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);

  const verdict = useMemo(() => validateBreakdown(toDrafts(items), { maxSubtasks }), [items, maxSubtasks]);
  const issues: Record<string, string> = {};
  if (!verdict.ok) for (const i of verdict.issues) if (!(i.field in issues)) issues[i.field] = i.message;
  const errors = { ...serverErrors, ...issues };
  const edited = verdict.ok && JSON.stringify(verdict.subtasks) !== JSON.stringify(original);

  const change = (next: EditItem[]) => {
    setItems(next);
    setServerErrors({});
  };
  const update = (index: number, patch: Partial<EditItem>) => change(items.map((it, i) => (i === index ? { ...it, ...patch } : it)));

  async function send(action: 'approve' | 'reject', body: Record<string, unknown>) {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/tickets/${encodeURIComponent(ticketId)}/breakdown/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setNotice({ kind: 'ok', text: action === 'approve' ? 'Breakdown approved. The subtasks were created and work begins.' : 'Breakdown rejected. It will be split again with your note.' });
        router.refresh();
        return;
      }
      if (res.status === 400 && data.fields) setServerErrors(data.fields);
      setNotice({ kind: 'error', text: data.message ?? 'Something went wrong.' });
    } catch {
      setNotice({ kind: 'error', text: 'Cannot reach the server.' });
    } finally {
      setBusy(false);
    }
  }

  if (!awaiting) {
    if (subtasks.length === 0) return <p className="text-sm text-muted">No breakdown yet. It appears here once the breakdown stage has run.</p>;
    return (
      <ol className="space-y-3">
        {subtasks.map((s) => (
          <li key={s.id} className="panel p-4 text-sm">
            <div className="flex items-center justify-between">
              <span className="font-medium">
                {s.seq}. {s.title}
              </span>
              <span className="text-muted">{s.status}</span>
            </div>
            {s.description && <p className="mt-2 whitespace-pre-wrap text-muted">{s.description}</p>}
            <ul className="mt-2 list-disc pl-5">
              {s.acceptanceCriteria.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            {s.dependsOn.length > 0 && <p className="mt-2 text-xs text-muted">Depends on: {s.dependsOn.join(', ')}</p>}
          </li>
        ))}
      </ol>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">Review the subtasks. You can edit them before approving. At most {maxSubtasks} subtasks; each may depend only on earlier ones.</p>
      {errors.subtasks && (
        <p role="alert" className="text-sm text-red">
          {errors.subtasks}
        </p>
      )}

      <ol className="space-y-4">
        {items.map((item, i) => (
          <li key={i} className="panel p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">Subtask {item.seq}</h3>
              <span className="flex gap-2">
                <button type="button" aria-label={`Move subtask ${item.seq} up`} disabled={i === 0} onClick={() => change(moveItem(items, i, -1))} className="rounded-md border border-border px-2 py-1 text-xs disabled:opacity-40">
                  ↑
                </button>
                <button type="button" aria-label={`Move subtask ${item.seq} down`} disabled={i === items.length - 1} onClick={() => change(moveItem(items, i, 1))} className="rounded-md border border-border px-2 py-1 text-xs disabled:opacity-40">
                  ↓
                </button>
                <button type="button" aria-label={`Remove subtask ${item.seq}`} onClick={() => change(removeItem(items, i))} className="rounded-md border border-border px-2 py-1 text-xs text-red">
                  Remove
                </button>
              </span>
            </div>
            <div className="mt-3 grid gap-3">
              <div>
                <label htmlFor={`t-${i}`} className="block text-sm">
                  Title {item.seq}
                </label>
                <input id={`t-${i}`} value={item.title} onChange={(e) => update(i, { title: e.target.value })} aria-invalid={errors[`subtasks.${i}.title`] ? true : undefined} className={`${inputClass} ${errors[`subtasks.${i}.title`] ? 'border-red' : 'border-border'}`} />
                <FieldError message={errors[`subtasks.${i}.title`]} />
              </div>
              <div>
                <label htmlFor={`d-${i}`} className="block text-sm">
                  Description {item.seq}
                </label>
                <textarea id={`d-${i}`} rows={3} value={item.description} onChange={(e) => update(i, { description: e.target.value })} className={`${inputClass} border-border`} />
              </div>
              <div>
                <label htmlFor={`c-${i}`} className="block text-sm">
                  Acceptance criteria {item.seq} (one per line)
                </label>
                <textarea id={`c-${i}`} rows={3} value={item.criteria} onChange={(e) => update(i, { criteria: e.target.value })} aria-invalid={errors[`subtasks.${i}.acceptanceCriteria`] ? true : undefined} className={`${inputClass} ${errors[`subtasks.${i}.acceptanceCriteria`] ? 'border-red' : 'border-border'}`} />
                <FieldError message={errors[`subtasks.${i}.acceptanceCriteria`]} />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor={`f-${i}`} className="block text-sm">
                    Files {item.seq} (one per line)
                  </label>
                  <textarea id={`f-${i}`} rows={2} value={item.files} onChange={(e) => update(i, { files: e.target.value })} className={`${inputClass} border-border font-mono`} />
                </div>
                <div>
                  <label htmlFor={`p-${i}`} className="block text-sm">
                    Depends on {item.seq} (numbers)
                  </label>
                  <input id={`p-${i}`} value={item.dependsOn} onChange={(e) => update(i, { dependsOn: e.target.value })} aria-invalid={errors[`subtasks.${i}.dependsOn`] ? true : undefined} className={`${inputClass} ${errors[`subtasks.${i}.dependsOn`] ? 'border-red' : 'border-border'}`} />
                  <FieldError message={errors[`subtasks.${i}.dependsOn`]} />
                </div>
              </div>
            </div>
          </li>
        ))}
      </ol>
      <button type="button" disabled={items.length >= maxSubtasks} onClick={() => change(addItem(items))} className="rounded-md border border-border px-3 py-2 text-sm hover:text-text disabled:opacity-50">
        Add subtask
      </button>

      {rejecting && (
        <div>
          <label htmlFor="reject-note" className="block text-sm">
            What should change?
          </label>
          <textarea id="reject-note" rows={4} value={note} onChange={(e) => setNote(e.target.value)} aria-invalid={serverErrors.note ? true : undefined} className={`${inputClass} border-border`} />
          <FieldError message={serverErrors.note} />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" disabled={busy || !verdict.ok} onClick={() => send('approve', edited && verdict.ok ? { subtasks: verdict.subtasks } : {})} className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-text disabled:opacity-60">
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
            <button type="button" disabled={busy} onClick={() => { setRejecting(false); setServerErrors({}); }} className="px-2 py-2 text-sm text-muted hover:text-text">
              Cancel
            </button>
          </>
        )}
        {!verdict.ok && <span className="text-sm text-amber">Fix the highlighted fields to approve.</span>}
        {notice && (
          <p role={notice.kind === 'error' ? 'alert' : 'status'} className={`text-sm ${notice.kind === 'error' ? 'text-red' : 'text-green'}`}>
            {notice.text}
          </p>
        )}
      </div>
    </div>
  );
}
