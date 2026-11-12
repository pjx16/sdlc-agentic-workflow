import Link from 'next/link';
import type { SetupStatus } from '@sdlc/shared';
import { ChangePasswordForm } from '@/components/change-password-form';
import { SettingsForm } from '@/components/settings-form';
import { apiGet } from '@/lib/server-api';
import type { SystemView } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const system = await apiGet<SystemView>('/system');
  if (!system) throw new Error('GET /system returned 404');
  const status = await apiGet<SetupStatus>('/setup/status');
  return (
    <section>
      <h1 className="mb-6 text-2xl font-semibold">Settings</h1>
      <div className="mb-8 panel p-6">
        <h2 className="text-lg font-semibold">Connections</h2>
        <p className="mt-1 text-sm text-muted">The Claude, GitHub and Jira tokens and the git identity.</p>
        <Link href="/setup/connections" className="mt-3 inline-block rounded-md border border-border px-3 py-2 text-sm">
          Manage connections
        </Link>
      </div>
      {!status?.passwordFromEnv && <ChangePasswordForm />}
      <SettingsForm settings={system.settings} />
    </section>
  );
}
