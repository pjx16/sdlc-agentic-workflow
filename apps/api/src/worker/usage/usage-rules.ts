import type { RateLimit } from '../agent-runner/result-parser';

export interface UsageInput {
  /** The latest rate_limit_event of the stage, if it had one. */
  limit: RateLimit | null;
  /** The stage ended with a rate-limit error: treated as `rejected` (BUILD_PLAN 6.7). */
  rateLimitError?: boolean;
  /** Input, output and cache-write tokens of all stage runs started in the last 5 hours. */
  windowTokens: number;
  calibratedWindowTokens: number | null;
  thresholdPct: number;
  thresholdWeeklyPct: number;
  ignoredUntil: Date | null;
  now: Date;
}

export interface UsageDecision {
  pause: boolean;
  /** Why the pipeline pauses (empty when it does not). */
  reason: string;
  resetsAt: Date | null;
  /** What the snapshot records. */
  snapshot: { fiveHourPct: number | null; sevenDayPct: number | null; status: string | null; resetsAt: Date | null; source: 'event' | 'estimate'; windowTokens: number };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * The usage gate (BUILD_PLAN 6.7, F14), after every AI stage:
 * 1. the percentages come from the event; with none, `windowTokens / calibratedWindowTokens x 100` (5 hours only), else null;
 * 2. the status is the event's, or `rejected` after a rate-limit error;
 * 3. (the caller stores the snapshot);
 * 4. `rejected` pauses, even while usage is ignored;
 * 5. otherwise nothing is enforced while `ignoredUntil` is in the future;
 * 6. otherwise pause on `allowed_warning`, or 5 hours >= threshold, or 7 days >= weekly threshold. A null never triggers.
 */
export function evaluateUsage(i: UsageInput): UsageDecision {
  const estimate = i.limit?.fiveHourPct == null && i.calibratedWindowTokens ? round1((i.windowTokens / i.calibratedWindowTokens) * 100) : null;
  const fiveHourPct = i.limit?.fiveHourPct ?? estimate;
  const sevenDayPct = i.limit?.sevenDayPct ?? null;
  const status = i.rateLimitError ? 'rejected' : (i.limit?.status ?? null);
  const resetsAt = i.limit?.resetsAt ?? null;
  const snapshot = { fiveHourPct, sevenDayPct, status, resetsAt, source: (i.limit?.fiveHourPct == null && estimate !== null ? 'estimate' : 'event') as 'event' | 'estimate', windowTokens: i.windowTokens };
  const pause = (reason: string): UsageDecision => ({ pause: true, reason, resetsAt, snapshot });
  const keep: UsageDecision = { pause: false, reason: '', resetsAt, snapshot };

  if (status === 'rejected') return pause('Claude rejected the request: the usage limit is reached');
  if (i.ignoredUntil && i.ignoredUntil.getTime() > i.now.getTime()) return keep;
  if (status === 'allowed_warning') return pause('Claude warns that the usage limit is close');
  if (fiveHourPct !== null && fiveHourPct >= i.thresholdPct) return pause(`5-hour usage is at ${round1(fiveHourPct)}% (threshold ${i.thresholdPct}%)`);
  if (sevenDayPct !== null && sevenDayPct >= i.thresholdWeeklyPct) return pause(`7-day usage is at ${round1(sevenDayPct)}% (threshold ${i.thresholdWeeklyPct}%)`);
  return keep;
}
