import { describe, expect, it } from 'vitest';
import { compareVersions, pickSocket, socketCandidates } from './doctor';

describe('compareVersions', () => {
  it('orders versions, ignoring a leading v', () => {
    expect(compareVersions('2.20.0', '2.20.0')).toBe(0);
    expect(compareVersions('v2.29.1', '2.20.0')).toBeGreaterThan(0);
    expect(compareVersions('2.19.9', '2.20.0')).toBeLessThan(0);
    expect(compareVersions('3.0.0', '2.99.99')).toBeGreaterThan(0);
    expect(compareVersions('2.20', '2.20.0')).toBe(0);
  });
});

describe('pickSocket', () => {
  const home = '/home/me';
  it('uses the configured socket when it exists', () => {
    expect(pickSocket('/custom.sock', (p) => p === '/custom.sock', home)).toEqual({ path: '/custom.sock', found: true, suggested: false });
  });
  it('uses the default when nothing is configured', () => {
    expect(pickSocket(undefined, (p) => p === '/var/run/docker.sock', home)).toEqual({ path: '/var/run/docker.sock', found: true, suggested: false });
  });
  it('suggests the first existing Colima / OrbStack / Docker Desktop socket otherwise', () => {
    const [colima, orbstack] = socketCandidates(home) as [string, string, string];
    expect(pickSocket(undefined, (p) => p === orbstack, home)).toEqual({ path: orbstack, found: true, suggested: true });
    expect(pickSocket(undefined, (p) => p === colima || p === orbstack, home).path).toBe(colima);
  });
  it('reports not found when there is none', () => {
    expect(pickSocket(undefined, () => false, home)).toEqual({ path: '/var/run/docker.sock', found: false, suggested: false });
  });
});
