import Link from 'next/link';
import { AutoRefresh } from '@/components/auto-refresh';
import { Inbox } from '@/components/inbox';
import { apiGet } from '@/lib/server-api';
import type { SupportTicketView } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  const active = tab === 'history' ? 'history' : 'open';
  const tickets = (await apiGet<SupportTicketView[]>(`/support-tickets?tab=${active}`)) ?? [];
  return (
    <section>
      <AutoRefresh />
      <h1 className="text-2xl font-semibold">Inbox</h1>
      <p className="mt-1 text-sm text-muted">Everything that needs you: approvals, questions, holds and problems. Acting on an item moves its ticket on.</p>
      <nav aria-label="Inbox tabs" className="mt-4 flex gap-1 border-b border-border">
        {([['open', 'Open'], ['history', 'History']] as const).map(([id, label]) => (
          <Link key={id} href={id === 'open' ? '/inbox' : '/inbox?tab=history'} aria-current={active === id ? 'page' : undefined} className={`-mb-px border-b-2 px-4 py-2 text-sm ${active === id ? 'border-accent text-text' : 'border-transparent text-muted hover:text-text'}`}>
            {label}
          </Link>
        ))}
      </nav>
      <Inbox tickets={tickets} tab={active} />
    </section>
  );
}
