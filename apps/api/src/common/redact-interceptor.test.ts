import { describe, expect, it } from 'vitest';
import { createRedactor } from './redact';
import { redactDeep } from './redact-interceptor';

const redact = createRedactor(['super-secret-value-123']);

describe('redactDeep', () => {
  it('redacts configured secrets and token shapes in every string, at any depth', () => {
    const body = {
      events: [{ message: 'push failed for https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/a/b', n: 1 }],
      error: 'Authorization: Basic dXNlcjpzdXBlcnNlY3JldHBhc3N3b3Jk failed with super-secret-value-123',
      nested: { claude: 'token sk-ant-oat01-ABCDEFGHIJKLMNOPQRSTUV', jira: 'ATATT3xFfGF0abcdefghijklmnopqrstuvwxyz' },
    };
    const text = JSON.stringify(redactDeep(body, redact));
    for (const leaked of ['ghp_abcdef', 'dXNlcjpzdXBlcnNlY3JldHBhc3N3b3Jk', 'super-secret-value-123', 'sk-ant-oat01', 'ATATT3xFfGF0']) expect(text).not.toContain(leaked);
    expect(text).toContain('[REDACTED]');
  });
  it('keeps structure, numbers, booleans, null and dates', () => {
    const date = new Date('2026-11-12T10:00:00Z');
    const body = { a: [1, true, null, { b: 'plain' }], when: date };
    const out = redactDeep(body, redact);
    expect(out).toEqual(body);
    expect(out.when).toBe(date);
  });
  it('does not touch ordinary text', () => {
    expect(redactDeep({ s: 'Add a CSV export for bookings' }, redact)).toEqual({ s: 'Add a CSV export for bookings' });
  });
});
