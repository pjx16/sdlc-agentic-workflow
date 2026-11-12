import { describe, expect, it } from 'vitest';
import { generateEncryptionKey, generatePostgresPassword, generateSetupCode } from './secrets';

describe('secrets', () => {
  it('generates a 48-character hex Postgres password', () => {
    expect(generatePostgresPassword()).toMatch(/^[0-9a-f]{48}$/);
  });
  it('generates an ENCRYPTION_KEY of 32 bytes in base64', () => {
    expect(Buffer.from(generateEncryptionKey(), 'base64')).toHaveLength(32);
  });
  it('generates a setup code like XXXX-XXXX-XXXX without look-alike characters', () => {
    expect(generateSetupCode()).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}(-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}){2}$/);
  });
  it('is unique per call', () => {
    expect(new Set(Array.from({ length: 50 }, generateEncryptionKey)).size).toBe(50);
    expect(new Set(Array.from({ length: 50 }, generateSetupCode)).size).toBe(50);
  });
});
