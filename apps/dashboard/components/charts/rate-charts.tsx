'use client';

import { useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { RateSeriesView, UsageRateView } from '@/lib/types';
import { ChartFrame } from './chart-frame';
import { ACCENT, AXIS_PROPS, tooltipStyle } from './theme';

const label = (iso: string) => `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
const clock = (iso: string) => new Date(iso).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * One line per segment, so a reset never shows as a fall and a gap with no data is a break in the line, not a line drawn
 * across it (BUILD_PLAN v1 6.4). Rows are keyed by time; each segment only has values in its own rows.
 */
export function segmentRows(series: RateSeriesView): { rows: Record<string, number | string | null>[]; keys: string[] } {
  const rows = new Map<string, Record<string, number | string | null>>();
  const keys: string[] = [];
  series.segments.forEach((seg, i) => {
    const key = `s${i}`;
    keys.push(key);
    for (const p of seg.points) {
      if (p.rate === null) continue;
      const row = rows.get(p.at) ?? { at: p.at, label: label(p.at) };
      row[key] = p.rate;
      rows.set(p.at, row);
    }
  });
  return { rows: [...rows.values()].sort((a, b) => String(a.at).localeCompare(String(b.at))), keys };
}

interface Props {
  title: string;
  series: RateSeriesView;
  /** Extra controls in the title row (the window toggle). */
  action?: React.ReactNode;
  /** The small version for the overview page. */
  compact?: boolean;
}

export function RateChart({ title, series, action, compact = false }: Props) {
  const { rows, keys } = segmentRows(series);
  const unit = series.unit === 'pts/hour' ? 'points per hour' : 'points per day';
  const projection = series.projection;
  const latest = series.latest;
  const summary = [
    `${title}: ${unit}.`,
    latest ? `Now at ${Math.round(latest.pct)}%${latest.rate !== null ? `, rising ${latest.rate} ${series.unit}` : ''}.` : '',
    projection ? (projection.reachesAt ? `${projection.note}: ${clock(projection.reachesAt)}.` : `${projection.note}.`) : '',
  ].filter(Boolean).join(' ');
  return (
    <ChartFrame
      title={title}
      summary={summary}
      action={action}
      empty={rows.length === 0}
      emptyText="Not enough snapshots yet to show a rate. Two snapshots close together are needed."
      table={{ columns: ['When', `Rate (${series.unit})`, 'Percent'], rows: series.segments.flatMap((s) => s.points.filter((p) => p.rate !== null).map((p) => [label(p.at), p.rate, Math.round(p.pct * 10) / 10])) }}
    >
      <ResponsiveContainer width="100%" height={compact ? 120 : 240}>
        <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis dataKey="label" {...AXIS_PROPS} minTickGap={32} hide={compact} />
          <YAxis width={40} unit="" {...AXIS_PROPS} />
          <Tooltip contentStyle={tooltipStyle} formatter={(v) => (typeof v === 'number' ? `${v} ${series.unit}` : String(v))} />
          {keys.map((k) => (
            <Line key={k} type="monotone" dataKey={k} name={unit} stroke={ACCENT} strokeWidth={2} dot={{ r: 2 }} connectNulls={false} isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

type Window = 'fiveHour' | 'weekly';
const WINDOWS: { id: Window; short: string; title: string }[] = [
  { id: 'fiveHour', short: '5h', title: '5-hour window: how fast it is rising' },
  { id: 'weekly', short: 'W', title: 'Weekly window: how fast it is rising' },
];

/** One chart for both windows, with a small `5h | W` toggle: 5-hour percentage points per hour, or weekly points per day, with the projection to the threshold. */
export function RateCharts({ data, compact = false }: { data: UsageRateView; compact?: boolean }) {
  const [window, setWindow] = useState<Window>('fiveHour');
  const chosen = WINDOWS.find((w) => w.id === window) as (typeof WINDOWS)[number];
  const toggle = (
    <div role="group" aria-label="Window" className="ml-auto inline-flex overflow-hidden rounded border border-border text-xs">
      {WINDOWS.map((w) => (
        <button
          key={w.id}
          type="button"
          aria-pressed={window === w.id}
          aria-label={w.id === 'fiveHour' ? '5-hour window' : 'Weekly window'}
          onClick={() => setWindow(w.id)}
          className={`px-2 py-0.5 ${window === w.id ? 'bg-accent text-accent-text' : 'text-muted hover:text-text'}`}
        >
          {w.short}
        </button>
      ))}
    </div>
  );
  return <RateChart title={chosen.title} series={data[window]} action={toggle} compact={compact} />;
}
