import { describe, expect, it } from 'vitest';
import { AppConfig } from './config';

describe('AppConfig (S10, S11)', () => {
  it('starts without SESSION_SECRET', () => {
    expect(new AppConfig({ DASHBOARD_PASSWORD: 'a-long-enough-password' }).dashboardPassword).toBe('a-long-enough-password');
  });
  it('treats DASHBOARD_PASSWORD as optional (the setup wizard creates it)', () => {
    expect(new AppConfig({}).dashboardPassword).toBe('');
  });
  it('rejects a malformed ENCRYPTION_KEY but accepts none', () => {
    expect(new AppConfig({}).encryptionKey).toBeNull();
    expect(() => new AppConfig({ ENCRYPTION_KEY: 'abc' })).toThrow('32 bytes');
  });
  it('rejects a password shorter than 12 characters', () => {
    expect(() => new AppConfig({ DASHBOARD_PASSWORD: 'elevenchars' })).toThrow('DASHBOARD_PASSWORD must be at least 12 characters');
    expect(new AppConfig({ DASHBOARD_PASSWORD: 'twelve chars' }).dashboardPassword).toHaveLength(12);
  });
});
