'use client';

import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartFrame } from './chart-frame';
import { ACCENT, AXIS_PROPS, GRID, tooltipStyle } from './theme';

interface Props {
  title: string;
  summary: string;
  emptyText: string;
  /** Header of the value column in the data table, and a formatter for the labels. */
  valueLabel: string;
  /** How values are written. A name, not a function: this component is a client component, rendered by server pages. */
  unit?: 'count' | 'duration';
  rows: { name: string; value: number }[];
  /** Treat all-zero rows as empty (tickets by state when there are no tickets). */
  emptyWhenZero?: boolean;
}

/** One horizontal bar per row with its value written at the end (direct labels, no legend). Used for states, findings and durations. */
const FORMATS = {
  count: (n: number) => String(n),
  duration: (s: number) => (s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`),
} as const;

export function BarListChart({ title, summary, emptyText, valueLabel, unit = 'count', rows, emptyWhenZero = true }: Props) {
  const format = FORMATS[unit];
  const empty = rows.length === 0 || (emptyWhenZero && rows.every((r) => r.value === 0));
  return (
    <ChartFrame title={title} summary={summary} empty={empty} emptyText={emptyText} table={{ columns: ['Name', valueLabel], rows: rows.map((r) => [r.name, format(r.value)]) }}>
      <ResponsiveContainer width="100%" height={Math.max(120, rows.length * 26 + 24)}>
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 48, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID} horizontal={false} />
          <XAxis type="number" hide />
          <YAxis type="category" dataKey="name" width={150} {...AXIS_PROPS} />
          <Tooltip contentStyle={tooltipStyle} formatter={(v) => (typeof v === 'number' ? format(v) : String(v))} cursor={{ fill: 'var(--border)', opacity: 0.4 }} />
          <Bar dataKey="value" fill={ACCENT} isAnimationActive={false} radius={[0, 3, 3, 0]}>
            <LabelList dataKey="value" position="right" formatter={(v: unknown) => (typeof v === 'number' ? format(v) : String(v))} fill="var(--text)" fontSize={11} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
