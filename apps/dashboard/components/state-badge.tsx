import { humanizeStatus, statusTone, type BadgeTone } from '@/lib/ticket-status';

const DOT: Record<BadgeTone, string> = { grey: 'bg-grey', accent: 'bg-accent', amber: 'bg-amber', green: 'bg-green', red: 'bg-red' };

export function StateBadge({ status }: { status: string }) {
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap text-sm">
      <span aria-hidden className={`inline-block h-2 w-2 rounded-full ${DOT[statusTone(status)]}`} />
      {humanizeStatus(status)}
    </span>
  );
}
