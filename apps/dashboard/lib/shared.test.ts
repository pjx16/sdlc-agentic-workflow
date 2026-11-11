import { SESSION_COOKIE } from '@sdlc/shared';
import { describe, expect, it } from 'vitest';

describe('shared contract with the API', () => {
  it('uses the same session cookie name as the API', () => {
    expect(SESSION_COOKIE).toBe('sdlc_session');
  });
});
