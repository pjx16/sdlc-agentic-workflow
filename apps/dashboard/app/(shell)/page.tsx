import { BarListChart } from '@/components/charts/bar-list-chart';
import { TokensChart } from '@/components/charts/tokens-chart';
import { UsageChart } from '@/components/charts/usage-chart';
import { ActivityCard, NumberCards, QueueList, RangeSwitch, queueStatuses } from '@/components/overview-parts';
import { QualityPanel } from '@/components/quality-panel';
import { apiGet } from '@/lib/server-api';
import { humanizeStatus } from '@/lib/ticket-status';
import type { MetricsDurations, MetricsQuality, MetricsRange, MetricsSummary, MetricsTokens, MetricsUsage, StateCount, SystemView, TicketListItem } from '@/lib/types';

export const dynamic = 'force-dynamic';

const pickRange = (v?: string): MetricsRange => (v === '24h' || v === '30d' ? v : '7d');

export default async function OverviewPage({ searchParams }: { searchParams: Promise<{ range?: string; groupBy?: string }> }) {
  const params = await searchParams;
  const range = pickRange(params.range);
  const groupBy = params.groupBy === 'model' ? 'model' : 'stage';
  const q = `range=${range}`;
  const [system, summary, usage, tokens, states, quality, durations, tickets] = await Promise.all([
    apiGet<SystemView>('/system').catch(() => null),
    apiGet<MetricsSummary>(`/metrics/summary?${q}`),
    apiGet<MetricsUsage>(`/metrics/usage?${q}`),
    apiGet<MetricsTokens>(`/metrics/tokens?${q}&groupBy=${groupBy}`),
    apiGet<StateCount[]>('/metrics/tickets-by-state'),
    apiGet<MetricsQuality>(`/metrics/quality?${q}`),
    apiGet<MetricsDurations>(`/metrics/durations?${q}`),
    apiGet<TicketListItem[]>('/tickets').then((r) => r ?? []),
  ]);
  const queue = tickets.filter((t) => queueStatuses.includes(t.status)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Overview</h1>
        <RangeSwitch range={range} hrefFor={(r) => `/?range=${r}&groupBy=${groupBy}`} />
      </div>
      <ActivityCard system={system} now={Date.now()} />
      {summary && <NumberCards summary={summary} />}
      <div className="grid gap-4 lg:grid-cols-2">
        {usage && <UsageChart data={usage} />}
        {tokens && <TokensChart data={tokens} hrefFor={(g) => `/?range=${range}&groupBy=${g}`} />}
        {states && (
          <BarListChart
            title="Tickets by state"
            summary="How many tickets are in each internal state right now."
            emptyText="No tickets yet."
            valueLabel="Tickets"
            rows={states.filter((s) => s.count > 0 || ['NEW', 'IN_PROGRESS', 'IN_HUMAN_REVIEW', 'DONE'].includes(s.status)).map((s) => ({ name: humanizeStatus(s.status), value: s.count }))}
          />
        )}
        {quality && <QualityPanel data={quality} />}
        {durations && (
          <BarListChart
            title="Stage duration"
            summary="Median time of a successful run, per stage."
            emptyText="No stage has finished in this range."
            valueLabel="Median"
            format={(s) => (s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`)}
            rows={durations.stages.map((d) => ({ name: d.stage, value: d.medianSeconds }))}
          />
        )}
      </div>
      <QueueList tickets={queue} />
    </section>
  );
}
