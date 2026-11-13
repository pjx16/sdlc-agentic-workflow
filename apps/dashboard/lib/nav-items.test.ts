import { describe, expect, it } from 'vitest';
import { NAV_ITEMS, isActive } from './nav-items';

describe('navigation', () => {
  it('lists the rail entries in order', () => {
    expect(NAV_ITEMS.map((i) => i.label)).toEqual(['Overview', 'Tickets', 'Support', 'Projects', 'Guidelines', 'Usage', 'Operations', 'Settings']);
    expect(new Set(NAV_ITEMS.map((i) => i.href)).size).toBe(NAV_ITEMS.length);
  });

  it('marks only the current section active', () => {
    expect(isActive('/', '/')).toBe(true);
    expect(isActive('/tickets/ABC-1', '/')).toBe(false);
    expect(isActive('/tickets/ABC-1', '/tickets')).toBe(true);
    expect(isActive('/ticketsX', '/tickets')).toBe(false);
  });
});
