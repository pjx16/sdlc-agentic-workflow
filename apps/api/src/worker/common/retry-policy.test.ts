import { describe, expect, it } from 'vitest';
import { PolicyError, withRetry } from './retry-policy';

describe('withRetry', () => {
  it('returns the value of a call that works, without waiting', async () => {
    const waits: number[] = [];
    expect(await withRetry('GIT_ERROR', async () => 7, { sleep: async (ms) => void waits.push(ms) })).toBe(7);
    expect(waits).toEqual([]);
  });

  it('retries a failing call three times with 1, 4 and 10 minute waits, then throws the policy message', async () => {
    const waits: number[] = [];
    let calls = 0;
    const err = await withRetry('GITHUB_ERROR', async () => { calls++; throw new Error('502 Bad Gateway'); }, { sleep: async (ms) => void waits.push(ms) }).catch((e) => e);
    expect(calls).toBe(4);
    expect(waits).toEqual([60_000, 240_000, 600_000]);
    expect(err).toBeInstanceOf(PolicyError);
    expect(err).toMatchObject({ code: 'GITHUB_ERROR', message: 'GitHub failed: 502 Bad Gateway.' });
  });

  it('succeeds when a retry works', async () => {
    let calls = 0;
    expect(await withRetry('GIT_ERROR', async () => { if (++calls < 3) throw new Error('lock'); return 'ok'; }, { sleep: async () => undefined })).toBe('ok');
    expect(calls).toBe(3);
  });

  it('does not retry an error that retrying cannot fix', async () => {
    let calls = 0;
    await withRetry('GIT_ERROR', async () => { calls++; throw new Error('rejected'); }, { isFinal: () => true, sleep: async () => undefined }).catch(() => undefined);
    expect(calls).toBe(1);
  });
});

describe('scale', () => {
  it('shrinks the waits (0 means no wait at all)', async () => {
    const waits: number[] = [];
    await withRetry('GIT_ERROR', async () => { throw new Error('x'); }, { scale: 0, sleep: async (ms) => void waits.push(ms) }).catch(() => undefined);
    expect(waits).toEqual([0, 0, 0]);
  });
});
