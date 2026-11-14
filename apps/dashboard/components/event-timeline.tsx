'use client';

import { ERROR_POLICY, isErrorCode } from '@sdlc/shared';
import Link from 'next/link';
import { useState } from 'react';
import { formatDateTime } from '@/lib/ticket-status';
import type { RunView, TicketEventView } from '@/lib/types';

const DOT: Record<TicketEventView['level'], string> = { info: 'bg-grey', warn: 'bg-amber', error: 'bg-red' };
const LEVEL_TEXT: Record<TicketEventView['level'], string> = { info: 'Info', warn: 'Warning', error: 'Error' };

interface Props {
  events: TicketEventView[];
  /** Stage runs of the ticket: an event about a run links to its raw log. Stale runs (reruns) are greyed. */
  runs?: (RunView & { supersededAt?: string | null })[];
}

/**
 * One stream of everything that happened to a ticket, in plain English (BUILD_PLAN v1 6.4): state changes, stage runs with
 * their duration and cost, decisions, errors and reruns. "Problems only" shows warnings and errors.
 */
export function EventTimeline({ events, runs = [] }: Props) {
  const [problemsOnly, setProblemsOnly] = useState(false);
  const shown = problemsOnly ? events.filter((e) => e.level !== 'info') : events;
  const runById = new Map(runs.map((r) => [r.id, r]));
  if (events.length === 0) return <p className="text-sm text-muted">Nothing has happened to this ticket yet.</p>;
  return (
    <div>
      <label className="mb-3 flex items-center gap-2 text-sm text-muted">
        <input type="checkbox" checked={problemsOnly} onChange={(e) => setProblemsOnly(e.target.checked)} />
        Problems only
      </label>
      <ol aria-label="Ticket timeline" className="space-y-2">
        {shown.map((e) => {
          const run = e.stageRunId ? runById.get(e.stageRunId) : undefined;
          const stale = Boolean(run?.supersededAt);
          return (
            <li key={e.id} data-level={e.level} className={`flex gap-3 text-sm ${stale ? 'opacity-50' : ''}`}>
              <span aria-hidden className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[e.level]}`} />
              <div className="min-w-0 flex-1">
                <p className={e.level === 'error' ? 'text-red' : ''}>
                  <span className="sr-only">{LEVEL_TEXT[e.level]}: </span>
                  {e.message}
                  {stale && <span className="ml-2 rounded border border-border px-1 text-xs text-muted">stale</span>}
                </p>
                <p className="text-xs text-muted">
                  {formatDateTime(e.at)} · {e.source}
                  {e.stageRunId && (
                    <>
                      {' · '}
                      <Link href={`/runs/${e.stageRunId}`} className="text-accent hover:underline">
                        raw log
                      </Link>
                    </>
                  )}
                </p>
                {isErrorCode(e.errorCode) && <p className="text-xs text-muted">{ERROR_POLICY[e.errorCode].action}</p>}
              </div>
            </li>
          );
        })}
      </ol>
      {shown.length === 0 && <p className="text-sm text-muted">No warnings or errors.</p>}
    </div>
  );
}
