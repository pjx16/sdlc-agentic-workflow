import { describe, expect, it } from 'vitest';
import { renderFindingsForFix, renderReviewComment } from './review-comment';
import { blocksReview, bySeverity } from './review-findings';
import { nextAfterReview } from './review-rules';

const f = (over: Record<string, unknown> = {}) => ({ severity: 'high', file: 'src/a.ts', line: 12, issue: 'Unvalidated input', rule: 'Security: input validation', fix: 'Validate it', ...over });

describe('nextAfterReview (F10 exit rule)', () => {
  it('fixes open critical or high findings while rounds remain', () => {
    expect(nextAfterReview({ roundsRun: 1, maxReviewRounds: 2, openBlocking: 1 })).toBe('fix');
    expect(nextAfterReview({ roundsRun: 1, maxReviewRounds: 3, openBlocking: 4 })).toBe('fix');
  });
  it('ends the loop when the rounds are used up, even with blocking findings left (not a failure)', () => {
    expect(nextAfterReview({ roundsRun: 2, maxReviewRounds: 2, openBlocking: 3 })).toBe('done');
    expect(nextAfterReview({ roundsRun: 5, maxReviewRounds: 2, openBlocking: 1 })).toBe('done');
  });
  it('ends the loop when there is nothing blocking', () => {
    expect(nextAfterReview({ roundsRun: 1, maxReviewRounds: 2, openBlocking: 0 })).toBe('done');
  });
  it('with maxReviewRounds 1 there is a single review and no fix round', () => {
    expect(nextAfterReview({ roundsRun: 1, maxReviewRounds: 1, openBlocking: 2 })).toBe('done');
  });
  it('only critical and high block', () => {
    expect(['critical', 'high', 'medium', 'low'].map(blocksReview)).toEqual([true, true, false, false]);
  });
});

describe('renderReviewComment (BUILD_PLAN 6.9)', () => {
  it('has the heading, the summary, and one table per severity that has findings, most severe first', () => {
    const md = renderReviewComment({ round: 1, summary: 'Two real problems.', findings: [f({ severity: 'low', issue: 'Name', fix: 'Rename' }), f(), f({ severity: 'critical', issue: 'SQL injection', file: 'src/db.ts', line: null })] });
    expect(md.startsWith('## Review — round 1\n\nTwo real problems.\n')).toBe(true);
    expect([...md.matchAll(/^### (.+)$/gm)].map((m) => m[1])).toEqual(['Critical', 'High', 'Low']);
    expect(md).toContain('| Issue | Location | Why it matters | Suggested fix |');
    expect(md).toContain('| SQL injection | `src/db.ts` | Security: input validation | Validate it |');
    expect(md).toContain('| Unvalidated input | `src/a.ts:12` | Security: input validation | Validate it |');
    expect(md).not.toContain('### Medium');
  });

  it('says "No findings." when the round found nothing', () => {
    expect(renderReviewComment({ round: 1, summary: 'Looks good.', findings: [] })).toBe('## Review — round 1\n\nLooks good.\n\nNo findings.\n');
  });

  it('adds the previous-findings line from round 2', () => {
    const md = renderReviewComment({ round: 2, summary: 's', findings: [f()], previous: { fixed: 3, stillOpen: 1 } });
    expect(md).toContain('Previous findings: 3 fixed, 1 still open.');
    expect(renderReviewComment({ round: 1, summary: 's', findings: [f()], previous: { fixed: 0, stillOpen: 0 } })).not.toContain('Previous findings');
  });

  it('keeps table cells intact: pipes and line breaks in a finding cannot break the table', () => {
    const md = renderReviewComment({ round: 1, summary: 's', findings: [f({ issue: 'a | b\nsecond line', fix: '' })] });
    const row = md.split('\n').find((l) => l.startsWith('| a'));
    expect(row).toBe('| a \\| b second line | `src/a.ts:12` | Security: input validation | — |');
    expect(row?.split('|').length).toBeGreaterThan(5);
  });

  it('handles an empty summary', () => {
    expect(renderReviewComment({ round: 1, summary: '  ', findings: [] })).toContain('_No summary._');
  });
});

describe('renderFindingsForFix', () => {
  it('lists each finding with its location, issue, rule and fix', () => {
    const text = renderFindingsForFix([f(), f({ severity: 'critical', file: 'src/b.ts', line: null, issue: 'Secret in code' })]);
    expect(text).toContain('1. [high] src/a.ts:12\n   Issue: Unvalidated input');
    expect(text).toContain('2. [critical] src/b.ts\n   Issue: Secret in code');
    expect(text).toContain('Suggested fix: Validate it');
  });
});

describe('bySeverity', () => {
  it('orders critical, high, medium, low', () => {
    expect(bySeverity([{ severity: 'low' }, { severity: 'critical' }, { severity: 'medium' }, { severity: 'high' }]).map((x) => x.severity)).toEqual(['critical', 'high', 'medium', 'low']);
  });
});
