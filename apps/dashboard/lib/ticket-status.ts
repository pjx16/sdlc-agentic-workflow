export type BadgeTone = 'grey' | 'accent' | 'amber' | 'green' | 'red';

/** "AWAITING_PLAN_APPROVAL" -> "Awaiting plan approval". */
export function humanizeStatus(status: string): string {
  const text = status.toLowerCase().replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const WORKING = new Set(['KB', 'PLANNING', 'BREAKDOWN', 'IN_PROGRESS', 'REVIEW', 'KB_UPDATE']);

/** Semantic colours (BUILD_PLAN 6.10): green done, amber waiting or held, red failed, grey not started. */
export function statusTone(status: string): BadgeTone {
  if (status === 'DONE') return 'green';
  if (status === 'FAILED') return 'red';
  if (status === 'ON_HOLD' || status.startsWith('AWAITING_') || status === 'IN_HUMAN_REVIEW') return 'amber';
  if (WORKING.has(status)) return 'accent';
  return 'grey';
}

/** "2026-11-11T16:30:00.000Z" -> "2026-11-11 16:30 UTC". Fixed format and zone, so server and browser always agree. */
export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

export function formatDuration(startIso: string | null, endIso: string | null): string {
  if (!startIso || !endIso) return '—';
  const seconds = Math.max(0, Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  return `${m}m ${seconds % 60}s`;
}
