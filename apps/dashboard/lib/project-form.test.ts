import { DEFAULT_PROJECT_SETTINGS, STACK_PREFILLS } from '@sdlc/shared';
import { describe, expect, it } from 'vitest';
import { applyStackChange, initialValues, toPayload } from './project-form';
import type { ProjectView } from './types';

const project: ProjectView = {
  id: 'p1', name: 'Billing', repoUrl: 'https://github.com/a/b', baseBranch: 'dev', stack: 'nestjs', installCmd: 'npm ci',
  typecheckCmd: '', testCmdTemplate: 'npx jest {files}', kbDir: 'docs/kb', claudeMdMode: 'both', jiraMode: 'rest',
  jiraProjectKey: 'BILL', jiraJql: undefined, localKeyPrefix: 'BILL', enabled: true, mirrorStatus: 'ok', mirrorError: null,
  nextLocalNumber: 1, createdAt: '', updatedAt: '',
  settings: { ...DEFAULT_PROJECT_SETTINGS, jiraStatusMap: { ...DEFAULT_PROJECT_SETTINGS.jiraStatusMap, DONE: 'Closed' }, jiraApprovalStatuses: { plan: 'Plan OK' } },
};

describe('initialValues', () => {
  it('prefills a new project from the ts_node stack and the schema defaults', () => {
    const v = initialValues() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(v).toMatchObject({ stack: 'ts_node', baseBranch: 'dev', ...STACK_PREFILLS.ts_node, enabled: true });
    expect(v.settings.stages.plan).toEqual({ enabled: true, model: 'opus', maxTurns: '15' });
    expect(v.settings.limits.maxSubtasks).toBe('8');
    expect(v.settings.verify.redInvalidPatterns).toBe('Cannot find module\nSyntaxError\nerror TS[0-9]+');
  });

  it('loads an existing project, using empty text for unset optional values', () => {
    const v = initialValues(project) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(v.jiraJql).toBe('');
    expect(v.settings.jiraStatusMap.DONE).toBe('Closed');
    expect(v.settings.jiraStatusMap.NEW).toBe('');
    expect(v.settings.jiraApprovalStatuses).toEqual({ plan: 'Plan OK', breakdown: '' });
  });
});

describe('toPayload', () => {
  it('turns numeric text into numbers and blank numeric text into null', () => {
    const v = initialValues(project) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    v.settings.stages.plan.maxTurns = '9';
    v.settings.limits.maxSubtasks = '';
    const p = toPayload(v) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(p.settings.stages.plan.maxTurns).toBe(9);
    expect(p.settings.limits.maxReviewRounds).toBe(2);
    expect(p.settings.limits.maxSubtasks).toBeNull();
    expect(p.settings.pr.ciTimeoutMin).toBe(30);
  });

  it('splits patterns into lines and maps blank statuses to null or omits them', () => {
    const v = initialValues(project) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    v.settings.verify.redInvalidPatterns = 'A\n\n  B  \n';
    const p = toPayload(v) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(p.settings.verify.redInvalidPatterns).toEqual(['A', 'B']);
    expect(p.settings.jiraStatusMap.DONE).toBe('Closed');
    expect(p.settings.jiraStatusMap.NEW).toBeNull();
    expect(p.settings.jiraApprovalStatuses).toEqual({ plan: 'Plan OK' });
  });

  it('omits a blank local prefix so the API derives it', () => {
    const v = initialValues() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect('localKeyPrefix' in (toPayload(v) as object)).toBe(false);
  });

  it('does not mutate the form state', () => {
    const v = initialValues();
    const before = JSON.stringify(v);
    toPayload(v);
    expect(JSON.stringify(v)).toBe(before);
  });
});

describe('applyStackChange', () => {
  it('replaces untouched commands with the new stack prefill', () => {
    const next = applyStackChange(initialValues(), 'ts_node', 'nestjs');
    expect(next).toMatchObject({ stack: 'nestjs', testCmdTemplate: 'npx jest {files}' });
  });
  it('keeps commands the user customised', () => {
    const v = { ...initialValues(), testCmdTemplate: 'pnpm test {files}' };
    expect(applyStackChange(v, 'ts_node', 'nestjs').testCmdTemplate).toBe('pnpm test {files}');
  });
  it('fills commands that were emptied', () => {
    const v = { ...initialValues(), installCmd: '' };
    expect(applyStackChange(v, 'ts_node', 'nextjs').installCmd).toBe('npm ci');
  });
});
