import { describe, expect, it } from 'vitest';
import manifest from './manifest';

describe('web app manifest', () => {
  const m = manifest();
  it('has the fields browsers need to offer an install', () => {
    expect(m).toMatchObject({ id: '/', name: 'sdlc-agent', short_name: 'sdlc-agent', start_url: '/', scope: '/', display: 'standalone' });
    expect(m.description).toBeTruthy();
    expect(m.background_color).toBeTruthy();
    expect(m.launch_handler).toEqual({ client_mode: 'focus-existing' });
  });
  it('has 192 and 512 icons and one maskable icon', () => {
    const sizes = (m.icons ?? []).map((i) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    expect((m.icons ?? []).filter((i) => i.purpose === 'maskable')).toHaveLength(1);
  });
});
