import { describe, expect, it } from 'vitest';
import { AppConfig } from './config';

describe('AppConfig (S10, S11)', () => {
  it('starts without SESSION_SECRET', () => {
    expect(new AppConfig({ DASHBOARD_PASSWORD: 'a-long-enough-password' }).dashboardPassword).toBe('a-long-enough-password');
  });
  it('requires DASHBOARD_PASSWORD', () => {
    expect(() => new AppConfig({})).toThrow('Missing required environment variables: DASHBOARD_PASSWORD');
  });
  it('rejects a password shorter than 12 characters', () => {
    expect(() => new AppConfig({ DASHBOARD_PASSWORD: 'elevenchars' })).toThrow('DASHBOARD_PASSWORD must be at least 12 characters');
    expect(new AppConfig({ DASHBOARD_PASSWORD: 'twelve chars' }).dashboardPassword).toHaveLength(12);
  });
});
