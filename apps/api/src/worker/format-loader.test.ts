import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FORMATS } from '@sdlc/shared';
import { buildPrDescription } from './github/pr-description';
import { renderReviewComment, renderReviewSummary } from './review/review-comment';
import { FormatLoader } from './format-loader';

describe('FormatLoader', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'formats-'));
    mkdirSync(path.join(dir, 'formats'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('uses the default when there is no file, or the file is empty', async () => {
    const loader = new FormatLoader(dir);
    expect(await loader.load('review-comment')).toBe(FORMATS.find((f) => f.name === 'review-comment')?.default);
    writeFileSync(path.join(dir, 'formats', 'review-comment.md'), '  \n');
    expect(await loader.load('review-comment')).toBe(FORMATS.find((f) => f.name === 'review-comment')?.default);
    expect(await loader.load('not-a-format')).toBe('');
  });

  it('uses an edited file from the next call on, and fills it', async () => {
    const loader = new FormatLoader(dir);
    writeFileSync(path.join(dir, 'formats', 'jira-plan.md'), 'PLAN {{key}}:\n{{plan}}\n');
    expect(await loader.fill('jira-plan', { key: 'A-1', plan: 'do it' })).toBe('PLAN A-1:\ndo it');
    writeFileSync(path.join(dir, 'formats', 'jira-plan.md'), 'Changed {{key}}');
    expect(await loader.fill('jira-plan', { key: 'A-1', plan: 'x' })).toBe('Changed A-1');
  });
});

describe('the outputs follow an edited format', () => {
  const input = { ticket: { key: 'A-1', title: 'Export', body: 'CSV please', externalKey: null }, subtasks: [{ seq: 1, title: 'Write it', featCommit: 'abcdef123456', acceptanceCriteria: ['It exports'] }], testCommand: 'npx vitest run {files}' };

  it('the PR description', () => {
    expect(buildPrDescription(input, '# {{key}}: {{title}}\n\n{{fix}}\n\nTests: {{test_command}}')).toBe('# A-1: Export\n\n- Write it (`abcdef12`)\n\nTests: npx vitest run {files}\n');
  });
  it('the review comment keeps the findings table where the template puts it', () => {
    const out = renderReviewComment({ round: 2, summary: 'ok', findings: [{ severity: 'high', file: 'a.ts', line: 3, issue: 'Bad', rule: 'R', fix: 'Fix' }], previous: { fixed: 1, stillOpen: 0 } }, 'Round {{round}}\n\n{{findings}}\n\n{{previous}}\n\n— {{summary}}');
    expect(out).toContain('Round 2');
    expect(out).toContain('### High');
    expect(out).toContain('Previous findings: 1 fixed, 0 still open.');
    expect(out.endsWith('— ok\n')).toBe(true);
  });
  it('the review summary', () => {
    expect(renderReviewSummary({ rounds: 2, fixed: 3, open: { critical: 0, high: 0, medium: 1, low: 0 } }, 'Done in {{rounds}}. {{left}}')).toBe('Done in 2. Still open: 1 medium.\n');
    expect(renderReviewSummary({ rounds: 0, fixed: 0, open: { critical: 0, high: 0, medium: 0, low: 0 } }, 'x')).toContain('not run');
  });
});
