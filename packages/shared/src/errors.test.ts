import { describe, expect, it } from 'vitest';
import { ErrorBodySchema, ErrorCodes } from './errors';

describe('ErrorBodySchema', () => {
  it('accepts a body with and without fields', () => {
    expect(ErrorBodySchema.parse({ error: ErrorCodes.unauthorized, message: 'no' })).toBeTruthy();
    expect(ErrorBodySchema.parse({ error: 'validation_error', message: 'bad', fields: { a: 'b' } })).toBeTruthy();
  });
  it('rejects a body without a message', () => {
    expect(() => ErrorBodySchema.parse({ error: 'x' })).toThrow();
  });
});
