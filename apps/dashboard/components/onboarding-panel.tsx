'use client';

import { MUST_ACCEPT, ISSUE_KINDS, TICKET_STATUSES, type OnboardingProposal, type OnboardingSection } from '@sdlc/shared';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { DryRunView, OnboardingView } from '@/lib/types';

const POLL_MS = 3000;

async function call<T>(url: string, method: string, body?: unknown): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  try {
    const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, data: data as T };
    const first = data.fields ? Object.values(data.fields)[0] : null;
    return { ok: false, message: String(first ?? data.message ?? 'Something went wrong.') };
  } catch {
    return { ok: false, message: 'Cannot reach the server.' };
  }
}

function Card({ title, accepted, required, children, actions }: { title: string; accepted: boolean; required?: boolean; children: ReactNode; actions: ReactNode }) {
  return (
    <section aria-label={title} className="panel p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">
          {title}
          {required && <span className="ml-2 rounded border border-border px-1.5 py-0.5 text-xs font-normal text-muted">must be accepted</span>}
        </h3>
        {accepted && <span className="text-xs text-green">Accepted</span>}
      </div>
      <div className="mt-2 text-sm">{children}</div>
      <div className="mt-3 flex flex-wrap gap-2">{actions}</div>
    </section>
  );
}

function Check({ check, label }: { check: { command: string; ok: boolean; tail: string } | null; label: string }) {
  if (!check) return <p className="text-xs text-muted">{label}: not run.</p>;
  return (
    <p className={`text-xs ${check.ok ? 'text-green' : 'text-red'}`}>
      {label}: {check.ok ? 'passed' : 'failed'} (<span className="font-mono">{check.command}</span>)
      {!check.ok && <span className="mt-1 block whitespace-pre-wrap font-mono text-muted">{check.tail}</span>}
    </p>
  );
}

/**
 * The review of an onboarding proposal (BUILD_PLAN v1 6.7): one card per section with Accept or Edit, a dry run of the intake
 * query, and Confirm. The status map and the label must be accepted explicitly.
 */
export function OnboardingPanel({ projectId, initial }: { projectId: string; initial: OnboardingView }) {
  const router = useRouter();
  const [view, setView] = useState<OnboardingView>(initial);
  const [editing, setEditing] = useState<OnboardingSection | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [dry, setDry] = useState<DryRunView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const base = `/api/projects/${encodeURIComponent(projectId)}/onboarding`;

  const load = useCallback(async () => {
    const r = await call<OnboardingView>(base, 'GET');
    if (r.ok) setView(r.data);
  }, [base]);

  useEffect(() => {
    if (view.status !== 'profiling') return;
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [view.status, load]);

  async function run<T>(what: string, fn: () => Promise<{ ok: true; data: T } | { ok: false; message: string }>, onOk: (d: T) => void) {
    setBusy(what);
    setError(null);
    const r = await fn();
    setBusy(null);
    if (r.ok) onOk(r.data);
    else setError(r.message);
  }

  const section = (s: OnboardingSection, action: 'accept' | 'edit', value?: Record<string, unknown>) =>
    run(`${s}-${action}`, () => call<OnboardingView>(`${base}/sections/${s}`, 'PATCH', { action, value }), (v) => {
      setView(v);
      setEditing(null);
    });

  if (view.status === 'profiling') {
    return (
      <div role="status" className="panel p-4 text-sm">
        <p className="font-medium">Reading the repository and your Jira project…</p>
        <p className="mt-1 text-muted">This takes a few minutes. You can leave this page: the proposal waits for you in the inbox.</p>
      </div>
    );
  }

  if (view.status === 'draft' || !view.proposal) {
    return (
      <div className="panel border-red p-4 text-sm">
        <p className="font-medium">The setup could not be proposed.</p>
        {view.error && <p className="mt-1 whitespace-pre-wrap text-red">{view.error}</p>}
        <button type="button" onClick={() => run('rerun', () => call<OnboardingView>(`${base}/rerun`, 'POST'), setView)} disabled={busy !== null} className="mt-3 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-text disabled:opacity-50">
          {busy === 'rerun' ? 'Starting…' : 'Run it again'}
        </button>
        {error && <p role="alert" className="mt-2 text-xs text-red">{error}</p>}
      </div>
    );
  }

  const p: OnboardingProposal = view.proposal;
  const jira = p.facts.jira;
  const accepted = (s: OnboardingSection) => Boolean(p.accepted[s]);
  const needs = jira ? MUST_ACCEPT.filter((s) => !accepted(s)) : [];
  const AcceptEdit = (s: OnboardingSection, onEdit: () => void) => (
    <>
      <button type="button" onClick={() => section(s, 'accept')} disabled={busy !== null} className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-text disabled:opacity-50">
        {busy === `${s}-accept` ? 'Saving…' : 'Accept'}
      </button>
      <button type="button" onClick={onEdit} aria-expanded={editing === s} className="rounded-md border border-border px-3 py-1.5 text-sm font-medium">
        Edit
      </button>
    </>
  );
  const editBox = (s: OnboardingSection, fields: { key: string; label: string; initial: string; multiline?: boolean }[], build: (v: Record<string, string>) => Record<string, unknown>) =>
    editing === s && (
      <div className="mt-3 space-y-2">
        {fields.map((f) => (
          <div key={f.key}>
            <label htmlFor={`${s}-${f.key}`} className="block text-xs text-muted">
              {f.label}
            </label>
            {f.multiline ? (
              <textarea id={`${s}-${f.key}`} rows={4} value={draft[f.key] ?? f.initial} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} className="mt-1 w-full rounded-md border border-border bg-bg px-3 py-2 font-mono text-xs outline-none focus:border-accent" />
            ) : (
              <input id={`${s}-${f.key}`} value={draft[f.key] ?? f.initial} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} className="mt-1 w-full rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent" />
            )}
          </div>
        ))}
        <button
          type="button"
          onClick={() => section(s, 'edit', build(Object.fromEntries(fields.map((f) => [f.key, draft[f.key] ?? f.initial]))))}
          disabled={busy !== null}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-text disabled:opacity-50"
        >
          Save and accept
        </button>
      </div>
    );
  const startEdit = (s: OnboardingSection) => () => {
    setDraft({});
    setEditing(editing === s ? null : s);
  };
  const lines = (m: Record<string, unknown>) => Object.entries(m).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => `${k}: ${String(v)}`).join('\n');
  const parseLines = (t: string): Record<string, string | null> =>
    Object.fromEntries(t.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf(':'); return i < 0 ? [l, null] : [l.slice(0, i).trim(), l.slice(i + 1).trim() || null]; }));

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">Nothing is used until you confirm. Accept each part or edit it first.</p>

      <Card title="Commands" accepted={accepted('commands')} actions={AcceptEdit('commands', startEdit('commands'))}>
        <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1">
          {([['Stack', p.profile.stack], ['Base branch', p.profile.baseBranch], ['Install', p.profile.installCmd], ['Typecheck', p.profile.typecheckCmd], ['Test command', p.profile.testCmdTemplate], ['KB folder', p.profile.kbDir]] as const).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className="font-mono text-xs">{v || '—'}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-2 space-y-1">
          <Check check={p.profile.installCheck} label="Install check" />
          <Check check={p.profile.typecheckCheck} label="Typecheck check" />
        </div>
        {editBox('commands', [
          { key: 'baseBranch', label: 'Base branch', initial: p.profile.baseBranch },
          { key: 'installCmd', label: 'Install command', initial: p.profile.installCmd },
          { key: 'typecheckCmd', label: 'Typecheck command', initial: p.profile.typecheckCmd },
          { key: 'testCmdTemplate', label: 'Test command (must contain {files})', initial: p.profile.testCmdTemplate },
          { key: 'kbDir', label: 'KB folder', initial: p.profile.kbDir },
        ], (v) => v)}
      </Card>

      {jira ? (
        <>
          <Card title="Jira statuses" required accepted={accepted('statusMap')} actions={AcceptEdit('statusMap', startEdit('statusMap'))}>
            <p className="text-xs text-muted">Where each pipeline state moves the Jira issue. Several states may share a status.</p>
            <ul className="mt-2 grid gap-x-6 sm:grid-cols-2">
              {TICKET_STATUSES.map((s) => (
                <li key={s} className="flex justify-between gap-2">
                  <span className="font-mono text-xs text-muted">{s}</span>
                  <span>{p.advice.statusMap[s] ?? 'not mapped'}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2">
              Plan approved when moved to: <strong>{p.advice.approvalStatuses.plan ?? 'none'}</strong> · Breakdown approved: <strong>{p.advice.approvalStatuses.breakdown ?? 'none'}</strong>
            </p>
            {editBox('statusMap', [
              { key: 'statusMap', label: 'One "STATE: Jira status" per line (leave the status empty to not map)', initial: lines(p.advice.statusMap), multiline: true },
              { key: 'plan', label: 'Plan approved status (empty for none)', initial: p.advice.approvalStatuses.plan ?? '' },
              { key: 'breakdown', label: 'Breakdown approved status (empty for none)', initial: p.advice.approvalStatuses.breakdown ?? '' },
            ], (v) => ({ statusMap: parseLines(v.statusMap ?? ''), approvalStatuses: { plan: v.plan || null, breakdown: v.breakdown || null } }))}
          </Card>

          <Card title="Issue types" accepted={accepted('routing')} actions={AcceptEdit('routing', startEdit('routing'))}>
            <ul>
              {Object.entries(p.advice.issueTypeRouting).map(([type, kind]) => (
                <li key={type} className="flex justify-between gap-2">
                  <span>{type}</span>
                  <span className={kind === 'ignore' ? 'text-muted' : ''}>{kind === 'ignore' ? 'ignored' : kind}</span>
                </li>
              ))}
            </ul>
            {editBox('routing', [{ key: 'routing', label: `One "Issue type: ${ISSUE_KINDS.join(' | ')}" per line`, initial: lines(p.advice.issueTypeRouting), multiline: true }], (v) => ({ issueTypeRouting: parseLines(v.routing ?? '') }))}
          </Card>

          <Card title="Intake label" required accepted={accepted('label')} actions={AcceptEdit('label', startEdit('label'))}>
            <p>
              Tickets with the label <strong className="font-mono">{p.advice.intakeLabel}</strong> are picked up.
            </p>
            {!jira.labels.includes(p.advice.intakeLabel) && <p className="mt-1 text-xs text-muted">No ticket uses this label yet. Jira creates a label the first time it is applied to a ticket, so add it to one to start.</p>}
            {editBox('label', [{ key: 'intakeLabel', label: 'Label', initial: p.advice.intakeLabel }], (v) => v)}
          </Card>
        </>
      ) : (
        <p className="text-sm text-muted">No Jira project: this project takes pasted tickets only.</p>
      )}

      <Card title="Confluence" accepted={accepted('confluence')} actions={AcceptEdit('confluence', startEdit('confluence'))}>
        {p.facts.confluence.spaces === null ? (
          <p className="text-muted">Confluence is not available ({p.facts.confluence.reason}). Plans will be posted to Jira instead.</p>
        ) : (
          <p>{p.advice.confluenceSpaceKey ? <>Plans are published in the space <strong>{p.advice.confluenceSpaceKey}</strong>, under a page called “sdlc-agent plans”.</> : 'No space chosen: plans go to Jira comments.'}</p>
        )}
        {p.facts.confluence.spaces && editBox('confluence', [{ key: 'confluenceSpaceKey', label: `Space key (${p.facts.confluence.spaces.map((s) => s.key).join(', ') || 'none'}), empty for none`, initial: p.advice.confluenceSpaceKey ?? '' }], (v) => ({ confluenceSpaceKey: v.confluenceSpaceKey || null }))}
      </Card>

      {jira && (
        <section aria-label="Dry run" className="panel p-4">
          <h3 className="text-sm font-medium">Dry run</h3>
          <p className="mt-1 text-xs text-muted">See which tickets the intake query would pick up right now. Nothing is changed.</p>
          <button type="button" onClick={() => run('dry', () => call<DryRunView>(`${base}/dry-run`, 'POST'), setDry)} disabled={busy !== null} className="mt-2 rounded-md border border-border px-3 py-1.5 text-sm font-medium disabled:opacity-50">
            {busy === 'dry' ? 'Checking…' : 'Run the dry run'}
          </button>
          {dry && (
            <div className="mt-3 text-sm">
              <p>{dry.count} ticket{dry.count === 1 ? '' : 's'} currently match.</p>
              <ul className="mt-1">
                {dry.tickets.map((t) => (
                  <li key={t.key}>
                    <span className="font-mono">{t.key}</span> {t.summary} <span className="text-muted">({t.issueType})</span>
                  </li>
                ))}
              </ul>
              {dry.note && <p className="mt-1 text-xs text-muted">{dry.note}</p>}
              <p className="mt-1 break-all font-mono text-xs text-muted">{dry.jql}</p>
            </div>
          )}
        </section>
      )}

      {warnings.length > 0 && (
        <ul role="status" className="text-sm text-amber">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="text-sm text-red">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy !== null || needs.length > 0}
          onClick={() => run('confirm', () => call<{ warnings: string[] }>(`${base}/confirm`, 'POST'), (d) => { setWarnings(d.warnings); router.refresh(); })}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-text disabled:opacity-50"
        >
          {busy === 'confirm' ? 'Confirming…' : 'Confirm the project'}
        </button>
        {needs.length > 0 && <span className="text-xs text-muted">Accept the Jira statuses and the label first.</span>}
        <button type="button" onClick={() => run('rerun', () => call<OnboardingView>(`${base}/rerun`, 'POST'), setView)} disabled={busy !== null} className="rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50">
          Propose again
        </button>
      </div>
    </div>
  );
}
