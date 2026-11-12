import path from 'node:path';

/** Directories whose contents count as tests (F9). */
const TEST_DIRS = new Set(['__tests__', 'test', 'tests', 'e2e']);

/** Test files (F9): `**\/*.test.*`, `**\/*.spec.*`, or anything under `__tests__/`, `test/`, `tests/`, `e2e/`. */
export function isTestFile(file: string): boolean {
  const normalized = file.replace(/\\/g, '/');
  const segments = normalized.split('/');
  const base = segments[segments.length - 1] as string;
  if (/\.(test|spec)\.[^/]+$/.test(base)) return true;
  return segments.slice(0, -1).some((s) => TEST_DIRS.has(s));
}

/** A repository-relative path that stays inside the workspace. */
export function isSafeRelativePath(file: string): boolean {
  if (file === '' || file.includes('\0') || path.isAbsolute(file) || file.startsWith('~')) return false;
  return !file.split(/[\\/]/).some((s) => s === '..');
}

export interface TestFilesCheck {
  /** Reasons the `testFiles` output is rejected; empty when it is acceptable. */
  problems: string[];
}

/**
 * The orchestrator's checks on the `tests` stage output (F9): `testFiles` is not empty, each file exists and matches the
 * test patterns, and every new or modified file that matches the patterns is listed.
 */
export function checkTestFiles(args: { listed: readonly string[]; exists: (file: string) => boolean; changed: readonly string[] }): TestFilesCheck {
  const problems: string[] = [];
  if (args.listed.length === 0) problems.push('testFiles is empty');
  const listed = new Set(args.listed.map((f) => f.replace(/^\.\//, '')));
  for (const f of listed) {
    if (!isSafeRelativePath(f)) problems.push(`"${f}" is not a path inside the repository`);
    else if (!args.exists(f)) problems.push(`"${f}" does not exist`);
    else if (!isTestFile(f)) problems.push(`"${f}" does not match the test file patterns (*.test.*, *.spec.*, or under __tests__/, test/, tests/, e2e/)`);
  }
  const unlisted = args.changed.filter((f) => isTestFile(f) && !listed.has(f));
  if (unlisted.length > 0) problems.push(`these new or modified test files are not listed in testFiles: ${unlisted.join(', ')}`);
  return { problems };
}

/**
 * The example test file shown to the `tests` stage (BUILD_PLAN 6.4): an existing test file in the directory of the
 * subtask's first listed file, otherwise the first test file in the repository.
 */
export function pickExampleTestFile(trackedFiles: readonly string[], firstSubtaskFile: string | undefined): string | undefined {
  const tests = trackedFiles.filter(isTestFile);
  if (firstSubtaskFile) {
    const dir = path.posix.dirname(firstSubtaskFile.replace(/\\/g, '/'));
    const sameDir = tests.find((t) => path.posix.dirname(t) === dir);
    if (sameDir) return sameDir;
  }
  return tests[0];
}
