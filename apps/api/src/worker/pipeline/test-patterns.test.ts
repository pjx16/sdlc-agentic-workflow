import { describe, expect, it } from 'vitest';
import { checkTestFiles, isSafeRelativePath, isTestFile, pickExampleTestFile } from './test-patterns';

describe('isTestFile (F9)', () => {
  it('matches *.test.* and *.spec.* anywhere', () => {
    for (const f of ['a.test.ts', 'src/a.test.tsx', 'src/deep/a.spec.js', 'x.test.d.ts', 'a.b.test.mjs', 'src/Component.spec.ts']) expect(isTestFile(f), f).toBe(true);
  });
  it('matches anything under __tests__, test, tests or e2e', () => {
    for (const f of ['__tests__/a.ts', 'src/__tests__/helpers/util.ts', 'test/setup.ts', 'packages/x/tests/a.ts', 'e2e/login.ts', 'apps/web/e2e/specs/a.ts']) expect(isTestFile(f), f).toBe(true);
  });
  it('does not match production files or look-alikes', () => {
    for (const f of ['src/a.ts', 'src/testing.ts', 'src/contest.ts', 'src/latest/a.ts', 'attest/a.ts', 'src/spec/a.ts', 'a.test', 'src/mytest.ts', 'README.md']) expect(isTestFile(f), f).toBe(false);
  });
  it('treats backslash paths like slash paths', () => {
    expect(isTestFile('src\\a.test.ts')).toBe(true);
    expect(isTestFile('tests\\a.ts')).toBe(true);
  });
});

describe('isSafeRelativePath', () => {
  it('accepts repository-relative paths and rejects anything that could escape', () => {
    for (const f of ['a.test.ts', 'src/a.test.ts']) expect(isSafeRelativePath(f), f).toBe(true);
    for (const f of ['', '/etc/passwd', '../a.test.ts', 'src/../../a.test.ts', '~/a.test.ts', 'a\0.test.ts', 'src\\..\\a.test.ts']) expect(isSafeRelativePath(f), JSON.stringify(f)).toBe(false);
  });
});

describe('checkTestFiles (F9)', () => {
  const ok = { exists: () => true, changed: [] as string[] };

  it('accepts listed test files that exist', () => {
    expect(checkTestFiles({ listed: ['src/a.test.ts', 'tests/b.ts'], ...ok }).problems).toEqual([]);
  });

  it('rejects an empty list', () => {
    expect(checkTestFiles({ listed: [], ...ok }).problems).toEqual(['testFiles is empty']);
  });

  it('rejects a listed file that does not exist', () => {
    expect(checkTestFiles({ listed: ['src/a.test.ts'], exists: () => false, changed: [] }).problems).toEqual(['"src/a.test.ts" does not exist']);
  });

  it('rejects a listed file that is not a test file', () => {
    const { problems } = checkTestFiles({ listed: ['src/a.ts'], ...ok });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('does not match the test file patterns');
  });

  it('rejects paths that escape the repository, before looking at the disk', () => {
    const seen: string[] = [];
    const { problems } = checkTestFiles({ listed: ['../outside.test.ts', '/abs/a.test.ts'], exists: (f) => (seen.push(f), true), changed: [] });
    expect(problems).toHaveLength(2);
    expect(seen).toEqual([]);
  });

  it('requires every new or modified test file to be listed', () => {
    const { problems } = checkTestFiles({ listed: ['src/a.test.ts'], exists: () => true, changed: ['src/a.test.ts', 'src/b.spec.ts', 'tests/c.ts', 'src/impl.ts'] });
    expect(problems).toEqual(['these new or modified test files are not listed in testFiles: src/b.spec.ts, tests/c.ts']);
  });

  it('ignores changed files that are not tests, and normalizes ./ prefixes', () => {
    expect(checkTestFiles({ listed: ['./src/a.test.ts'], exists: () => true, changed: ['src/a.test.ts', 'src/stub.ts'] }).problems).toEqual([]);
  });

  it('reports several problems at once', () => {
    expect(checkTestFiles({ listed: ['src/a.ts', 'src/gone.test.ts'], exists: (f) => f !== 'src/gone.test.ts', changed: ['src/z.test.ts'] }).problems).toHaveLength(3);
  });
});

describe('pickExampleTestFile (BUILD_PLAN 6.4)', () => {
  const tracked = ['package.json', 'src/app.ts', 'src/util.test.ts', 'src/billing/export.ts', 'src/billing/export.test.ts', 'tests/e2e.ts'];
  it('prefers a test file in the directory of the first listed file', () => {
    expect(pickExampleTestFile(tracked, 'src/billing/other.ts')).toBe('src/billing/export.test.ts');
  });
  it('falls back to the first test file in the repository', () => {
    expect(pickExampleTestFile(tracked, 'lib/none/x.ts')).toBe('src/util.test.ts');
    expect(pickExampleTestFile(tracked, undefined)).toBe('src/util.test.ts');
  });
  it('returns undefined when the repository has no tests', () => {
    expect(pickExampleTestFile(['src/a.ts'], 'src/a.ts')).toBeUndefined();
  });
});
