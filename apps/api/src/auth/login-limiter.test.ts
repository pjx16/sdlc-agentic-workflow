import { describe, expect, it } from 'vitest';
import { LOCK_MS, LoginLimiter, MAX_FAILURES, WINDOW_MS } from './login-limiter';

function limiter() {
  const clock = { t: 1_000_000 };
  return { clock, l: new LoginLimiter(() => clock.t) };
}

describe('LoginLimiter (F1: 5 failures in 15 minutes lock the IP for 15 minutes)', () => {
  it('locks on the 5th failure, not before', () => {
    const { l } = limiter();
    for (let i = 1; i < MAX_FAILURES; i++) {
      l.recordFailure('a');
      expect(l.lockedForSeconds('a')).toBe(0);
    }
    l.recordFailure('a');
    expect(l.lockedForSeconds('a')).toBe(LOCK_MS / 1000);
  });
  it('the lock counts down and ends exactly after 15 minutes', () => {
    const { clock, l } = limiter();
    for (let i = 0; i < MAX_FAILURES; i++) l.recordFailure('a');
    clock.t += LOCK_MS - 1000;
    expect(l.lockedForSeconds('a')).toBe(1);
    clock.t += 1000;
    expect(l.lockedForSeconds('a')).toBe(0);
  });
  it('failures older than the window do not count', () => {
    const { clock, l } = limiter();
    for (let i = 0; i < MAX_FAILURES - 1; i++) l.recordFailure('a');
    clock.t += WINDOW_MS;
    l.recordFailure('a');
    expect(l.lockedForSeconds('a')).toBe(0);
  });
  it('a success clears the failures; IPs are independent; after a lock the count starts again', () => {
    const { clock, l } = limiter();
    for (let i = 0; i < MAX_FAILURES - 1; i++) l.recordFailure('a');
    l.recordSuccess('a');
    l.recordFailure('a');
    expect(l.lockedForSeconds('a')).toBe(0);
    for (let i = 0; i < MAX_FAILURES; i++) l.recordFailure('b');
    expect(l.lockedForSeconds('b')).toBeGreaterThan(0);
    expect(l.lockedForSeconds('a')).toBe(0);
    clock.t += LOCK_MS;
    for (let i = 0; i < MAX_FAILURES - 1; i++) l.recordFailure('b');
    expect(l.lockedForSeconds('b')).toBe(0);
  });
});
