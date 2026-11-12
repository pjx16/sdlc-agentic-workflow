import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CredentialDecryptError, decrypt, encrypt, loadKey } from './crypto';

const key = randomBytes(32);

describe('credential encryption', () => {
  it('round-trips and uses the v1 format', () => {
    const payload = encrypt(key, 'github_token', 'ghp_secret');
    expect(payload).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(payload).not.toContain('ghp_secret');
    expect(decrypt(key, 'github_token', payload)).toBe('ghp_secret');
  });
  it('fails with another key', () => {
    expect(() => decrypt(randomBytes(32), 'a', encrypt(key, 'a', 'x'))).toThrow(CredentialDecryptError);
  });
  it('fails under another name (AAD)', () => {
    expect(() => decrypt(key, 'b', encrypt(key, 'a', 'x'))).toThrow(CredentialDecryptError);
  });
  it('fails when one ciphertext byte is flipped, or the version is unknown', () => {
    const [v, iv, tag, ct] = encrypt(key, 'a', 'hello world').split('.') as [string, string, string, string];
    const bytes = Buffer.from(ct, 'base64url');
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    expect(() => decrypt(key, 'a', [v, iv, tag, bytes.toString('base64url')].join('.'))).toThrow(CredentialDecryptError);
    expect(() => decrypt(key, 'a', ['v2', iv, tag, ct].join('.'))).toThrow(CredentialDecryptError);
  });
  it('produces different payloads for the same value', () => {
    expect(encrypt(key, 'a', 'x')).not.toBe(encrypt(key, 'a', 'x'));
  });
  it('loads the key: null when unset, throws when the length is wrong', () => {
    expect(loadKey({})).toBeNull();
    expect(loadKey({ ENCRYPTION_KEY: key.toString('base64') })?.equals(key)).toBe(true);
    expect(() => loadKey({ ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') })).toThrow('32 bytes');
  });
});
