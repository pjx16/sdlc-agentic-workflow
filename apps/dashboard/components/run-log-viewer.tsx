'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatLogLine, type LogKind } from '@/lib/log-format';

const MAX_LINES = 5000;

type Phase = 'connecting' | 'live' | 'finished' | 'lost';

const COLORS: Record<LogKind, string> = {
  system: 'text-muted',
  assistant: 'text-text',
  tool: 'text-muted',
  result: 'text-green',
  error: 'text-red',
  text: 'text-text',
};

/** Streams a run's log over server-sent events (GET /api/runs/:id/log) and shows it as it arrives. */
export function RunLogViewer({ runId }: { runId: string }) {
  const [lines, setLines] = useState<string[]>([]);
  const [phase, setPhase] = useState<Phase>('connecting');
  const [endStatus, setEndStatus] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);
  const [generation, setGeneration] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLines([]);
    setEndStatus(null);
    setPhase('connecting');
    const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/log`);
    source.onopen = () => setPhase((p) => (p === 'connecting' ? 'live' : p));
    source.onmessage = (event) => {
      setPhase('live');
      setLines((prev) => (prev.length >= MAX_LINES ? [...prev.slice(prev.length - MAX_LINES + 1), event.data] : [...prev, event.data]));
    };
    source.addEventListener('end', (event) => {
      setEndStatus((event as MessageEvent).data as string);
      setPhase('finished');
      source.close();
    });
    // EventSource would reconnect and replay the log from the start, duplicating lines; reconnect explicitly instead.
    source.onerror = () => {
      setPhase((p) => (p === 'finished' ? p : 'lost'));
      source.close();
    };
    return () => source.close();
  }, [runId, generation]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ block: 'end' });
  }, [lines.length]);

  const reconnect = useCallback(() => setGeneration((g) => g + 1), []);
  const badge = { connecting: 'Connecting…', live: 'Live', finished: `Finished${endStatus ? ` (${endStatus})` : ''}`, lost: 'Connection lost' }[phase];
  const dot = { connecting: 'bg-grey', live: 'bg-green', finished: 'bg-grey', lost: 'bg-red' }[phase];

  return (
    <div className="panel">
      <div className="flex items-center justify-between border-b border-border px-4 py-2 text-sm">
        <span className="flex items-center gap-2" role="status">
          <span aria-hidden className={`inline-block h-2 w-2 rounded-full ${dot}`} />
          {badge}
        </span>
        <span className="flex items-center gap-3">
          {phase === 'lost' && (
            <button type="button" onClick={reconnect} className="rounded-md border border-border px-2 py-1 text-muted hover:text-text">
              Reconnect
            </button>
          )}
          <label className="flex items-center gap-2 text-muted">
            <input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} />
            Raw
          </label>
        </span>
      </div>
      <div className="max-h-[70vh] overflow-auto p-4 font-mono text-xs leading-relaxed" data-testid="log">
        {lines.length === 0 && phase !== 'lost' && <p className="text-muted">Waiting for output…</p>}
        {lines.map((line, i) => {
          if (raw) return <div key={i} className="whitespace-pre-wrap break-all">{line}</div>;
          const entry = formatLogLine(line);
          if (!entry) return null;
          return (
            <div key={i} className={`whitespace-pre-wrap break-words ${COLORS[entry.kind]}`}>
              {entry.text}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
