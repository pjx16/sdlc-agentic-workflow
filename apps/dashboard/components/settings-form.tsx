'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { FormProvider, Num, Section, Text, TextArea } from './form';
import { setIn, type FormValues } from '@/lib/form';
import { initialSettingsValues, toSettingsPayload } from '@/lib/settings-form';
import type { GlobalSettingsView } from '@/lib/types';

export function SettingsForm({ settings }: { settings: GlobalSettingsView }) {
  const router = useRouter();
  const [values, setValues] = useState<FormValues>(() => initialSettingsValues(settings));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
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
      const res = await fetch('/api/system/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(toSettingsPayload(values)),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setErrors({});
        setValues(initialSettingsValues(body));
        setMessage({ kind: 'ok', text: 'Saved. Changes apply from the next stage run.' });
        router.refresh();
      } else if (res.status === 400 && body.fields) {
        setErrors(body.fields);
        setMessage({ kind: 'error', text: 'Some fields need attention.' });
      } else {
        setMessage({ kind: 'error', text: body.message ?? 'Could not save the settings.' });
      }
    } catch {
      setMessage({ kind: 'error', text: 'Cannot reach the server.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormProvider value={{ values, errors, set }}>
      <form onSubmit={submit} className="max-w-4xl space-y-6" noValidate>
        <Section title="Usage gate" description="The pipeline pauses when usage passes these thresholds (percent of the plan window).">
          <Num path="usageThresholdPct" label="5-hour threshold (%)" />
          <Num path="usageThresholdWeeklyPct" label="Weekly threshold (%)" />
          <Num path="calibratedWindowTokens" label="Calibrated window tokens" hint="Optional. Leave empty if not calibrated." />
        </Section>

        <Section title="Polling and timeouts">
          <Num path="pollIntervalSec" label="Poll interval (seconds)" />
          <Num path="stageTimeoutMin" label="Stage timeout (minutes)" />
          <Num path="verifyTimeoutSec" label="Verify timeout (seconds)" hint="Install, typecheck and test commands." />
        </Section>

        <Section title="Retention">
          <Num path="workspaceRetentionDays" label="Workspace retention (days)" />
          <Num path="logRetentionDays" label="Log retention (days)" />
        </Section>

        <Section title="Model aliases" description="What each alias passed to the CLI resolves to.">
          <Text path="modelAliases.haiku" label="haiku" />
          <Text path="modelAliases.sonnet" label="sonnet" />
          <Text path="modelAliases.opus" label="opus" />
        </Section>

        <div className="flex items-center gap-4">
          <button type="submit" disabled={busy} className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-text disabled:opacity-60">
            {busy ? 'Saving…' : 'Save settings'}
          </button>
          {message && (
            <p role={message.kind === 'error' ? 'alert' : 'status'} className={`text-sm ${message.kind === 'error' ? 'text-red' : 'text-green'}`}>
              {message.text}
            </p>
          )}
        </div>
      </form>
    </FormProvider>
  );
}
