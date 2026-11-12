import Link from 'next/link';
import type { CredentialView } from '@sdlc/shared';
import { CredentialsForm } from '@/components/credentials-form';
import { apiGet } from '@/lib/server-api';
import type { SetupStatus } from '@sdlc/shared';

export const dynamic = 'force-dynamic';

export default async function ConnectionsPage() {
  const [views, status] = await Promise.all([apiGet<CredentialView[]>('/credentials'), apiGet<SetupStatus>('/setup/status')]);
  return (
    <section className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold">Connections</h1>
      <p className="mb-6 mt-2 text-sm text-muted">
        Add the tokens the pipeline needs. They are stored encrypted in your local database. A value set in <code>.env</code> overrides the dashboard. You can skip any step and come back later,
        but the pipeline stays blocked until the Claude token, the GitHub token and the git identity are set.
      </p>
      <CredentialsForm initial={views ?? []} encryptionKeyOk={status?.encryptionKeyOk ?? true} />
      <div className="mt-6">
        <Link href="/" className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-text">
          Go to dashboard
        </Link>
      </div>
    </section>
  );
}
