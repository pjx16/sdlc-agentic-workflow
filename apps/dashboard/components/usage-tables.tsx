import { formatDateTime } from '@/lib/ticket-status';
import type { UsageSnapshotView, UsageSummaryView } from '@/lib/types';

const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 10) / 10}%`);

export function SnapshotsTable({ snapshots }: { snapshots: UsageSnapshotView[] }) {
  if (snapshots.length === 0) return <p className="text-sm text-muted">No usage has been recorded yet. A snapshot is stored after every AI stage.</p>;
  return (
    <table className="w-full text-left text-sm">
      <thead className="text-muted">
        <tr>
          <th className="py-2 font-normal">When</th>
          <th className="py-2 font-normal">5-hour</th>
          <th className="py-2 font-normal">7-day</th>
          <th className="py-2 font-normal">Status</th>
          <th className="py-2 font-normal">Resets</th>
          <th className="py-2 font-normal">Source</th>
        </tr>
      </thead>
      <tbody>
        {snapshots.map((s) => (
          <tr key={s.id} className="border-t border-border">
            <td className="py-2">{formatDateTime(s.at)}</td>
            <td className="py-2">{pct(s.fiveHourPct)}</td>
            <td className="py-2">{pct(s.sevenDayPct)}</td>
            <td className={`py-2 ${s.status === 'rejected' ? 'text-red' : s.status === 'allowed_warning' ? 'text-amber' : ''}`}>{s.status ?? '—'}</td>
            <td className="py-2 text-muted">{formatDateTime(s.resetsAt)}</td>
            <td className="py-2 text-muted">{s.source}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function TokensTable({ tokens }: { tokens: UsageSummaryView['tokens'] }) {
  if (tokens.length === 0) return <p className="text-sm text-muted">No stage has run in the last 30 days.</p>;
  return (
    <table className="w-full text-left text-sm">
      <thead className="text-muted">
        <tr>
          <th className="py-2 font-normal">Stage</th>
          <th className="py-2 font-normal">Model</th>
          <th className="py-2 text-right font-normal">Runs</th>
          <th className="py-2 text-right font-normal">Tokens</th>
        </tr>
      </thead>
      <tbody>
        {tokens.map((t) => (
          <tr key={`${t.stage}/${t.model}`} className="border-t border-border">
            <td className="py-2">{t.stage}</td>
            <td className="py-2 text-muted">{t.model}</td>
            <td className="py-2 text-right">{t.runs}</td>
            <td className="py-2 text-right">{t.tokens.toLocaleString('en-US')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
