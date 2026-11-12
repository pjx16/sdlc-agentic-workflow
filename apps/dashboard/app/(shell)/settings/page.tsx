import { SettingsForm } from '@/components/settings-form';
import { apiGet } from '@/lib/server-api';
import type { SystemView } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const system = await apiGet<SystemView>('/system');
  if (!system) throw new Error('GET /system returned 404');
  return (
    <section>
      <h1 className="mb-6 text-2xl font-semibold">Settings</h1>
      <SettingsForm settings={system.settings} />
    </section>
  );
}
