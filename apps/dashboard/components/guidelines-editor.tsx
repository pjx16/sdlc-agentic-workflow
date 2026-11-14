'use client';

import { formatSpec, missingPlaceholders } from '@sdlc/shared';
import { useState } from 'react';
import type { GuidelineNode } from '@/lib/types';

type Notice = { kind: 'ok' | 'error'; text: string } | null;

const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

function Tree({ nodes, selected, onSelect, depth = 0 }: { nodes: GuidelineNode[]; selected: string | null; onSelect: (path: string) => void; depth?: number }) {
  return (
    <ul className={depth === 0 ? '' : 'ml-3 border-l border-border pl-2'}>
      {nodes.map((n) => (
        <li key={n.path}>
          {n.type === 'dir' ? (
            <>
              <span className="block px-2 py-1 text-xs uppercase tracking-wide text-muted">{n.name}</span>
              <Tree nodes={n.children ?? []} selected={selected} onSelect={onSelect} depth={depth + 1} />
            </>
          ) : (
            <button
              type="button"
              onClick={() => onSelect(n.path)}
              aria-current={selected === n.path ? 'true' : undefined}
              className={`block w-full rounded-md px-2 py-1 text-left text-sm ${selected === n.path ? 'bg-accent text-accent-text' : 'text-muted hover:bg-bg hover:text-text'}`}
            >
              {n.name}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Edits the markdown files under `guidelines/`. Changes apply from the next stage run. */
export function GuidelinesEditor({ tree }: { tree: GuidelineNode[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const dirty = selected !== null && text !== saved;

  async function open(path: string) {
    if (path === selected) return;
    if (dirty && !window.confirm('You have unsaved changes. Discard them?')) return;
    setLoading(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/guidelines/${encodePath(path)}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotice({ kind: 'error', text: body.message ?? 'Could not open the file.' });
        return;
      }
      setSelected(path);
      setSaved(body.content);
      setText(body.content);
    } catch {
      setNotice({ kind: 'error', text: 'Cannot reach the server.' });
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    if (!selected) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/guidelines/${encodePath(selected)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: text }) });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setSaved(text);
        setNotice({ kind: 'ok', text: 'Saved. Changes apply from the next stage run.' });
      } else {
        setNotice({ kind: 'error', text: body.fields ? Object.values(body.fields).join(' ') : (body.message ?? 'Could not save.') });
      }
    } catch {
      setNotice({ kind: 'error', text: 'Cannot reach the server.' });
    } finally {
      setBusy(false);
    }
  }

  const format = selected?.startsWith('formats/') ? formatSpec(selected.slice('formats/'.length).replace(/\.md$/, '')) : undefined;
  const missing = format ? missingPlaceholders(format.name, text) : [];

  return (
    <div className="grid gap-6 md:grid-cols-[16rem_1fr]">
      <nav aria-label="Guideline files" className="panel p-3">
        {tree.length === 0 ? <p className="text-sm text-muted">No guideline files found.</p> : <Tree nodes={tree} selected={selected} onSelect={open} />}
      </nav>
      <div>
        {selected === null ? (
          <p className="text-sm text-muted">{loading ? 'Loading…' : 'Choose a file to edit. Changes apply from the next stage run.'}</p>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-mono text-sm">
                {selected}
                {dirty && <span className="ml-2 text-amber">● unsaved</span>}
              </h2>
              <button type="button" onClick={save} disabled={busy || !dirty} className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-text disabled:opacity-60">
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
            {format && (
              <section aria-label="About this format" className="panel space-y-2 p-3 text-sm">
                <p>
                  <span className="font-medium">{format.title}.</span> {format.description}
                </p>
                {format.placeholders.length > 0 && (
                  <ul className="space-y-0.5 text-xs text-muted">
                    {format.placeholders.map((p) => (
                      <li key={p.name}>
                        <code className="text-text">{`{{${p.name}}}`}</code> {p.meaning}
                      </li>
                    ))}
                  </ul>
                )}
                {missing.length > 0 && (
                  <p role="alert" className="text-xs text-amber">
                    Missing {missing.map((m) => `{{${m}}}`).join(', ')}: that part will not appear.
                  </p>
                )}
                <button type="button" onClick={() => setText(format.default)} disabled={text === format.default} className="rounded-md border border-border px-3 py-1 text-xs disabled:opacity-50">
                  Reset to the default
                </button>
              </section>
            )}
            <label htmlFor="guideline-text" className="sr-only">
              Content of {selected}
            </label>
            <textarea
              id="guideline-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
              rows={28}
              className="w-full rounded-md border border-border bg-bg px-3 py-2 font-mono text-sm outline-none focus:border-accent"
            />
          </div>
        )}
        {notice && (
          <p role={notice.kind === 'error' ? 'alert' : 'status'} className={`mt-3 text-sm ${notice.kind === 'error' ? 'text-red' : 'text-green'}`}>
            {notice.text}
          </p>
        )}
      </div>
    </div>
  );
}
