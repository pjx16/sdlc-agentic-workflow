export function PagePlaceholder({ title, milestone }: { title: string; milestone: number }) {
  return (
    <section>
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="mt-2 text-sm text-muted">Nothing here yet. This page is built in milestone {milestone}.</p>
    </section>
  );
}
