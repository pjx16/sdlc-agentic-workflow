'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { SupportQueryView } from '@/lib/types';

function AnswerBox({ query }: { query: SupportQueryView }) {
  const router = useRouter();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/support-queries/${encodeURIComponent(query.id)}/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answer: text }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        router.refresh();
        return;
      }
      setError(res.status === 400 ? (data.fields?.answer ?? data.message) : (data.message ?? 'Something went wrong.'));
      if (res.status === 409) router.refresh();
    } catch {
      setError('Cannot reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3">
      <label htmlFor={`answer-${query.id}`} className="block text-sm">
        Your answer
      </label>
      <textarea
        id={`answer-${query.id}`}
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-invalid={error ? true : undefined}
        className="mt-1 w-full rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
      />
      {error && (
        <p role="alert" className="mt-1 text-xs text-red">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={submit}
        disabled={busy || text.trim() === ''}
        className="mt-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-text disabled:opacity-50"
      >
        {busy ? 'Sending…' : 'Answer'}
      </button>
    </div>
  );
}

/** Open questions first, each with its ticket, stage, the question and an answer box (F13). Answered ones follow, read-only. */
export function SupportList({ queries }: { queries: SupportQueryView[] }) {
  if (queries.length === 0) {
    return <p className="mt-4 text-sm text-muted">No questions. When a stage cannot continue without an answer, it appears here.</p>;
  }
  const open = queries.filter((q) => q.status === 'open');
  const answered = queries.filter((q) => q.status === 'answered');
  return (
    <div className="mt-4 space-y-8">
      <div>
        <h2 className="text-sm font-medium">Open ({open.length})</h2>
        {open.length === 0 && <p className="mt-2 text-sm text-muted">Nothing is waiting for an answer.</p>}
        <ul className="mt-2 space-y-3">
          {open.map((q) => (
            <li key={q.id} className="panel p-4">
              <p className="text-xs text-muted">
                <Link href={`/tickets/${q.ticketId}`} className="font-medium text-fg underline">
                  {q.ticketKey}
                </Link>{' '}
                · {q.ticketTitle} · stage <span className="font-mono">{q.stage}</span>
              </p>
              <p className="mt-2 whitespace-pre-wrap text-sm">{q.question}</p>
              <AnswerBox query={q} />
            </li>
          ))}
        </ul>
      </div>
      {answered.length > 0 && (
        <div>
          <h2 className="text-sm font-medium">Answered ({answered.length})</h2>
          <ul className="mt-2 space-y-3">
            {answered.map((q) => (
              <li key={q.id} className="rounded-lg border border-border p-4">
                <p className="text-xs text-muted">
                  <Link href={`/tickets/${q.ticketId}`} className="underline">
                    {q.ticketKey}
                  </Link>{' '}
                  · stage <span className="font-mono">{q.stage}</span>
                </p>
                <p className="mt-2 whitespace-pre-wrap text-sm">{q.question}</p>
                <p className="mt-2 whitespace-pre-wrap text-sm text-muted">Answer: {q.answer}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
