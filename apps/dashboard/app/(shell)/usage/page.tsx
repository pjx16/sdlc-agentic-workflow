import { CalibrationForm } from '@/components/calibration-form';
import { SnapshotsTable, TokensTable } from '@/components/usage-tables';
import { apiGet } from '@/lib/server-api';
import type { SystemView, UsageSnapshotView, UsageSummaryView } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function UsagePage() {
  const [system, snapshots, summary] = await Promise.all([
    apiGet<SystemView>('/system'),
    apiGet<UsageSnapshotView[]>('/usage/snapshots').then((r) => r ?? []),
    apiGet<UsageSummaryView>('/usage/summary'),
  ]);
  const recent = [...snapshots].reverse().slice(0, 50);
  return (
    <section className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold">Usage</h1>
        <p className="mt-1 text-sm text-muted">
          The pipeline pauses at {system?.settings.usageThresholdPct ?? 50}% of the 5-hour window or {system?.settings.usageThresholdWeeklyPct ?? 80}% of the 7-day window.
        </p>
      </div>
      <CalibrationForm current={system?.settings.calibratedWindowTokens ?? null} suggested={summary?.suggestedCalibration ?? null} />
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
