import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export class CredentialDecryptError extends Error {
  constructor(message = 'Cannot decrypt the stored credential') {
    super(message);
    this.name = 'CredentialDecryptError';
  }
}

const VERSION = 'v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;

/** Decodes ENCRYPTION_KEY (32 random bytes, base64). Null when unset; throws when set but malformed. */
export function loadKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env.ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) throw new Error(`ENCRYPTION_KEY must be ${KEY_BYTES} bytes encoded as base64 (openssl rand -base64 32)`);
  return key;
}

const b64 = (b: Buffer) => b.toString('base64url');

/** AES-256-GCM. The credential name is the AAD, so a payload cannot be moved to another key. */
export function encrypt(key: Buffer, name: string, plain: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(name));
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [VERSION, b64(iv), b64(cipher.getAuthTag()), b64(ciphertext)].join('.');
}

export function decrypt(key: Buffer, name: string, payload: string): string {
  try {
    const [version, iv, tag, ciphertext, extra] = payload.split('.');
    if (version !== VERSION || !iv || !tag || ciphertext === undefined || extra !== undefined) throw new Error('bad payload');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(name));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new CredentialDecryptError();
  }
}
