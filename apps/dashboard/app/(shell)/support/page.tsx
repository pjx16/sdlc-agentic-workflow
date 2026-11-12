import { SupportList } from '@/components/support-list';
import { apiGet } from '@/lib/server-api';
import type { SupportQueryView } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function SupportPage() {
  const queries = (await apiGet<SupportQueryView[]>('/support-queries')) ?? [];
  return (
    <section>
      <h1 className="text-2xl font-semibold">Support queries</h1>
      <p className="mt-1 text-sm text-muted">Questions the pipeline could not answer itself. Answering one resumes its ticket.</p>
      <SupportList queries={queries} />
    </section>
  );
}
