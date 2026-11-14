'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { TICKET_KINDS } from '@sdlc/shared';
import { FormProvider, Section, Select, Text, TextArea } from './form';
import { setIn, type FormValues } from '@/lib/form';

/** Paste a ticket into a project (F3). Works in every Jira mode. */
export function TicketForm({ projects, template = '' }: { projects: { id: string; name: string; mirrorStatus: string; enabled: boolean; onboardingStatus?: string }[]; /** The team's ticket format (guidelines/formats/ticket.md): the description starts with it. */ template?: string }) {
  const router = useRouter();
  const usable = projects.filter((p) => p.enabled && (p.onboardingStatus ?? 'confirmed') === 'confirmed');
  const [values, setValues] = useState<FormValues>({ projectId: usable[0]?.id ?? '', title: '', body: template, kind: 'feature', featureKey: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (path: string, value: unknown) => {
    setValues((v) => setIn(v, path, value));
    setErrors((e) => {
      if (!(path in e)) return e;
      const { [path]: _removed, ...rest } = e; // eslint-disable-line @typescript-eslint/no-unused-vars
      return rest;
    });
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/tickets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(values) });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        router.push(`/tickets/${body.id}`);
        return;
      }
      if (res.status === 400 && body.fields) {
        setErrors(body.fields);
        setMessage('Some fields need attention.');
      } else {
        setMessage(body.message ?? 'Could not create the ticket.');
      }
    } catch {
      setMessage('Cannot reach the server.');
    } finally {
      setBusy(false);
    }
  }

  if (usable.length === 0) return <p className="text-sm text-muted">There is no enabled project yet. Create a project first.</p>;

  return (
    <FormProvider value={{ values, errors, set }}>
      <form onSubmit={submit} className="max-w-3xl space-y-6" noValidate>
        <Section title="Ticket">
          <Select path="projectId" label="Project" options={usable.map((p) => ({ value: p.id, label: p.mirrorStatus === 'ok' ? p.name : `${p.name} (mirror ${p.mirrorStatus})` }))} />
          <Select path="kind" label="Kind" options={TICKET_KINDS.map((k) => ({ value: k, label: k }))} />
          <div className="sm:col-span-2">
            <Text path="title" label="Title" />
          </div>
          <div className="sm:col-span-2">
            <TextArea path="body" label="Description" rows={8} hint="Markdown. This is all the agent knows about the work." />
          </div>
          <Text path="featureKey" label="Feature key (optional)" hint="Names the KB doc for this feature, e.g. billing-export." />
        </Section>
        <div className="flex items-center gap-4">
          <button type="submit" disabled={busy} className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-text disabled:opacity-60">
            {busy ? 'Creating…' : 'Create ticket'}
          </button>
          {message && (
            <p role="alert" className="text-sm text-red">
              {message}
            </p>
          )}
        </div>
      </form>
    </FormProvider>
  );
}
