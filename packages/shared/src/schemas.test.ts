import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GLOBAL_SETTINGS, DEFAULT_PROJECT_SETTINGS, GlobalSettingsSchema, ProjectInputSchema, ProjectSettingsSchema,
  STACK_PREFILLS, TICKET_STATUSES, commandWarnings, deepMerge, defaultLocalKeyPrefix, stageWarnings, zodFields,
} from './index';

const valid = { name: 'Billing API', repoUrl: 'https://github.com/acme/billing', stack: 'nestjs', testCmdTemplate: 'npx jest {files}' };

describe('ProjectSettings defaults (section 7)', () => {
  it('fills every default from an empty object', () => {
    const s = ProjectSettingsSchema.parse({});
    expect(s.stages.kbBuild).toEqual({ enabled: true, model: 'sonnet', maxTurns: 30 });
    expect(s.stages.plan).toEqual({ enabled: true, model: 'opus', maxTurns: 15 });
    expect(s.stages.breakdown).toEqual({ enabled: true, model: 'haiku', maxTurns: 10 });
    expect(s.stages.tests).toEqual({ enabled: true, model: 'sonnet', maxTurns: 25 });
    expect(s.stages.implement).toEqual({ enabled: true, model: 'haiku', maxTurns: 40 });
    expect(s.stages.fix).toEqual({ enabled: true, model: 'sonnet', maxTurns: 15 });
    expect(s.stages.review).toEqual({ enabled: true, model: 'sonnet', maxTurns: 10 });
    expect(s.stages.kbUpdate).toEqual({ enabled: true, model: 'sonnet', maxTurns: 15 });
    expect(s.stages.jiraIntake).toEqual({ enabled: true, model: 'haiku', maxTurns: 10 });
    expect(s.stages.jiraSync).toEqual({ enabled: true, model: 'haiku', maxTurns: 8 });
    expect(s.gates).toEqual({ plan: true, breakdown: true });
    expect(s.intake).toEqual({ paste: true, mcpPollIntervalSec: 900 });
    expect(s.jiraWriteBack).toEqual({ comments: true, transitions: true, createSubtasks: true });
    expect(s.jiraSubtaskTypeName).toBe('Sub-task');
    expect(s.pr).toEqual({ earlyDraft: true, ciFixRound: true, ciTimeoutMin: 30 });
    expect(s.limits).toEqual({ maxSubtasks: 8, maxTestFixRounds: 2, maxReviewRounds: 2, kbDocMaxLines: 300, reviewMaxDiffLines: 4000 });
    expect(s.verify.redInvalidPatterns).toEqual(['Cannot find module', 'SyntaxError', 'error TS[0-9]+']);
    expect(s.jiraApprovalStatuses).toEqual({});
  });

  it('maps every ticket status to null by default', () => {
    expect(Object.keys(DEFAULT_PROJECT_SETTINGS.jiraStatusMap).sort()).toEqual([...TICKET_STATUSES].sort());
    expect(Object.values(DEFAULT_PROJECT_SETTINGS.jiraStatusMap).every((v) => v === null)).toBe(true);
  });

  it('keeps unspecified siblings when one nested value is given', () => {
    const s = ProjectSettingsSchema.parse({ stages: { plan: { maxTurns: 20 } }, limits: { maxSubtasks: 3 } });
    expect(s.stages.plan).toEqual({ enabled: true, model: 'opus', maxTurns: 20 });
    expect(s.limits.maxSubtasks).toBe(3);
    expect(s.limits.maxReviewRounds).toBe(2);
  });

  it('reports field-level errors with dotted paths', () => {
    const r = ProjectSettingsSchema.safeParse({
      stages: { plan: { maxTurns: 0, model: 'gpt' }, implement: { enabled: false } },
      limits: { maxSubtasks: 'many' },
      pr: { ciTimeoutMin: 0 },
      verify: { redInvalidPatterns: ['('] },
    });
    expect(r.success).toBe(false);
    const fields = zodFields(r.error!);
    expect(fields['stages.plan.maxTurns']).toBe('must be at least 1');
    expect(fields['stages.plan.model']).toBeTruthy();
    expect(fields['stages.implement.enabled']).toBe('The implement stage cannot be disabled');
    expect(fields['limits.maxSubtasks']).toBe('must be a number');
    expect(fields['pr.ciTimeoutMin']).toBe('must be at least 1');
    expect(fields['verify.redInvalidPatterns.0']).toBe('must be a valid regular expression');
  });

  it('rejects an unknown status key in the Jira status map only by dropping it', () => {
    const s = ProjectSettingsSchema.parse({ jiraStatusMap: { DONE: 'Closed', BOGUS: 'x' } });
    expect(s.jiraStatusMap.DONE).toBe('Closed');
    expect('BOGUS' in s.jiraStatusMap).toBe(false);
  });
});

describe('stage dependency warnings (F2)', () => {
  it('has none by default', () => {
    expect(stageWarnings(DEFAULT_PROJECT_SETTINGS)).toEqual([]);
  });
  it('warns for each disabled dependent stage', () => {
    const s = ProjectSettingsSchema.parse({ stages: { plan: { enabled: false }, review: { enabled: false }, tests: { enabled: false } } });
    expect(stageWarnings(s).map((w) => w.field)).toEqual([
      'settings.stages.plan.enabled', 'settings.stages.tests.enabled', 'settings.stages.review.enabled',
    ]);
  });
});

describe('ProjectInput', () => {
  it('accepts a minimal project and applies defaults', () => {
    const p = ProjectInputSchema.parse(valid);
    expect(p).toMatchObject({ baseBranch: 'dev', installCmd: '', typecheckCmd: '', kbDir: 'docs/kb', claudeMdMode: 'both', jiraMode: 'off', enabled: true, localKeyPrefix: 'BILL' });
    expect(p.settings).toEqual(DEFAULT_PROJECT_SETTINGS);
  });

  it('requires {files} in the test command template', () => {
    const r = ProjectInputSchema.safeParse({ ...valid, testCmdTemplate: 'npx jest' });
    expect(zodFields(r.error!).testCmdTemplate).toBe('must contain {files}');
  });

  it('requires an HTTPS repository URL', () => {
    for (const repoUrl of ['http://github.com/a/b', 'git@github.com:a/b.git', 'github.com/a/b', '']) {
      expect(ProjectInputSchema.safeParse({ ...valid, repoUrl }).success, repoUrl).toBe(false);
    }
  });

  it('reports every missing required field', () => {
    const fields = zodFields(ProjectInputSchema.safeParse({}).error!);
    expect(Object.keys(fields).sort()).toEqual(['name', 'repoUrl', 'stack', 'testCmdTemplate']);
  });

  it('validates kbDir, Jira key and local prefix', () => {
    const f = zodFields(ProjectInputSchema.safeParse({ ...valid, kbDir: '../x', jiraProjectKey: 'abc', localKeyPrefix: 'a b' }).error!);
    expect(Object.keys(f).sort()).toEqual(['jiraProjectKey', 'kbDir', 'localKeyPrefix']);
  });

  it('treats blank optional text as absent and keeps an explicit prefix', () => {
    const p = ProjectInputSchema.parse({ ...valid, jiraJql: '  ', jiraProjectKey: '', localKeyPrefix: 'XY' });
    expect(p.jiraJql).toBeUndefined();
    expect(p.jiraProjectKey).toBeUndefined();
    expect(p.localKeyPrefix).toBe('XY');
  });

  it('derives the local key prefix from the first 4 letters', () => {
    expect(defaultLocalKeyPrefix('my-app 2')).toBe('MYAP');
    expect(defaultLocalKeyPrefix('12')).toBe('PROJ');
  });

  it('nests settings errors under settings.*', () => {
    const f = zodFields(ProjectInputSchema.safeParse({ ...valid, settings: { limits: { maxSubtasks: 0 } } }).error!);
    expect(f['settings.limits.maxSubtasks']).toBe('must be at least 1');
  });

  it('provides stack prefills and warns about empty commands', () => {
    expect(STACK_PREFILLS.nestjs.testCmdTemplate).toBe('npx jest {files}');
    expect(STACK_PREFILLS.ts_node.installCmd).toBe('npm ci');
    expect(commandWarnings(ProjectInputSchema.parse(valid)).map((w) => w.field)).toEqual(['installCmd', 'typecheckCmd']);
    expect(commandWarnings({ installCmd: 'npm ci', typecheckCmd: 'tsc' })).toEqual([]);
  });
});

describe('GlobalSettings', () => {
  it('has the section 7 defaults', () => {
    expect(DEFAULT_GLOBAL_SETTINGS).toMatchObject({
      usageThresholdPct: 50, usageThresholdWeeklyPct: 80, calibratedWindowTokens: null, pollIntervalSec: 120,
      stageTimeoutMin: 20, verifyTimeoutSec: 600, workspaceRetentionDays: 7, logRetentionDays: 30,
      modelAliases: { haiku: 'haiku', sonnet: 'sonnet', opus: 'opus' },
    });
    expect(DEFAULT_GLOBAL_SETTINGS.jiraMcp.readTools).toContain('searchJiraIssuesUsingJql');
    expect(DEFAULT_GLOBAL_SETTINGS.jiraMcp.writeTools).toContain('transitionJiraIssue');
  });
  it('validates ranges with field-level errors', () => {
    const f = zodFields(GlobalSettingsSchema.safeParse({ usageThresholdPct: 0, pollIntervalSec: 1, stageTimeoutMin: 'x', modelAliases: { haiku: '' }, jiraMcp: { readTools: [''] } }).error!);
    expect(Object.keys(f).sort()).toEqual(['jiraMcp.readTools.0', 'modelAliases.haiku', 'pollIntervalSec', 'stageTimeoutMin', 'usageThresholdPct']);
  });
});

describe('deepMerge', () => {
  it('merges objects recursively and replaces arrays and scalars', () => {
    expect(deepMerge({ a: { b: 1, c: 2 }, d: [1, 2], e: 1 }, { a: { b: 9 }, d: [3], e: undefined })).toEqual({ a: { b: 9, c: 2 }, d: [3], e: 1 });
  });
});
