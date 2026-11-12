'use client';

import { Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { MetricsMerged } from '@/lib/types';
import { ChartFrame } from './chart-frame';
import { ACCENT, AXIS_PROPS, GRID, tooltipStyle } from './theme';

const compact = (n: number) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
const full = (n: number) => n.toLocaleString('en-US');

/** Pull requests merged per day (F17). A ticket counts when the worker sees its PR merged. */
export function MergedChart({ data }: { data: MetricsMerged }) {
  const rows = data.days.map((d) => ({ day: d.day.slice(5), merged: d.merged }));
  return (
    <ChartFrame
      title="Pull requests merged"
      summary={`${data.totals.merged} PR${data.totals.merged === 1 ? '' : 's'} merged per day in this range.`}
      empty={data.totals.merged === 0}
      emptyText="No pull request was merged in this range."
      table={{ columns: ['Day', 'Merged'], rows: data.days.map((d) => [d.day, d.merged]) }}
    >
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="day" {...AXIS_PROPS} />
          <YAxis width={32} allowDecimals={false} {...AXIS_PROPS} />
          <Tooltip contentStyle={tooltipStyle} formatter={(v) => [String(v), 'Merged']} cursor={{ fill: 'var(--border)', opacity: 0.4 }} />
          <Bar dataKey="merged" fill={ACCENT} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/** Lines added (above the axis) and deleted (below it) per day, from the size of each merged PR. */
export function LinesChart({ data }: { data: MetricsMerged }) {
  const rows = data.days.map((d) => ({ day: d.day.slice(5), added: d.additions, deleted: -d.deletions }));
  const { additions, deletions, withoutLineData } = data.totals;
  const note = withoutLineData > 0 ? ` ${withoutLineData} merged PR${withoutLineData === 1 ? ' has' : 's have'} no line counts (merged before they were recorded).` : '';
  return (
    <ChartFrame
      title="Lines changed"
      summary={`+${full(additions)} added, -${full(deletions)} deleted across merged PRs in this range.${note}`}
      empty={additions + deletions === 0}
      emptyText="No merged pull request with line counts in this range."
      table={{ columns: ['Day', 'Added', 'Deleted'], rows: data.days.map((d) => [d.day, d.additions, d.deletions]) }}
    >
      <div className="mb-2 flex gap-4 text-xs text-muted">
        <span className="inline-flex items-center gap-1">
          <span aria-hidden className="inline-block h-2 w-2 rounded-sm" style={{ background: 'var(--status-green)' }} />
          added
        </span>
        <span className="inline-flex items-center gap-1">
          <span aria-hidden className="inline-block h-2 w-2 rounded-sm" style={{ background: 'var(--status-red)' }} />
          deleted
        </span>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={rows} stackOffset="sign" margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="day" {...AXIS_PROPS} />
          <YAxis width={44} tickFormatter={(v: number) => compact(Math.abs(v))} {...AXIS_PROPS} />
          <ReferenceLine y={0} stroke="var(--border-strong)" />
          <Tooltip contentStyle={tooltipStyle} formatter={(v, name) => [full(Math.abs(Number(v))), name === 'added' ? 'Added' : 'Deleted']} cursor={{ fill: 'var(--border)', opacity: 0.4 }} />
          <Bar dataKey="added" stackId="lines" fill="var(--status-green)" isAnimationActive={false} />
          <Bar dataKey="deleted" stackId="lines" fill="var(--status-red)" isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
