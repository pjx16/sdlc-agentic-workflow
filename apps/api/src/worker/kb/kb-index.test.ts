import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { featureKeyOf, lookup, readIndex, safeDocPath, upsertEntry } from './kb-index';

let ws: string;
const write = (rel: string, content: string) => {
  mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
  writeFileSync(path.join(ws, rel), content);
};
const index = (...features: object[]) => JSON.stringify({ version: 1, features });

beforeAll(() => {
  ws = mkdtempSync(path.join(tmpdir(), 'sdlc-kb-'));
});
afterAll(() => rmSync(ws, { recursive: true, force: true }));
beforeEach(() => rmSync(path.join(ws, 'docs'), { recursive: true, force: true }));

describe('featureKeyOf (F6)', () => {
  it('uses the pasted field, normalized', () => {
    expect(featureKeyOf({ featureKey: 'Billing-Export' })).toBe('billing-export');
  });
  it('uses a Jira label feature:<key> when there is no field', () => {
    expect(featureKeyOf({ featureKey: null, labels: ['backend', 'feature:bookings'] })).toBe('bookings');
    expect(featureKeyOf({ labels: ['Feature:Auth.Login '] })).toBe('auth.login');
  });
  it('prefers the field over a label, and ignores invalid or absent keys', () => {
    expect(featureKeyOf({ featureKey: 'a', labels: ['feature:b'] })).toBe('a');
    expect(featureKeyOf({ featureKey: 'Not Valid!', labels: [] })).toBeNull();
    expect(featureKeyOf({ labels: ['feature:', 'feature:../etc', 'bug'] })).toBeNull();
    expect(featureKeyOf({ labels: 'nope' })).toBeNull();
    expect(featureKeyOf({})).toBeNull();
  });
});

describe('readIndex', () => {
  it('treats a missing directory or index as empty', async () => {
    expect(await readIndex(ws, 'docs/kb')).toEqual({ index: { version: 1, features: [] } });
    mkdirSync(path.join(ws, 'docs/kb'), { recursive: true });
    expect((await readIndex(ws, 'docs/kb')).index.features).toEqual([]);
  });
  it('reads a valid index and fills defaults', async () => {
    write('docs/kb/features.json', index({ key: 'bookings', title: 'Bookings', doc: 'bookings.md', globs: ['src/bookings/**'], builtFromCommit: 'abc', updatedAt: '2026-01-01' }, { key: 'auth', doc: 'auth.md' }));
    const { index: idx, warning } = await readIndex(ws, 'docs/kb');
    expect(warning).toBeUndefined();
    expect(idx.features).toHaveLength(2);
    expect(idx.features[1]).toEqual({ key: 'auth', title: '', doc: 'auth.md', globs: [] });
  });
  it('treats a corrupt index as empty, with a warning', async () => {
    write('docs/kb/features.json', '{ not json');
    const a = await readIndex(ws, 'docs/kb');
    expect(a.index.features).toEqual([]);
    expect(a.warning).toContain('not a valid KB index');
    write('docs/kb/features.json', JSON.stringify({ version: 2, features: 'x' }));
    expect((await readIndex(ws, 'docs/kb')).warning).toBeDefined();
  });
});

describe('lookup (F6)', () => {
  it('matches a key to an entry whose doc exists, and returns the doc', async () => {
    write('docs/kb/features.json', index({ key: 'bookings', title: 'Bookings', doc: 'bookings.md' }));
    write('docs/kb/bookings.md', '# Bookings\nOverview');
    const { match } = await lookup(ws, 'docs/kb', 'bookings');
    expect(match?.entry.key).toBe('bookings');
    expect(match?.relPath).toBe('docs/kb/bookings.md');
    expect(match?.content).toBe('# Bookings\nOverview');
  });
  it('misses when there is no key, no entry, or the doc file is gone', async () => {
    write('docs/kb/features.json', index({ key: 'bookings', doc: 'bookings.md' }, { key: 'auth', doc: 'auth.md' }));
    write('docs/kb/auth.md', 'auth');
    expect((await lookup(ws, 'docs/kb', null)).match).toBeNull();
    expect((await lookup(ws, 'docs/kb', 'unknown')).match).toBeNull();
    expect((await lookup(ws, 'docs/kb', 'bookings')).match).toBeNull(); // indexed, but the doc does not exist
    expect((await lookup(ws, 'docs/kb', 'auth')).match).not.toBeNull();
  });
  it('misses (without crashing) on a missing index, and reports a corrupt one', async () => {
    expect(await lookup(ws, 'docs/kb', 'bookings')).toEqual({ match: null, warning: undefined });
    write('docs/kb/features.json', 'oops');
    expect((await lookup(ws, 'docs/kb', 'bookings')).warning).toContain('treating it as empty');
  });
  it('does not follow an index entry out of the KB directory', async () => {
    write('secret.md', 'top secret');
    write('docs/kb/features.json', index({ key: 'evil', doc: '../../secret.md' }, { key: 'abs', doc: '/etc/passwd.md' }, { key: 'txt', doc: 'notes.txt' }));
    for (const key of ['evil', 'abs', 'txt']) expect((await lookup(ws, 'docs/kb', key)).match, key).toBeNull();
  });
});

describe('safeDocPath', () => {
  it('accepts markdown files inside the KB dir only', () => {
    expect(safeDocPath(ws, 'docs/kb', 'a.md')).toBe(path.join(ws, 'docs/kb/a.md'));
    expect(safeDocPath(ws, 'docs/kb', 'sub/b.md')).toBe(path.join(ws, 'docs/kb/sub/b.md'));
    for (const bad of ['../a.md', 'x/../../a.md', '/a.md', 'a.txt', 'a.md\0', '']) expect(safeDocPath(ws, 'docs/kb', bad), JSON.stringify(bad)).toBeNull();
    expect(safeDocPath(ws, 'docs/kb', '..')).toBeNull();
  });
});

describe('upsertEntry', () => {
  it('creates the directory and index, then updates an entry in place, sorted by key', async () => {
    await upsertEntry(ws, 'docs/kb', { key: 'zeta', title: 'Zeta', doc: 'zeta.md', globs: ['z/**'] });
    await upsertEntry(ws, 'docs/kb', { key: 'alpha', title: 'Alpha', doc: 'alpha.md', globs: [] });
    await upsertEntry(ws, 'docs/kb', { key: 'zeta', title: 'Zeta v2', doc: 'zeta.md', globs: ['z/**'], updatedAt: '2026-02-02' });
    const written = JSON.parse(readFileSync(path.join(ws, 'docs/kb/features.json'), 'utf8'));
    expect(written.version).toBe(1);
    expect(written.features.map((f: { key: string; title: string }) => [f.key, f.title])).toEqual([['alpha', 'Alpha'], ['zeta', 'Zeta v2']]);
  });
});
