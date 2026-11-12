'use client';

import type { MetricsQuality } from '@/lib/types';
import { BarListChart } from './charts/bar-list-chart';

const num = (v: number | null) => (v === null ? '—' : String(v));

/** First-pass rate, average fix and review rounds per ticket, and findings by severity (F17). */
export function QualityPanel({ data }: { data: MetricsQuality }) {
  const stats = [
    { label: 'First-pass rate', value: data.firstPassRate === null ? '—' : `${Math.round(data.firstPassRate * 100)}%` },
    { label: 'Fix rounds per ticket', value: num(data.avgFixRounds) },
    { label: 'Review rounds per ticket', value: num(data.avgReviewRounds) },
  ];
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-3 gap-3">
        {stats.map((s) => (
          <div key={s.label} className="panel p-3">
            <dt className="text-xs text-muted">{s.label}</dt>
            <dd className="mt-1 text-xl font-semibold">{s.value}</dd>
          </div>
        ))}
      </dl>
      <BarListChart
        title="Findings by severity"
        summary="Review findings reported in range."
        emptyText="No review findings in this range."
        valueLabel="Findings"
        rows={data.findingsBySeverity.map((f) => ({ name: f.severity, value: f.count }))}
      />
    </div>
  );
}
