import { describe, expect, it } from 'vitest';
import { REDACTED, createRedactor } from './redact';

const claude = 'sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const jira = 'ATATT3xFfGF0AbCdEfGhIjKlMnOpQrStUvWxYz0123456789=ABCD1234';

describe('createRedactor', () => {
  it('replaces configured secrets, including inside JSON text', () => {
    const redact = createRedactor(['my-super-secret-value', 'with"quote-secret-1']);
    expect(redact('token=my-super-secret-value end')).toBe(`token=${REDACTED} end`);
    expect(redact(JSON.stringify({ t: 'with"quote-secret-1' }))).toBe(`{"t":"${REDACTED}"}`);
  });

  it('replaces token-shaped strings that were never configured', () => {
    const redact = createRedactor([]);
    expect(redact(`a ${claude} b`)).toBe(`a ${REDACTED} b`);
    expect(redact(`x ${jira}`)).toBe(`x ${REDACTED}`);
    expect(redact('gho_abcdefghijklmnopqrstuvwxyz0123')).toBe(REDACTED);
    expect(redact('github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz')).toBe(REDACTED);
  });

  it('keeps the scheme but hides Basic and Bearer credentials', () => {
    const redact = createRedactor([]);
    expect(redact('Authorization: Basic cGl5dXNoQGV4YW1wbGUuY29tOnNlY3JldHRva2Vu')).toBe(`Authorization: Basic ${REDACTED}`);
    expect(redact('{"Authorization":"Bearer abc.def.ghijklmnopqrstu"}')).toBe(`{"Authorization":"Bearer ${REDACTED}"}`);
  });

  it('ignores short or empty secrets so ordinary text survives', () => {
    const redact = createRedactor(['', undefined, 'abc', 'true']);
    expect(redact('abc true false the quick brown fox')).toBe('abc true false the quick brown fox');
  });

  it('prefers the longest match when secrets overlap', () => {
    const redact = createRedactor(['secret-value-1', 'secret-value-1-extended']);
    expect(redact('x secret-value-1-extended y')).toBe(`x ${REDACTED} y`);
  });

  it('leaves normal output untouched', () => {
    const line = '{"type":"assistant","message":{"content":[{"type":"text","text":"All good, 12 tests passed"}]}}';
    expect(createRedactor([claude])(line)).toBe(line);
  });
});
