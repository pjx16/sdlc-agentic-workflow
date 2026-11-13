import { describe, expect, it } from 'vitest';
import { STAGE_NAMES } from './enums';
import { stageEnvelopeSchema, stageJsonSchema } from './stage-envelope';
import { zodFields } from './zod-utils';

const done = (data: unknown) => ({ status: 'done', summary: 'ok', data });
const validData: Record<string, unknown> = {
  kbBuild: { featureKey: 'auth', isNew: true, docPath: 'docs/kb/auth.md', globs: ['src/auth/**'] },
  plan: { planMarkdown: '# Plan', risks: [], openQuestions: [] },
  breakdown: { subtasks: [{ seq: 1, title: 'a', description: 'd', acceptanceCriteria: ['c'], files: ['f'], dependsOn: [] }] },
  tests: { testFiles: ['a.test.ts'], criteriaCovered: [{ criterion: 'c', test: 't' }] },
  implement: { filesChanged: ['a.ts'] },
  fix: { filesChanged: [] },
  review: { findings: [{ severity: 'high', file: 'a.ts', line: null, issue: 'i', rule: 'r', fix: 'f' }], previousFindings: [{ id: 'x', status: 'fixed' }] },
  kbUpdate: { featureKey: 'auth', docPath: 'docs/kb/auth.md', changed: true },
  assist: { reply: 'Use a comma.', draft: { kind: 'answer', text: 'Comma' } },
  repoProfile: { stack: 'nestjs', installCmd: 'npm ci', typecheckCmd: 'npx tsc --noEmit', testCmdTemplate: 'npx jest {files}', kbDir: 'docs/kb', testFilePattern: '**/*.spec.ts', exampleTestFile: null },
  onboardAdvise: { statusMap: { KB: 'In Progress' }, approvalStatuses: { plan: 'Plan Approved', breakdown: null }, issueTypeRouting: { Story: 'feature' }, intakeLabel: 'sdlc-agent', confluenceSpaceKey: null },
};

describe('stage envelopes (BUILD_PLAN 6.5)', () => {
  it.each(STAGE_NAMES)('%s accepts its documented data shape', (stage) => {
    expect(stageEnvelopeSchema(stage).safeParse(done(validData[stage])).success).toBe(true);
  });

  it.each(STAGE_NAMES)('%s rejects data of another shape', (stage) => {
    expect(stageEnvelopeSchema(stage).safeParse(done({ nonsense: true })).success).toBe(false);
  });

  it('requires data when done, with a path into data', () => {
    const f = zodFields(stageEnvelopeSchema('plan').safeParse({ status: 'done', summary: 'x' }).error!);
    expect(Object.keys(f).length).toBeGreaterThan(0);
    const g = zodFields(stageEnvelopeSchema('plan').safeParse(done({ planMarkdown: '', risks: [], openQuestions: [] })).error!);
    expect(g['data.planMarkdown']).toBe('must not be empty');
  });

  it('requires a question for needs_input but no data', () => {
    const schema = stageEnvelopeSchema('implement');
    expect(schema.safeParse({ status: 'needs_input', summary: 'q', question: 'Which db?' }).success).toBe(true);
    expect(zodFields(schema.safeParse({ status: 'needs_input', summary: 'q' }).error!).question).toBe('required when status is needs_input');
    expect(zodFields(schema.safeParse({ status: 'needs_input', summary: 'q', question: '  ' }).error!).question).toBeTruthy();
  });

  it('accepts blocked without data and limits the summary to 400 characters', () => {
    const schema = stageEnvelopeSchema('plan');
    expect(schema.safeParse({ status: 'blocked', summary: 'cannot' }).success).toBe(true);
    expect(zodFields(schema.safeParse({ status: 'blocked', summary: 'x'.repeat(401) }).error!).summary).toBe('must be at most 400 characters');
    expect(schema.safeParse({ status: 'maybe', summary: 'x' }).success).toBe(false);
  });

  it('validates breakdown subtasks and review severities', () => {
    expect(stageEnvelopeSchema('breakdown').safeParse(done({ subtasks: [] })).success).toBe(false);
    expect(stageEnvelopeSchema('breakdown').safeParse(done({ subtasks: [{ seq: 0, title: 'a', description: '', acceptanceCriteria: ['c'], files: [], dependsOn: [] }] })).success).toBe(false);
    expect(stageEnvelopeSchema('review').safeParse(done({ findings: [{ severity: 'urgent', file: 'a', line: 1, issue: 'i', rule: 'r', fix: 'f' }], previousFindings: [] })).success).toBe(false);
  });
});

describe('stageJsonSchema', () => {
  it.each(STAGE_NAMES)('%s produces a JSON Schema with status, summary and the data shape', (stage) => {
    const json = stageJsonSchema(stage) as { type: string; properties: Record<string, unknown>; required: string[] };
    expect(json.type).toBe('object');
    expect(Object.keys(json.properties).sort()).toEqual(['data', 'question', 'status', 'summary']);
    expect(json.required.sort()).toEqual(['status', 'summary']);
    expect(JSON.stringify(json)).not.toContain('$schema');
  });
  it('describes the plan data fields', () => {
    expect(JSON.stringify(stageJsonSchema('plan'))).toContain('planMarkdown');
    expect(JSON.stringify(stageJsonSchema('review'))).toContain('still_open');
  });
});

describe('assist data', () => {
  it('the draft is optional and may only be one of the three kinds', () => {
    const ok = (data: unknown) => stageEnvelopeSchema('assist').safeParse(done(data)).success;
    expect(ok({ reply: 'Fine.' })).toBe(true);
    expect(ok({ reply: 'Fine.', draft: null })).toBe(true);
    expect(ok({ reply: 'Fine.', draft: { kind: 'plan_edit', text: '# p' } })).toBe(true);
    expect(ok({ reply: 'Fine.', draft: { kind: 'delete_everything', text: 'x' } })).toBe(false);
    expect(ok({ reply: '', draft: null })).toBe(false);
  });
});
