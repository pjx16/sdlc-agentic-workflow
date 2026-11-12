import { describe, expect, it } from 'vitest';
import { buildPrDescription } from './pr-description';

const base = {
  ticket: { key: 'ABC-12', title: 'Export bookings to CSV', body: 'Customers want a CSV export of all bookings.', externalKey: 'ABC-12' as string | null },
  subtasks: [
    { seq: 1, title: 'Add the export service', featCommit: 'abcdef1234567890', acceptanceCriteria: ['Exports all bookings', 'Handles an empty list'] },
    { seq: 2, title: 'Add the endpoint', featCommit: null, acceptanceCriteria: ['GET /export returns a CSV'] },
  ],
  testCommand: 'npx vitest run {files}',
};

describe('buildPrDescription (BUILD_PLAN 6.9)', () => {
  it('follows the template: Summary, Problem, Fix implemented, Test plan, Review notes, in order', () => {
    const md = buildPrDescription({ ...base, jiraBaseUrl: 'https://acme.atlassian.net/' });
    expect([...md.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual(['Summary', 'Problem', 'Fix implemented', 'Test plan', 'Review notes']);
    expect(md).toContain('## Summary\nExport bookings to CSV — ABC-12 ([link](https://acme.atlassian.net/browse/ABC-12))');
  });

  it('lists one bullet per subtask with its commit, and says when a subtask is not done yet', () => {
    const md = buildPrDescription(base);
    expect(md).toContain('- Add the export service (`abcdef12`)');
    expect(md).toContain('- Add the endpoint (in progress)');
  });

  it('shows the acceptance criteria per subtask and the targeted test command', () => {
    const md = buildPrDescription(base);
    expect(md).toContain('**1. Add the export service**\n- Exports all bookings\n- Handles an empty list');
    expect(md).toContain('**2. Add the endpoint**\n- GET /export returns a CSV');
    expect(md).toContain('Targeted test command: `npx vitest run {files}`');
  });

  it('uses the local key without a link for pasted tickets or when there is no Jira URL', () => {
    expect(buildPrDescription({ ...base, ticket: { ...base.ticket, key: 'BILL-3', externalKey: null }, jiraBaseUrl: 'https://acme.atlassian.net' })).toContain('— BILL-3\n');
    expect(buildPrDescription(base)).toContain('— ABC-12\n');
  });

  it('keeps only the first 600 characters of the problem', () => {
    const md = buildPrDescription({ ...base, ticket: { ...base.ticket, body: 'x'.repeat(2000) } });
    const problem = /## Problem\n(.*)\n/.exec(md)?.[1] as string;
    expect(problem.length).toBeLessThanOrEqual(600);
    expect(problem.endsWith('…')).toBe(true);
    expect(buildPrDescription({ ...base, ticket: { ...base.ticket, body: 'short' } })).toContain('## Problem\nshort');
  });

  it('says "none" for review notes, or counts the remaining findings', () => {
    expect(buildPrDescription(base)).toContain('## Review notes\nnone');
    expect(buildPrDescription({ ...base, remainingFindings: { medium: 0, low: 0 } })).toContain('## Review notes\nnone');
    expect(buildPrDescription({ ...base, remainingFindings: { medium: 2, low: 3 } })).toContain('2 medium and 3 low finding(s) remain open.');
  });

  it('handles an empty body and no subtasks, and never contains attribution', () => {
    const md = buildPrDescription({ ...base, ticket: { ...base.ticket, body: '  ' }, subtasks: [] });
    expect(md).toContain('_No description._');
    expect(md).toContain('_No subtasks yet._');
    expect(md).not.toMatch(/co-authored-by|generated (with|by)|🤖|claude/i);
  });
});
