import { AutoRefresh } from '@/components/auto-refresh';
import { OperationsPage } from '@/components/operations-view';
import { apiGet } from '@/lib/server-api';
import type { OperationsView } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function Operations() {
  const data = await apiGet<OperationsView>('/operations');
  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Operations</h1>
        <p className="mt-1 text-sm text-muted">Is the worker healthy, is anything stuck, and what is failing.</p>
      </div>
      <AutoRefresh />
      {data ? <OperationsPage data={data} /> : <p className="text-sm text-muted">Operations data is not available.</p>}
    </section>
  );
}
