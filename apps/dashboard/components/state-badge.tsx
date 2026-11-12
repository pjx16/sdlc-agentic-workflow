import { humanizeStatus, statusTone, type BadgeTone } from '@/lib/ticket-status';

const DOT: Record<BadgeTone, string> = { grey: 'text-grey', accent: 'text-accent', amber: 'text-amber', green: 'text-green', red: 'text-red' };

export function StateBadge({ status }: { status: string }) {
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap text-sm">
      <span aria-hidden className={`dot ${DOT[statusTone(status)]}`} />
      {humanizeStatus(status)}
    </span>
  );
}
