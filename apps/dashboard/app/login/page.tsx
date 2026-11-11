import { redirect } from 'next/navigation';
import { LoginForm } from '@/components/login-form';
import { hasValidSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  if (await hasValidSession()) redirect('/');
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <LoginForm />
    </main>
  );
}
