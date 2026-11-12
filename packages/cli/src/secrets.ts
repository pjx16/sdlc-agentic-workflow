import { randomBytes, randomInt } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const generatePostgresPassword = (): string => randomBytes(24).toString('hex');
export const generateEncryptionKey = (): string => randomBytes(32).toString('base64');

/** Same alphabet and format as the API's setup code: XXXX-XXXX-XXXX. */
export function generateSetupCode(): string {
  const chars = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}
