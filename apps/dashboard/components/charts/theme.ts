/** Chart styling (F17): one accent colour, light grid lines, no gradients. Colours are the dashboard's CSS variables, so both themes work. */
export const GRID = 'var(--border)';
export const AXIS = 'var(--muted)';
export const ACCENT = 'var(--accent)';
export const AXIS_PROPS = { stroke: AXIS, tick: { fill: AXIS, fontSize: 11 }, tickLine: false, axisLine: { stroke: GRID } } as const;

/** Tones of the accent for the n-th series of a stacked chart: strongest first. */
export const tone = (index: number, total: number): string => {
  const pct = total <= 1 ? 100 : Math.round(100 - (index * 70) / (total - 1));
  return `color-mix(in srgb, var(--accent) ${pct}%, var(--surface))`;
};

export const tooltipStyle = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12, color: 'var(--text)' } as const;
