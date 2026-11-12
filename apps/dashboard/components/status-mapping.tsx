'use client';

import { useEffect, useState } from 'react';
import { TICKET_STATUSES } from '@sdlc/shared';
import { Select, Text, useForm } from './form';
import { getIn } from '@/lib/form';

type Load = { state: 'idle' } | { state: 'loading' } | { state: 'ok'; statuses: string[] } | { state: 'error'; message: string };

const NOT_MAPPED = { value: '', label: 'Not mapped' };

/**
 * One row per pipeline state: which Jira status to move the issue to (F15). In REST mode (for a saved project) the
 * choices come from Jira; in MCP mode, or if Jira cannot be reached, the status name is typed.
 */
export function StatusMapping({ projectId, mode }: { projectId?: string; mode: 'rest' | 'mcp' }) {
  const { values } = useForm();
  const [load, setLoad] = useState<Load>({ state: 'idle' });

  useEffect(() => {
    if (mode !== 'rest' || !projectId) {
      setLoad({ state: 'idle' });
      return;
    }
    let cancelled = false;
    setLoad({ state: 'loading' });
    fetch(`/api/projects/${encodeURIComponent(projectId)}/jira/statuses`)
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (res.ok && Array.isArray(body)) setLoad({ state: 'ok', statuses: body as string[] });
        else setLoad({ state: 'error', message: (body && typeof body === 'object' && 'message' in body ? String((body as { message: unknown }).message) : null) ?? `Jira answered ${res.status}` });
      })
      .catch(() => !cancelled && setLoad({ state: 'error', message: 'Cannot reach the server' }));
    return () => {
      cancelled = true;
    };
  }, [mode, projectId]);

  const known = load.state === 'ok' ? new Set(load.statuses.map((s) => s.toLowerCase())) : null;
  const missing = known ? TICKET_STATUSES.filter((s) => {
    const v = String(getIn(values, `settings.jiraStatusMap.${s}`) ?? '').trim();
    return v !== '' && !known.has(v.toLowerCase());
  }) : [];

  return (
    <fieldset className="sm:col-span-2">
      <legend className="text-sm">Status mapping (pipeline status to Jira status)</legend>
      {mode === 'rest' && !projectId && <p className="mt-1 text-xs text-muted">Save the project first to choose from the statuses in Jira. Until then, type the status name.</p>}
      {mode === 'rest' && projectId && load.state === 'loading' && <p className="mt-1 text-xs text-muted">Loading statuses from Jira…</p>}
      {load.state === 'error' && (
        <p role="alert" className="mt-1 text-xs text-amber">
          ⚠ Could not load statuses from Jira: {load.message}. Type the status names instead.
        </p>
      )}
      {missing.length > 0 && (
        <p role="alert" className="mt-1 text-xs text-amber">
          ⚠ Not a status in this Jira project: {missing.map((s) => `${s} → "${String(getIn(values, `settings.jiraStatusMap.${s}`))}"`).join(', ')}. The Jira move will fail until this is fixed.
        </p>
      )}
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        {TICKET_STATUSES.map((status) => {
          const path = `settings.jiraStatusMap.${status}`;
          if (load.state !== 'ok') return <Text key={status} path={path} label={status} placeholder="Not mapped" />;
          const current = String(getIn(values, path) ?? '').trim();
          const options = [NOT_MAPPED, ...load.statuses.map((s) => ({ value: s, label: s }))];
          if (current !== '' && !known?.has(current.toLowerCase())) options.push({ value: current, label: `${current} (not in Jira)` });
          return <Select key={status} path={path} label={status} options={options} />;
        })}
      </div>
    </fieldset>
  );
}
