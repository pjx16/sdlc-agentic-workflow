import { redirect } from 'next/navigation';
import { SetupAdminForm } from '@/components/setup-admin-form';
import { adminCreated } from '@/lib/setup-status';

export const dynamic = 'force-dynamic';

export default async function SetupPage() {
  if (await adminCreated()) redirect('/login');
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <SetupAdminForm />
    </main>
  );
}
