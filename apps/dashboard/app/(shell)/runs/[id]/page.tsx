import { RunLogViewer } from '@/components/run-log-viewer';

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <section>
      <h1 className="mb-1 text-xl font-semibold">Run log</h1>
      <p className="mb-6 font-mono text-xs text-muted">{id}</p>
      <RunLogViewer runId={id} />
    </section>
  );
}
