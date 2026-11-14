import { describe, expect, it } from 'vitest';
import { heartbeatFresh } from './worker-health';

describe('heartbeatFresh', () => {
  const now = Date.parse('2026-11-14T12:00:00Z');
  it('is fresh within 30 seconds', () => expect(heartbeatFresh(new Date(now - 29_000), now)).toBe(true));
  it('is stale at 30 seconds or more', () => expect(heartbeatFresh(new Date(now - 30_000), now)).toBe(false));
  it('is stale when the worker never wrote one', () => expect(heartbeatFresh(null, now)).toBe(false));
});
