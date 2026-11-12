'use client';

import Link from 'next/link';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { MetricsTokens } from '@/lib/types';
import { ChartFrame } from './chart-frame';
import { AXIS_PROPS, GRID, tone, tooltipStyle } from './theme';

const compact = (n: number) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);

/** Stacked bars per day, by stage or by model (F17). The switch is a link, so the choice survives a reload. */
export function TokensChart({ data }: { data: MetricsTokens }) {
  const rows = data.days.map((d) => ({ day: d.day.slice(5), ...d.groups }));
  const total = data.days.reduce((a, d) => a + d.total, 0);
  return (
    <ChartFrame
      title={`Tokens by ${data.groupBy}`}
      summary={`${total.toLocaleString('en-US')} tokens (input, output and cache-write) per day, split by ${data.groupBy}.`}
      empty={total === 0}
      emptyText="No tokens used in this range."
      table={{ columns: ['Day', 'Total', ...data.keys], rows: data.days.map((d) => [d.day, d.total, ...data.keys.map((k) => d.groups[k] ?? 0)]) }}
    >
      <div className="mb-2 flex items-center gap-3 text-xs">
        {(['stage', 'model'] as const).map((g) => (
          <Link key={g} href={`/?range=${data.range}&groupBy=${g}`} aria-current={data.groupBy === g ? 'true' : undefined} className={data.groupBy === g ? 'font-medium underline' : 'text-muted hover:underline'}>
            By {g}
          </Link>
        ))}
        <span className="ml-auto flex flex-wrap gap-x-3 text-muted">
          {data.keys.map((k, i) => (
            <span key={k} className="inline-flex items-center gap-1">
              <span aria-hidden className="inline-block h-2 w-2 rounded-sm" style={{ background: tone(i, data.keys.length) }} />
              {k}
            </span>
          ))}
        </span>
      </div>
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="day" {...AXIS_PROPS} />
          <YAxis width={44} tickFormatter={compact} {...AXIS_PROPS} />
          <Tooltip contentStyle={tooltipStyle} formatter={(v) => (typeof v === 'number' ? v.toLocaleString('en-US') : String(v))} cursor={{ fill: 'var(--border)', opacity: 0.4 }} />
          {data.keys.map((k, i) => (
            <Bar key={k} dataKey={k} stackId="tokens" fill={tone(i, data.keys.length)} isAnimationActive={false} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
