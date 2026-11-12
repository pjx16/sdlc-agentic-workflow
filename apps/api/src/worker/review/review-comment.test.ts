import { describe, expect, it } from 'vitest';
import { renderReviewComment } from './review-comment';

const render = (issue: string) => renderReviewComment({ round: 1, summary: 's', findings: [{ severity: 'high', file: 'a.ts', line: 1, issue, rule: 'r', fix: 'f' }] });

describe('review summary table cells', () => {
  it('escapes pipes and line breaks', () => {
    const out = render('a | b\nc');
    expect(out).toContain('a \\| b c');
  });
  it('escapes backslashes first, so a backslash before a pipe cannot leave the pipe unescaped', () => {
    const out = render('x\\| y');
    // The input is x, a backslash, a pipe, y. Output: the backslash doubled, then an escaped pipe.
    expect(out).toContain('x\\\\\\| y');
    expect(out).not.toMatch(/x\\\\\| y/); // a doubled backslash directly followed by a bare pipe would end the cell
  });
});
