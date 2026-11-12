import { describe, expect, it } from 'vitest';
import { decideCi } from './ci-rules';

const c = (...buckets: string[]) => buckets.map((bucket, i) => ({ name: `c${i}`, bucket }) as never);
const MIN = 60_000;

describe('decideCi (F12)', () => {
  it('no checks counts as passing', () => expect(decideCi({ checks: [], waitedMs: 0, timeoutMs: 30 * MIN })).toBe('pass'));
  it('all passing or skipped passes', () => expect(decideCi({ checks: c('pass', 'skipping', 'pass'), waitedMs: 0, timeoutMs: MIN })).toBe('pass'));
  it('a failed or cancelled check fails, even with others pending', () => {
    expect(decideCi({ checks: c('pass', 'fail'), waitedMs: 0, timeoutMs: MIN })).toBe('fail');
    expect(decideCi({ checks: c('pending', 'cancel'), waitedMs: 0, timeoutMs: MIN })).toBe('fail');
  });
  it('pending checks wait until the timeout, then time out', () => {
    expect(decideCi({ checks: c('pass', 'pending'), waitedMs: 29 * MIN, timeoutMs: 30 * MIN })).toBe('pending');
    expect(decideCi({ checks: c('pass', 'pending'), waitedMs: 30 * MIN, timeoutMs: 30 * MIN })).toBe('timeout');
  });
  it('a failure wins over the timeout', () => expect(decideCi({ checks: c('fail', 'pending'), waitedMs: 99 * MIN, timeoutMs: MIN })).toBe('fail'));
});
