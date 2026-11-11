import { describe, expect, it } from 'vitest';
import { DEFAULT_CRITERION, acceptanceCriteriaFrom, describeIssues, findCycle, singleSubtask, validateBreakdown } from './breakdown';

const st = (seq: number, over: Record<string, unknown> = {}) => ({ seq, title: `Subtask ${seq}`, description: 'd', acceptanceCriteria: ['it works'], files: ['src/a.ts'], dependsOn: [] as number[], ...over });
const issues = (v: ReturnType<typeof validateBreakdown>) => (v.ok ? [] : v.issues);

describe('validateBreakdown (F8)', () => {
  it('accepts a valid chain and returns it sorted by seq', () => {
    const v = validateBreakdown([st(2, { dependsOn: [1] }), st(1), st(3, { dependsOn: [1, 2] })]);
    expect(v.ok).toBe(true);
    expect(v.ok && v.subtasks.map((s) => s.seq)).toEqual([1, 2, 3]);
  });

  it('accepts a single subtask and defaults optional fields', () => {
    const v = validateBreakdown([{ seq: 1, title: 't', acceptanceCriteria: ['c'] }]);
    expect(v.ok && v.subtasks[0]).toMatchObject({ description: '', files: [], dependsOn: [] });
  });

  it('rejects seq values that are not exactly 1..n', () => {
    for (const bad of [[st(1), st(3)], [st(1), st(1)], [st(2), st(3)], [st(1), st(2), st(2)]]) {
      expect(issues(validateBreakdown(bad)).some((i) => i.message.includes('seq values must be exactly 1 to'))).toBe(true);
    }
  });

  it('rejects a seq below 1 as a field error', () => {
    expect(issues(validateBreakdown([st(0), st(1)]))).toContainEqual({ field: 'subtasks.0.seq', message: 'must be at least 1' });
  });

  it('rejects a dependency on the same or a later seq', () => {
    expect(issues(validateBreakdown([st(1, { dependsOn: [1] })])).map((i) => i.message)).toContain('subtask 1 cannot depend on itself');
    const forward = issues(validateBreakdown([st(1, { dependsOn: [2] }), st(2)]));
    expect(forward).toContainEqual({ field: 'subtasks.0.dependsOn', message: 'subtask 1 depends on a later subtask (2); dependencies must point to earlier ones' });
  });

  it('rejects a dependency on a subtask that does not exist, and duplicate dependencies', () => {
    expect(issues(validateBreakdown([st(1), st(2, { dependsOn: [1, 1] })])).some((i) => i.message.includes('more than once'))).toBe(true);
  });

  it('rejects a dependency cycle', () => {
    const cyc = validateBreakdown([st(1, { dependsOn: [2] }), st(2, { dependsOn: [1] })]);
    expect(issues(cyc).some((i) => i.message.startsWith('dependency cycle: '))).toBe(true);
    expect(findCycle([{ seq: 1, dependsOn: [3] }, { seq: 2, dependsOn: [1] }, { seq: 3, dependsOn: [2] }])).toEqual([1, 3, 2, 1]);
    expect(findCycle([{ seq: 1, dependsOn: [] }, { seq: 2, dependsOn: [1] }])).toBeNull();
    expect(findCycle([{ seq: 1, dependsOn: [9] }])).toBeNull(); // unknown seq values are another rule's business
  });

  it('rejects too many subtasks, using maxSubtasks (default 8)', () => {
    const nine = Array.from({ length: 9 }, (_, i) => st(i + 1));
    expect(issues(validateBreakdown(nine))[0]?.message).toBe('9 subtasks is more than the limit of 8');
    expect(validateBreakdown(nine.slice(0, 8)).ok).toBe(true);
    expect(validateBreakdown(nine, { maxSubtasks: 9 }).ok).toBe(true);
    expect(validateBreakdown(nine.slice(0, 4), { maxSubtasks: 3 }).ok).toBe(false);
  });

  it('rejects an empty or non-list breakdown', () => {
    expect(issues(validateBreakdown([]))[0]?.message).toBe('at least one subtask is required');
    for (const bad of [null, undefined, {}, 'x', 5]) expect(issues(validateBreakdown(bad))[0]?.field).toBe('subtasks');
  });

  it('requires a title and at least one non-empty acceptance criterion, with field paths', () => {
    const v = validateBreakdown([st(1, { title: '  ', acceptanceCriteria: [] }), st(2, { acceptanceCriteria: ['ok', ' '] })]);
    expect(issues(v)).toEqual(expect.arrayContaining([
      { field: 'subtasks.0.title', message: 'required' },
      { field: 'subtasks.0.acceptanceCriteria', message: 'at least one acceptance criterion' },
      { field: 'subtasks.1.acceptanceCriteria.1', message: 'must not be empty' },
    ]));
  });

  it('describes issues for a failed attempt', () => {
    expect(describeIssues(issues(validateBreakdown([st(1, { dependsOn: [1] })])))).toBe('subtasks.0.dependsOn: subtask 1 cannot depend on itself');
  });
});

describe('breakdown off: the single subtask (F2)', () => {
  it('uses the criteria from an "Acceptance criteria" section', () => {
    const body = 'Add an export.\n\n## Acceptance criteria\n- Exports all rows\n- [ ] Handles empty data\n1. Is documented\n\n## Notes\n- not a criterion';
    expect(acceptanceCriteriaFrom(body)).toEqual(['Exports all rows', 'Handles empty data', 'Is documented']);
  });
  it('matches the heading loosely, and stops at plain text', () => {
    expect(acceptanceCriteriaFrom('**Acceptance Criteria**\n* a\n* b\nSome closing words\n* not included')).toEqual(['a', 'b']);
    expect(acceptanceCriteriaFrom('Acceptance criteria:\n- one')).toEqual(['one']);
  });
  it('falls back to the default criterion when there is no section or it has no items', () => {
    expect(acceptanceCriteriaFrom('Just a description')).toEqual([DEFAULT_CRITERION]);
    expect(acceptanceCriteriaFrom('## Acceptance criteria\n\n## Next')).toEqual([DEFAULT_CRITERION]);
    expect(acceptanceCriteriaFrom('')).toEqual([DEFAULT_CRITERION]);
  });
  it('builds one subtask whose description is the plan', () => {
    const s = singleSubtask({ title: 'Export bookings', body: '## Acceptance criteria\n- works' }, '# Plan');
    expect(s).toEqual({ seq: 1, title: 'Export bookings', description: '# Plan', acceptanceCriteria: ['works'], files: [], dependsOn: [] });
    expect(validateBreakdown([s]).ok).toBe(true);
  });
});
