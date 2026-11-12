import { GuidelinesEditor } from '@/components/guidelines-editor';
import { apiGet } from '@/lib/server-api';
import type { GuidelineNode } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function GuidelinesPage() {
  const tree = (await apiGet<GuidelineNode[]>('/guidelines')) ?? [];
  return (
    <section>
      <h1 className="text-2xl font-semibold">Guidelines</h1>
      <p className="mb-6 mt-1 text-sm text-muted">The instructions every stage receives. Changes apply from the next stage run.</p>
      <GuidelinesEditor tree={tree} />
    </section>
  );
}
