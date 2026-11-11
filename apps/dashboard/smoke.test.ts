import { describe, expect, it } from 'vitest';
import { ErrorCodes } from '@sdlc/shared';

describe('dashboard skeleton', () => {
  it('can import the shared package', () => {
    expect(ErrorCodes.unauthorized).toBe('unauthorized');
  });
});
