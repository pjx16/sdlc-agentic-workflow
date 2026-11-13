import { describe, expect, it } from 'vitest';
import { OnboardAdviseData, RepoProfileData, buildIntakeJql, defaultRouting, kindForIssueType, missingAcceptance } from './onboarding';
import { ProjectSettingsSchema } from './project-settings';

describe('buildIntakeJql', () => {
  it('uses the label and only the issue types that route to a kind', () => {
    const jql = buildIntakeJql({ projectKey: 'SDA', label: 'sdlc-agent', routing: { Story: 'feature', Bug: 'bug', Epic: 'ignore', 'Sub-task': 'ignore', Task: 'chore' } });
    expect(jql).toBe('project = "SDA" AND labels = "sdlc-agent" AND issuetype in ("Bug", "Story", "Task") ORDER BY created ASC');
  });
  it('leaves the type filter out when every type is ignored, and strips quotes from names', () => {
    expect(buildIntakeJql({ projectKey: 'A', label: 'x', routing: { Epic: 'ignore' } })).toBe('project = "A" AND labels = "x" ORDER BY created ASC');
    expect(buildIntakeJql({ projectKey: 'A', label: 'l"x', routing: { 'My"Type': 'bug' } })).toBe('project = "A" AND labels = "lx" AND issuetype in ("MyType") ORDER BY created ASC');
  });
});

describe('routing', () => {
  it('defaults Sub-task and Epic types to ignore, and sub-task flags win over the name', () => {
    expect(defaultRouting([{ name: 'Story', subtask: false }, { name: 'Bug', subtask: false }, { name: 'Epic', subtask: false }, { name: 'Sub-task', subtask: true }, { name: 'Subtask of mine', subtask: true }, { name: 'Weird', subtask: false }, { name: 'Technical task', subtask: false }])).toEqual({
      Story: 'feature', Bug: 'bug', Epic: 'ignore', 'Sub-task': 'ignore', 'Subtask of mine': 'ignore', Weird: 'feature', 'Technical task': 'chore',
    });
  });
  it('finds the kind of an issue type by the project routing, ignoring case, else the fallback', () => {
    const routing = { Story: 'feature', Bug: 'bug', Epic: 'ignore' } as const;
    expect(kindForIssueType(routing, 'bug', 'feature')).toBe('bug');
    expect(kindForIssueType(routing, 'Epic', 'feature')).toBe('ignore');
    expect(kindForIssueType(routing, 'Mystery', 'chore')).toBe('chore');
    expect(kindForIssueType({}, 'Story', 'feature')).toBe('feature');
  });
});

describe('acceptance', () => {
  it('the status map and the label must be accepted explicitly', () => {
    expect(missingAcceptance({})).toEqual(['statusMap', 'label']);
    expect(missingAcceptance({ statusMap: true })).toEqual(['label']);
    expect(missingAcceptance({ statusMap: true, label: true })).toEqual([]);
  });
});

describe('agent output', () => {
  it('repo profile needs {files} in the test command and a safe kb folder', () => {
    const ok = { stack: 'nestjs', installCmd: 'npm ci', typecheckCmd: 'npx tsc --noEmit', testCmdTemplate: 'npx jest {files}', kbDir: 'docs/kb', testFilePattern: '**/*.spec.ts', exampleTestFile: null };
    expect(RepoProfileData.safeParse(ok).success).toBe(true);
    expect(RepoProfileData.safeParse({ ...ok, testCmdTemplate: 'npx jest' }).success).toBe(false);
    expect(RepoProfileData.safeParse({ ...ok, kbDir: '../x' }).success).toBe(false);
    expect(RepoProfileData.safeParse({ ...ok, stack: 'rails' }).success).toBe(false);
  });
  it('advice maps states to statuses, several states may share one, and types to kinds', () => {
    const ok = { statusMap: { KB: 'In Progress', PLANNING: 'In Progress', DONE: 'Done' }, approvalStatuses: { plan: 'Plan Approved', breakdown: null }, issueTypeRouting: { Story: 'feature', Epic: 'ignore' }, intakeLabel: 'sdlc-agent', confluenceSpaceKey: 'ENG' };
    expect(OnboardAdviseData.safeParse(ok).success).toBe(true);
    expect(OnboardAdviseData.safeParse({ ...ok, issueTypeRouting: { Story: 'wizard' } }).success).toBe(false);
    expect(OnboardAdviseData.safeParse({ ...ok, intakeLabel: 'two words' }).success).toBe(false);
  });
});

describe('project settings keep the new fields', () => {
  it('defaults to no routing and no Confluence', () => {
    const s = ProjectSettingsSchema.parse({});
    expect(s.jiraIssueTypeRouting).toEqual({});
    expect(s.confluence).toBeNull();
    expect(s.stages.repoProfile).toMatchObject({ model: 'sonnet' });
    expect(s.stages.onboardAdvise).toMatchObject({ model: 'haiku' });
    expect(ProjectSettingsSchema.parse({ confluence: { spaceKey: 'ENG' } }).confluence).toEqual({ spaceKey: 'ENG', parentPageId: null });
  });
});

import { GlobalSettingsSchema } from './global-settings';
describe('global stage defaults', () => {
  it('every stage has a model and a turn limit, taken from the built-in project defaults', () => {
    const d = GlobalSettingsSchema.parse({}).stageDefaults;
    expect(d.plan).toEqual({ model: 'opus', maxTurns: 15 });
    expect(d.repoProfile).toEqual({ model: 'sonnet', maxTurns: 25 });
    expect(Object.keys(d)).toContain('assist');
  });
  it('keeps what was set and refuses a bad value', () => {
    expect(GlobalSettingsSchema.parse({ stageDefaults: { plan: { model: 'haiku', maxTurns: 5 } } }).stageDefaults.plan).toEqual({ model: 'haiku', maxTurns: 5 });
    expect(GlobalSettingsSchema.safeParse({ stageDefaults: { plan: { model: 'gpt', maxTurns: 5 } } }).success).toBe(false);
    expect(GlobalSettingsSchema.safeParse({ stageDefaults: { plan: { model: 'haiku', maxTurns: 0 } } }).success).toBe(false);
  });
});
