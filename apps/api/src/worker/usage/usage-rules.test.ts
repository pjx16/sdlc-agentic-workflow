import { describe, expect, it } from 'vitest';
import { type UsageInput, evaluateUsage } from './usage-rules';

const NOW = new Date('2026-11-12T10:00:00Z');
const RESET = new Date('2026-11-12T13:00:00Z');
const base = (over: Partial<UsageInput> = {}): UsageInput => ({
  limit: { fiveHourPct: 10, sevenDayPct: 20, status: 'allowed', resetsAt: RESET }, windowTokens: 0, calibratedWindowTokens: null,
  thresholdPct: 50, thresholdWeeklyPct: 80, ignoredUntil: null, now: NOW, ...over,
});

describe('evaluateUsage (BUILD_PLAN 6.7)', () => {
  it('does not pause below both thresholds', () => {
    expect(evaluateUsage(base())).toMatchObject({ pause: false, reason: '' });
  });

  it('pauses at the 5-hour threshold (inclusive) and records the reset time', () => {
    const d = evaluateUsage(base({ limit: { fiveHourPct: 50, sevenDayPct: 10, status: 'allowed', resetsAt: RESET } }));
    expect(d).toMatchObject({ pause: true, resetsAt: RESET });
    expect(d.reason).toContain('5-hour usage is at 50%');
    expect(evaluateUsage(base({ limit: { fiveHourPct: 49.9, sevenDayPct: 10, status: 'allowed', resetsAt: RESET } })).pause).toBe(false);
  });

  it('pauses at the 7-day threshold (inclusive)', () => {
    const d = evaluateUsage(base({ limit: { fiveHourPct: 5, sevenDayPct: 80, status: 'allowed', resetsAt: RESET } }));
    expect(d.pause).toBe(true);
    expect(d.reason).toContain('7-day usage is at 80%');
    expect(evaluateUsage(base({ limit: { fiveHourPct: 5, sevenDayPct: 79, status: 'allowed', resetsAt: RESET } })).pause).toBe(false);
  });

  it('pauses on a warning status even with low percentages', () => {
    expect(evaluateUsage(base({ limit: { fiveHourPct: 1, sevenDayPct: 1, status: 'allowed_warning', resetsAt: RESET } })).pause).toBe(true);
  });

  it('pauses on rejected, and a rate-limit error counts as rejected', () => {
    expect(evaluateUsage(base({ limit: { fiveHourPct: 1, sevenDayPct: 1, status: 'rejected', resetsAt: RESET } })).pause).toBe(true);
    const d = evaluateUsage(base({ limit: null, rateLimitError: true }));
    expect(d).toMatchObject({ pause: true, snapshot: { status: 'rejected' } });
  });

  describe('ignoring usage', () => {
    const future = new Date(NOW.getTime() + 60_000);
    it('ignores thresholds and warnings while ignoredUntil is in the future', () => {
      expect(evaluateUsage(base({ ignoredUntil: future, limit: { fiveHourPct: 95, sevenDayPct: 95, status: 'allowed_warning', resetsAt: RESET } })).pause).toBe(false);
    });
    it('rejected still pauses', () => {
      expect(evaluateUsage(base({ ignoredUntil: future, limit: { fiveHourPct: 95, sevenDayPct: 95, status: 'rejected', resetsAt: RESET } })).pause).toBe(true);
      expect(evaluateUsage(base({ ignoredUntil: future, limit: null, rateLimitError: true })).pause).toBe(true);
    });
    it('is enforced again once the time has passed (also exactly at it)', () => {
      const over = { limit: { fiveHourPct: 95, sevenDayPct: 1, status: 'allowed', resetsAt: RESET } };
      expect(evaluateUsage(base({ ...over, ignoredUntil: new Date(NOW.getTime() - 1) })).pause).toBe(true);
      expect(evaluateUsage(base({ ...over, ignoredUntil: NOW })).pause).toBe(true);
    });
  });

  describe('without percentages in the event', () => {
    const noPct = { fiveHourPct: null, sevenDayPct: null, status: 'allowed', resetsAt: null };
    it('estimates the 5-hour share from windowTokens and the calibration', () => {
      const d = evaluateUsage(base({ limit: noPct, windowTokens: 600_000, calibratedWindowTokens: 1_000_000 }));
      expect(d).toMatchObject({ pause: true, snapshot: { fiveHourPct: 60, source: 'estimate', windowTokens: 600_000 } });
      expect(evaluateUsage(base({ limit: noPct, windowTokens: 400_000, calibratedWindowTokens: 1_000_000 })).pause).toBe(false);
    });
    it('also estimates when there was no rate-limit event at all', () => {
      expect(evaluateUsage(base({ limit: null, windowTokens: 900_000, calibratedWindowTokens: 1_000_000 })).pause).toBe(true);
    });
    it('does nothing without a calibration: null never triggers', () => {
      const d = evaluateUsage(base({ limit: noPct, windowTokens: 99_000_000, calibratedWindowTokens: null }));
      expect(d).toMatchObject({ pause: false, snapshot: { fiveHourPct: null, sevenDayPct: null } });
    });
    it('the event percentage wins over the estimate', () => {
      const d = evaluateUsage(base({ windowTokens: 900_000, calibratedWindowTokens: 1_000_000 }));
      expect(d).toMatchObject({ pause: false, snapshot: { fiveHourPct: 10, source: 'event' } });
    });
  });
});
