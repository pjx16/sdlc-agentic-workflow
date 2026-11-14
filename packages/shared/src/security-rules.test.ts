import { describe, expect, it } from 'vitest';
import { securityTriggered } from './security-rules';

describe('securityTriggered', () => {
  it('is quiet for a plain change', () => {
    expect(securityTriggered(['src/bookings/list.ts'], '+const a = 1;\n').triggered).toBe(false);
  });
  it('triggers on a risky path', () => {
    const r = securityTriggered(['src/auth/session.service.ts'], '');
    expect(r.triggered).toBe(true);
    expect(r.reasons.length).toBeGreaterThan(0);
  });
  it('looks only at added lines', () => {
    expect(securityTriggered(['a.ts'], '-const secret = process.env.SECRET;\n').triggered).toBe(false);
  });
  it('takes the project’s own patterns', () => {
    expect(securityTriggered(['src/payments/charge.ts'], '', ['payments']).triggered).toBe(true);
  });
});
