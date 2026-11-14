import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../../..');

/** Reads a root file, or returns an empty string when it is missing so the assertion fails instead of the read. */
const read = (file: string): string => {
  const full = path.join(ROOT, file);
  return existsSync(full) ? readFileSync(full, 'utf8') : '';
};

// Assertions are on booleans so a failure never prints a whole file (its text could match runner-error patterns).
describe('TRACKER.md documentation', () => {
  it('exists at the repository root', () => {
    expect(existsSync(path.join(ROOT, 'TRACKER.md'))).toBe(true);
  });

  it('is linked from README.md with a relative markdown link', () => {
    expect(/\]\((\.\/)?TRACKER\.md(#[^)]*)?\)/.test(read('README.md'))).toBe(true);
  });

  it('links to docs/kb/tracker.md', () => {
    expect(/\]\((\.\/)?docs\/kb\/tracker\.md(#[^)]*)?\)/.test(read('TRACKER.md'))).toBe(true);
  });

  it('uses only the placeholder Jira URL and contains no token-like strings', () => {
    const text = read('TRACKER.md');
    expect(text.length > 0).toBe(true);
    const urls = text.match(/https?:\/\/[^\s)>"'`\]]+/g) ?? [];
    for (const url of urls) {
      expect(url.startsWith('https://your-site.atlassian.net'), url).toBe(true);
    }
    expect(/ATATT[A-Za-z0-9_\-=]{20,}/.test(text)).toBe(false);
    expect(/JIRA_API_TOKEN=\s*[^\s`]/.test(text)).toBe(false);
    expect(/[A-Za-z0-9+/=_-]{32,}/.test(text)).toBe(false);
  });
});
