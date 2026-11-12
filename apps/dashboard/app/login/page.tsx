import { redirect } from 'next/navigation';
import { LoginForm } from '@/components/login-form';
import { hasValidSession } from '@/lib/session';
import { adminCreated } from '@/lib/setup-status';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  if (!(await adminCreated())) redirect('/setup');
  if (await hasValidSession()) redirect('/');
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <LoginForm />
    </main>
  );
}
