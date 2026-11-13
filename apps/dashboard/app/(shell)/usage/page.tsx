import { CalibrationForm } from '@/components/calibration-form';
import { RateCharts } from '@/components/charts/rate-charts';
import { ModelUsage } from '@/components/model-usage';
import { SnapshotsTable, TokensTable } from '@/components/usage-tables';
import { apiGet } from '@/lib/server-api';
import type { ModelUsageView, SystemView, UsageRateView, UsageSnapshotView, UsageSummaryView } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function UsagePage() {
  const [system, snapshots, summary, models, rate] = await Promise.all([
    apiGet<SystemView>('/system'),
    apiGet<UsageSnapshotView[]>('/usage/snapshots').then((r) => r ?? []),
    apiGet<UsageSummaryView>('/usage/summary'),
    apiGet<ModelUsageView>('/usage/models'),
    apiGet<UsageRateView>('/usage/rate'),
  ]);
  const recent = [...snapshots].reverse().slice(0, 50);
  return (
    <section className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Usage</h1>
        <p className="mt-1 text-sm text-muted">
          The pipeline pauses at {system?.settings.usageThresholdPct ?? 50}% of the 5-hour window or {system?.settings.usageThresholdWeeklyPct ?? 80}% of the 7-day window.
        </p>
      </div>
      <CalibrationForm current={system?.settings.calibratedWindowTokens ?? null} suggested={summary?.suggestedCalibration ?? null} />
      {rate && (
        <div>
          <h2 className="mb-2 text-sm font-medium">How fast usage is rising</h2>
          <RateCharts data={rate} />
        </div>
      )}
      <div>
        <h2 className="mb-2 text-sm font-medium">By model, last 7 days</h2>
        {models ? <ModelUsage data={models} /> : <p className="text-sm text-muted">Not available.</p>}
      </div>
      <div>
        <h2 className="mb-2 text-sm font-medium">Snapshots</h2>
        <SnapshotsTable snapshots={recent} />
      </div>
      <div>
        <h2 className="mb-2 text-sm font-medium">Tokens by stage and model, last 30 days</h2>
        <TokensTable tokens={summary?.tokens ?? []} />
      </div>
    </section>
  );
}
