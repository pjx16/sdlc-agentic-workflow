import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from './clock';

export const MAX_FAILURES = 5;
export const WINDOW_MS = 15 * 60 * 1000;
export const LOCK_MS = 15 * 60 * 1000;

interface Entry {
  failures: number[];
  lockedUntil: number;
}

/** F1: after 5 failed logins within 15 minutes from one IP, that IP is locked out for 15 minutes. */
@Injectable()
export class LoginLimiter {
  private readonly entries = new Map<string, Entry>();

  constructor(@Inject(CLOCK) private readonly now: Clock) {}

  /** Seconds left on the lock, or 0 if the IP may try. */
  lockedForSeconds(ip: string): number {
    const entry = this.entries.get(ip);
    if (!entry) return 0;
    const remaining = entry.lockedUntil - this.now();
    return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
  }

  recordFailure(ip: string): void {
    const now = this.now();
    const entry = this.entries.get(ip) ?? { failures: [], lockedUntil: 0 };
    entry.failures = [...entry.failures.filter((t) => now - t < WINDOW_MS), now];
    if (entry.failures.length >= MAX_FAILURES) {
      entry.lockedUntil = now + LOCK_MS;
      entry.failures = [];
    }
    this.entries.set(ip, entry);
    this.prune(now);
  }

  recordSuccess(ip: string): void {
    this.entries.delete(ip);
  }

  private prune(now: number): void {
    for (const [ip, e] of this.entries) {
      if (e.lockedUntil <= now && e.failures.every((t) => now - t >= WINDOW_MS)) this.entries.delete(ip);
    }
  }
}
