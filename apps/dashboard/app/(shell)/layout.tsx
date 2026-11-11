import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { Shell } from '@/components/shell';
import { hasValidSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function ShellLayout({ children }: { children: ReactNode }) {
  if (!(await hasValidSession())) redirect('/login');
  return <Shell>{children}</Shell>;
}
