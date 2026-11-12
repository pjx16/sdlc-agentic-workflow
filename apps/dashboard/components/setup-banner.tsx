import Link from 'next/link';
import { MISSING_LABELS } from '@/lib/setup-status';

/** Shown in the shell while the setup is incomplete: the pipeline is blocked until the missing credentials are added. */
export function SetupBanner({ missing, adminCreated = true }: { missing: string[]; adminCreated?: boolean }) {
  const labels = [...(adminCreated ? [] : ['the admin password']), ...missing.map((k) => MISSING_LABELS[k] ?? k)];
  if (labels.length === 0) return null;
  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-amber bg-surface px-8 py-3 text-sm">
      <p className="min-w-0 flex-1">
        <span className="font-medium">Setup incomplete:</span> the pipeline is blocked until you add {labels.join(', ')}.
      </p>
      <Link href="/setup/connections" className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-text">
        Finish setup →
      </Link>
    </div>
  );
}
