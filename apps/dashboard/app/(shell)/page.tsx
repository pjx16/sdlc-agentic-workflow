import { AutoRefresh } from '@/components/auto-refresh';
import { LinesChart, MergedChart } from '@/components/charts/merged-charts';
import { BarListChart } from '@/components/charts/bar-list-chart';
import { TokensChart } from '@/components/charts/tokens-chart';
import { UsageChart } from '@/components/charts/usage-chart';
import { ActivityCard, NumberCards, QueueList, RangeSwitch, queueStatuses } from '@/components/overview-parts';
import { QualityPanel } from '@/components/quality-panel';
import { apiGet } from '@/lib/server-api';
import { humanizeStatus } from '@/lib/ticket-status';
import { NeedsYou } from '@/components/inbox';
import { RateCharts } from '@/components/charts/rate-charts';
import type { InboxCountsView, SupportTicketView, UsageRateView } from '@/lib/types';
import type { MetricsDurations, MetricsMerged, MetricsQuality, MetricsRange, MetricsSummary, MetricsTokens, MetricsUsage, StateCount, SystemView, TicketListItem } from '@/lib/types';

export const dynamic = 'force-dynamic';

const pickRange = (v?: string): MetricsRange => (v === '24h' || v === '30d' ? v : '7d');

export default async function OverviewPage({ searchParams }: { searchParams: Promise<{ range?: string; groupBy?: string }> }) {
  const params = await searchParams;
  const range = pickRange(params.range);
  const groupBy = params.groupBy === 'model' ? 'model' : 'stage';
  const q = `range=${range}`;
  const [system, summary, usage, tokens, merged, states, quality, durations, tickets, rate, inboxCounts, inboxTickets] = await Promise.all([
    apiGet<SystemView>('/system').catch(() => null),
    apiGet<MetricsSummary>(`/metrics/summary?${q}`),
    apiGet<MetricsUsage>(`/metrics/usage?${q}`),
    apiGet<MetricsTokens>(`/metrics/tokens?${q}&groupBy=${groupBy}`),
    apiGet<MetricsMerged>(`/metrics/merged?${q}`),
    apiGet<StateCount[]>('/metrics/tickets-by-state'),
    apiGet<MetricsQuality>(`/metrics/quality?${q}`),
    apiGet<MetricsDurations>(`/metrics/durations?${q}`),
    apiGet<TicketListItem[]>('/tickets').then((r) => r ?? []),
    apiGet<UsageRateView>('/usage/rate').catch(() => null),
    apiGet<InboxCountsView>('/support-tickets/counts').catch(() => null),
    apiGet<SupportTicketView[]>('/support-tickets').catch(() => null),
  ]);
  const queue = tickets.filter((t) => queueStatuses.includes(t.status)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));

  return (
    <section className="space-y-6">
      <AutoRefresh />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Overview</h1>
        <RangeSwitch range={range} hrefFor={(r) => `/?range=${r}&groupBy=${groupBy}`} />
      </div>
      {inboxCounts && inboxTickets && <NeedsYou tickets={inboxTickets} counts={inboxCounts} />}
      <ActivityCard system={system} now={Date.now()} />
      {summary && <NumberCards summary={summary} />}
      <div className="grid gap-4 lg:grid-cols-2">
        {usage && <UsageChart data={usage} />}
        {rate && <RateCharts data={rate} />}
        {tokens && <TokensChart data={tokens} />}
        {merged && <MergedChart data={merged} />}
        {merged && <LinesChart data={merged} />}
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
            unit="duration"
            rows={durations.stages.map((d) => ({ name: d.stage, value: d.medianSeconds }))}
          />
        )}
      </div>
      <QueueList tickets={queue} />
    </section>
  );
}
