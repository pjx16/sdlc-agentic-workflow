import { describe, expect, it } from 'vitest';
import { SERVICE_NAME } from './index';

describe('api skeleton', () => {
  it('exports its service name', () => {
    expect(SERVICE_NAME).toBe('sdlc-api');
  });
});
