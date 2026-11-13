import Link from 'next/link';
import { ERROR_POLICY, isErrorCode } from '@sdlc/shared';
import { formatDateTime } from '@/lib/ticket-status';
import type { OperationsView } from '@/lib/types';

const pct = (v: number) => `${Math.round(v * 100)}%`;
const mins = (m: number) => (m < 120 ? `${m} min` : `${Math.floor(m / 60)} h`);
const secs = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`);
const uptime = (s: number | null) => (s === null ? '—' : s < 3600 ? `${Math.floor(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`);

const STATE_TEXT: Record<OperationsView['worker']['state'], { text: string; tone: string }> = {
  idle: { text: 'Online, idle', tone: 'text-green' },
  busy: { text: 'Online, busy', tone: 'text-green' },
  stalled: { text: 'Stalled: online, but stuck in one phase', tone: 'text-amber' },
  offline: { text: 'Offline', tone: 'text-red' },
  unknown: { text: 'Has not reported yet', tone: 'text-amber' },
};

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel p-4">
      <h2 className="mb-3 text-sm font-medium">{title}</h2>
      {children}
    </section>
  );
}

function Failures({ data }: { data: OperationsView['failures']['last24h'] }) {
  if (data.byStage.length === 0) return <p className="text-sm text-muted">No stage ran in this period.</p>;
  return (
    <table className="w-full text-left text-sm">
      <thead className="text-muted">
        <tr>
          <th className="py-1 font-normal">Stage</th>
          <th className="py-1 font-normal">Runs</th>
          <th className="py-1 font-normal">Failed</th>
          <th className="py-1 font-normal">Rate</th>
          <th className="py-1 font-normal">Codes</th>
        </tr>
      </thead>
      <tbody>
        {data.byStage.map((s) => (
          <tr key={s.stage} className="border-t border-border">
            <td className="py-1">{s.stage}</td>
            <td className="py-1">{s.runs}</td>
            <td className="py-1">{s.failed}</td>
            <td className={`py-1 ${s.rate >= 0.5 ? 'text-red' : s.rate > 0 ? 'text-amber' : ''}`}>{pct(s.rate)}</td>
            <td className="py-1 text-xs text-muted">{Object.entries(s.byCode).map(([c, n]) => `${c} ×${n}`).join(', ') || '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The operations page (BUILD_PLAN v1 6.4): worker, stuck tickets, failures, load, outside systems and recent errors. */
export function OperationsPage({ data }: { data: OperationsView }) {
  const w = data.worker;
  const state = STATE_TEXT[w.state];
  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <Block title="Worker">
          <p className={`text-sm font-medium ${state.tone}`}>{state.text}</p>
          {w.phase && w.phase !== 'idle' && <p className="mt-1 text-sm text-muted">{w.phaseDetail ? `${w.phase}: ${w.phaseDetail}` : w.phase}</p>}
          <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
            <div>
              <dt className="text-muted">Uptime</dt>
              <dd>{uptime(w.uptimeSec)}</dd>
            </div>
            <div>
              <dt className="text-muted">Starts, 24 h</dt>
              <dd className={w.restarts24h >= 3 ? 'text-red' : ''}>{w.restarts24h}</dd>
            </div>
            <div>
              <dt className="text-muted">Waiting for the worker</dt>
              <dd>{w.queueDepth}</dd>
            </div>
          </dl>
        </Block>
        <Block title="Outside systems, last 24 hours">
          <table className="w-full text-left text-sm">
            <thead className="text-muted">
              <tr>
                <th className="py-1 font-normal">System</th>
                <th className="py-1 font-normal">Calls or events</th>
                <th className="py-1 font-normal">Problems</th>
                <th className="py-1 font-normal">Rate</th>
              </tr>
            </thead>
            <tbody>
              {data.integrations.map((i) => (
                <tr key={i.source} className="border-t border-border">
                  <td className="py-1 capitalize">{i.source}</td>
                  <td className="py-1">{i.total}</td>
                  <td className="py-1">{i.errors}</td>
                  <td className={`py-1 ${i.rate >= 0.25 ? 'text-red' : ''}`}>{i.total === 0 ? '—' : pct(i.rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Block>
      </div>

      <Block title="Stuck tickets">
        {data.stuck.length === 0 ? (
          <p className="text-sm text-muted">Nothing is stuck. A ticket is stuck after 30 minutes ready with nothing running, or 24 hours waiting for a person.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {data.stuck.map((s) => (
              <li key={s.id}>
                <Link href={`/tickets/${s.id}`} className="font-mono text-accent hover:underline">
                  {s.key}
                </Link>{' '}
                <span className="text-muted">
                  {s.status}, {mins(s.minutes)}: {s.why}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Block>

      <div className="grid gap-6 lg:grid-cols-2">
        <Block title="Failure rate by stage, last 24 hours">
          <Failures data={data.failures.last24h} />
        </Block>
        <Block title="Failure rate by stage, last 7 days">
          <Failures data={data.failures.last7d} />
        </Block>
      </div>

      <Block title="Loops, retries and cost by stage (7 days)">
        {data.load.length === 0 ? (
          <p className="text-sm text-muted">No stage ran in the last 7 days.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-muted">
              <tr>
                <th className="py-1 font-normal">Stage</th>
                <th className="py-1 font-normal">Runs</th>
                <th className="py-1 font-normal">Retries</th>
                <th className="py-1 font-normal">Fix rounds</th>
                <th className="py-1 font-normal">Avg time</th>
                <th className="py-1 font-normal">Avg tokens</th>
                <th className="py-1 font-normal">Avg cost</th>
              </tr>
            </thead>
            <tbody>
              {data.load.map((l) => (
                <tr key={l.stage} className="border-t border-border">
                  <td className="py-1">{l.stage}</td>
                  <td className="py-1">{l.runs}</td>
                  <td className="py-1">{l.retries}</td>
                  <td className="py-1">{l.loops}</td>
                  <td className="py-1">{secs(l.avgDurationSec)}</td>
                  <td className="py-1">{l.avgTokens.toLocaleString('en-US')}</td>
                  <td className="py-1">${l.avgCostUsd.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Block>

      <Block title="Most recent errors">
        {data.recentErrors.length === 0 ? (
          <p className="text-sm text-muted">No errors recorded.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {data.recentErrors.map((e) => (
              <li key={e.id}>
                <p>
                  <span className="mr-2 rounded border border-border px-1.5 py-0.5 text-xs text-muted">{e.source}</span>
                  {e.message}
                </p>
                <p className="text-xs text-muted">
                  {formatDateTime(e.at)}
                  {e.ticketKey && (
                    <>
                      {' · '}
                      <Link href={`/tickets/${e.ticketId}?tab=timeline`} className="text-accent hover:underline">
                        {e.ticketKey}
                      </Link>
                    </>
                  )}
                  {isErrorCode(e.errorCode) && ` · ${ERROR_POLICY[e.errorCode].action}`}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Block>
    </div>
  );
}
