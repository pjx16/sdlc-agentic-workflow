import { describe, expect, it } from 'vitest';
import { assertSafeKey, branchName, slugify } from './branch';

describe('slugify (BUILD_PLAN 6.2)', () => {
  it('lower-cases and joins runs of non-alphanumerics with one dash', () => {
    expect(slugify('Add CSV Export!')).toBe('add-csv-export');
    expect(slugify('Fix   crash --- on  login')).toBe('fix-crash-on-login');
    expect(slugify('  leading and trailing  ')).toBe('leading-and-trailing');
    expect(slugify('a/b\\c.d_e')).toBe('a-b-c-d-e');
  });
  it('truncates to 40 characters without leaving a trailing dash', () => {
    const long = slugify('Implement the very long feature title that keeps going and going');
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith('-')).toBe(false);
    expect(slugify('x'.repeat(39) + ' yyy')).toBe('x'.repeat(39));
    expect(slugify('x'.repeat(100))).toHaveLength(40);
  });
  it('handles accents, symbols, emoji and empty input', () => {
    expect(slugify('Café Münster')).toBe('cafe-munster');
    expect(slugify('🔥 hot fix 🔥')).toBe('hot-fix');
    expect(slugify('!!!')).toBe('');
    expect(slugify('')).toBe('');
  });
  it('never contains characters git or the filesystem could mind', () => {
    expect(slugify('rm -rf /; $(whoami) `id` ../../etc')).toMatch(/^[a-z0-9-]*$/);
  });
});

describe('branchName', () => {
  it('uses feature for stories, bugfix for bugs and tech for tech tickets', () => {
    expect(branchName({ key: 'ABC-12', title: 'Add export', type: 'story' })).toBe('feature/ABC-12-add-export');
    expect(branchName({ key: 'ABC-13', title: 'Fix crash', type: 'bug' })).toBe('bugfix/ABC-13-fix-crash');
    expect(branchName({ key: 'BILL-1', title: 'Upgrade Node', type: 'tech' })).toBe('tech/BILL-1-upgrade-node');
  });
  it('omits the slug when the title has no usable characters', () => {
    expect(branchName({ key: 'ABC-1', title: '???', type: 'story' })).toBe('feature/ABC-1');
  });
  it('produces a valid git ref name', () => {
    const b = branchName({ key: 'ABC-1', title: 'A title: with ~^ weird *chars?', type: 'bug' });
    expect(b).toMatch(/^bugfix\/ABC-1-[a-z0-9-]+$/);
    expect(b).not.toMatch(/\.\.|--$|[\s~^:?*[\\]/);
  });
});

describe('assertSafeKey', () => {
  it('accepts Jira and local keys', () => {
    for (const k of ['ABC-1', 'SAM1-10', 'BILL-42', 'a.b_c-1']) expect(() => assertSafeKey(k), k).not.toThrow();
  });
  it('rejects anything that could escape a directory or confuse a command', () => {
    for (const k of ['', '../x', 'a/b', 'a b', '-rf', '.hidden', 'a..b', 'x;y', 'x\n']) expect(() => assertSafeKey(k), JSON.stringify(k)).toThrow('Unsafe ticket key');
  });
});
