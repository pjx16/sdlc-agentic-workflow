import type { OnboardingProposal } from '@sdlc/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SupportRaiser } from '../support/support-raiser';
import { type TestApp, createTestApp } from '../testing/test-app';
import { type TestDatabase, createTestDatabase } from '../testing/test-db';
import { ProjectsModule } from './projects.module';

const proposalFor = (over: Partial<OnboardingProposal> = {}): OnboardingProposal => ({
  facts: {
    github: { defaultBranch: 'main', languages: ['TypeScript'] },
    jira: {
      projectName: 'Billing',
      issueTypes: [{ name: 'Story', subtask: false }, { name: 'Bug', subtask: false }, { name: 'Epic', subtask: false }, { name: 'Sub-task', subtask: true }],
      statusesByType: [{ type: 'Story', statuses: [{ name: 'To Do', category: 'new' }, { name: 'In Progress', category: 'indeterminate' }, { name: 'In Review', category: 'indeterminate' }, { name: 'Done', category: 'done' }] }],
      labels: ['backend'],
    },
    confluence: { spaces: [{ key: 'ENG', name: 'Engineering' }] },
  },
  profile: { stack: 'nestjs', installCmd: 'npm ci', typecheckCmd: 'npx tsc --noEmit', testCmdTemplate: 'npx jest {files}', kbDir: 'docs/kb', testFilePattern: '**/*.spec.ts', exampleTestFile: null, baseBranch: 'main', installCheck: { command: 'npm ci', ok: true, tail: '' }, typecheckCheck: null },
  advice: { statusMap: { KB: 'In Progress', DONE: 'Done' }, approvalStatuses: { plan: 'In Review', breakdown: null }, issueTypeRouting: { Story: 'feature', Bug: 'bug', Epic: 'ignore', 'Sub-task': 'ignore' }, intakeLabel: 'sdlc-agent', confluenceSpaceKey: 'ENG' },
  accepted: {},
  createdAt: '2026-11-14T10:00:00Z',
  ...over,
});

describe('Project onboarding API (BUILD_PLAN v1 6.7)', () => {
  let db: TestDatabase;
  let t: TestApp;
  let raiser: SupportRaiser;
  let n = 0;

  const proposed = async (over: Partial<OnboardingProposal> = {}, projectOver: Record<string, unknown> = {}) =>
    t.prisma.project.create({ data: { name: `onb-${++n}`, repoUrl: 'https://github.com/acme/billing', stack: 'ts_node', testCmdTemplate: 'echo {files}', localKeyPrefix: `O${n}`, jiraMode: 'rest', jiraProjectKey: 'SDA', onboardingStatus: 'proposed', onboardingProposal: proposalFor(over) as never, ...projectOver } });
  const patch = (id: string, section: string, body: Record<string, unknown>) => t.agent.patch(`/projects/${id}/onboarding/sections/${section}`).send(body);
  const reload = (id: string) => t.prisma.project.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    db = await createTestDatabase();
    t = await createTestApp(db.url, [ProjectsModule]);
    raiser = t.app.get(SupportRaiser);
  }, 180_000);
  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });
  beforeEach(async () => {
    await t.prisma.supportTicket.deleteMany();
    await t.prisma.project.deleteMany({ where: { name: { startsWith: 'onb-' } } });
    t.jira.jira.tickets = [];
    t.jira.jira.calls = [];
    t.jira.jira.failWith = null;
    t.confluence.confluence.failWith = null;
    t.confluence.confluence.calls = [];
  });

  describe('starting', () => {
    it('requires a session', async () => {
      await t.anonymous.post('/projects/onboard').send({ repoUrl: 'https://github.com/a/b' }).expect(401);
    });

    it('creates a profiling project from a repo URL alone: no Jira, pasted tickets only', async () => {
      const res = await t.agent.post('/projects/onboard').send({ repoUrl: 'https://github.com/acme/billing' }).expect(201);
      expect(res.body).toMatchObject({ name: 'billing', jiraMode: 'off', onboardingStatus: 'profiling', mirrorStatus: 'pending', enabled: true });
      expect(res.body.jiraProjectKey).toBeUndefined();
    });

    it('with a Jira key the project is in REST mode and the key is the ticket prefix', async () => {
      const res = await t.agent.post('/projects/onboard').send({ repoUrl: 'https://github.com/acme/payments.git', jiraProjectKey: 'PAY' }).expect(201);
      expect(res.body).toMatchObject({ name: 'payments', jiraMode: 'rest', jiraProjectKey: 'PAY', localKeyPrefix: 'PAY', onboardingStatus: 'profiling' });
    });

    it('a second project for another owner with the same repo name gets a distinct name', async () => {
      await t.agent.post('/projects/onboard').send({ repoUrl: 'https://github.com/acme/api' }).expect(201);
      const second = await t.agent.post('/projects/onboard').send({ repoUrl: 'https://github.com/other/api' }).expect(201);
      expect(second.body.name).toBe('other-api');
      await t.prisma.project.deleteMany({ where: { name: { in: ['api', 'other-api'] } } });
    });

    it('rejects a URL that is not an HTTPS github.com repository, and a malformed key', async () => {
      const bad = await t.agent.post('/projects/onboard').send({ repoUrl: 'git@github.com:a/b.git', jiraProjectKey: 'lower' }).expect(400);
      expect(bad.body.fields).toMatchObject({ repoUrl: expect.stringContaining('github.com'), jiraProjectKey: expect.stringContaining('upper-case') });
    });

    it('the worker ignores it until confirmed, so it is also absent from nothing but its own queue', async () => {
      const res = await t.agent.post('/projects/onboard').send({ repoUrl: 'https://github.com/acme/ledger' }).expect(201);
      expect((await t.agent.get(`/projects/${res.body.id}/onboarding`).expect(200)).body).toEqual({ status: 'profiling', error: null, proposal: null });
      await t.prisma.project.delete({ where: { id: res.body.id } });
    });
  });

  describe('reviewing a proposal', () => {
    it('shows the stored proposal, so the person can leave and come back', async () => {
      const p = await proposed();
      const res = (await t.agent.get(`/projects/${p.id}/onboarding`).expect(200)).body;
      expect(res.status).toBe('proposed');
      expect(res.proposal.advice.intakeLabel).toBe('sdlc-agent');
    });

    it('accepting a section records it; editing records the change and counts as accepting', async () => {
      const p = await proposed();
      await patch(p.id, 'commands', { action: 'accept' }).expect(200);
      const edited = (await patch(p.id, 'routing', { action: 'edit', value: { issueTypeRouting: { Bug: 'chore' } } }).expect(200)).body;
      expect(edited.proposal.accepted).toEqual({ commands: true, routing: true });
      expect(edited.proposal.advice.issueTypeRouting).toMatchObject({ Bug: 'chore', Story: 'feature' });
    });

    it('edits the commands, and rejects a test command without {files}', async () => {
      const p = await proposed();
      const ok = (await patch(p.id, 'commands', { action: 'edit', value: { testCmdTemplate: 'npx vitest run {files}', baseBranch: 'dev' } }).expect(200)).body;
      expect(ok.proposal.profile).toMatchObject({ testCmdTemplate: 'npx vitest run {files}', baseBranch: 'dev', stack: 'nestjs' });
      const bad = await patch(p.id, 'commands', { action: 'edit', value: { testCmdTemplate: 'npx vitest run' } }).expect(400);
      expect(bad.body.fields.testCmdTemplate).toContain('{files}');
    });

    it('a status that is not in the Jira project, and a space the person cannot write to, are refused', async () => {
      const p = await proposed();
      const status = await patch(p.id, 'statusMap', { action: 'edit', value: { statusMap: { KB: 'Invented' } } }).expect(400);
      expect(JSON.stringify(status.body.fields)).toContain('not a status of this Jira project');
      const space = await patch(p.id, 'confluence', { action: 'edit', value: { confluenceSpaceKey: 'SECRET' } }).expect(400);
      expect(space.body.fields.confluenceSpaceKey).toContain('not a space you can write to');
      await patch(p.id, 'confluence', { action: 'edit', value: { confluenceSpaceKey: null } }).expect(200);
      const type = await patch(p.id, 'routing', { action: 'edit', value: { issueTypeRouting: { Wizard: 'bug' } } }).expect(400);
      expect(JSON.stringify(type.body.fields)).toContain('not an issue type');
    });

    it('edits the status map and approval statuses with real statuses, and the label', async () => {
      const p = await proposed();
      const res = (await patch(p.id, 'statusMap', { action: 'edit', value: { statusMap: { REVIEW: 'In Review' }, approvalStatuses: { breakdown: 'Done' } } }).expect(200)).body;
      expect(res.proposal.advice.statusMap).toMatchObject({ KB: 'In Progress', REVIEW: 'In Review' });
      expect(res.proposal.advice.approvalStatuses).toEqual({ plan: 'In Review', breakdown: 'Done' });
      expect((await patch(p.id, 'label', { action: 'edit', value: { intakeLabel: 'two words' } }).expect(400)).body.fields.intakeLabel).toBeDefined();
      expect((await patch(p.id, 'label', { action: 'edit', value: { intakeLabel: 'agent-ready' } }).expect(200)).body.proposal.advice.intakeLabel).toBe('agent-ready');
    });

    it('404 for an unknown section or project; 409 when there is no proposal yet', async () => {
      const p = await proposed();
      await patch(p.id, 'colour', { action: 'accept' }).expect(404);
      await patch('00000000-0000-0000-0000-000000000000', 'label', { action: 'accept' }).expect(404);
      const profiling = await proposed({}, { onboardingStatus: 'profiling', onboardingProposal: undefined });
      await patch(profiling.id, 'label', { action: 'accept' }).expect(409);
    });
  });

  describe('dry run', () => {
    it('counts the tickets the intake query picks up now and lists up to five', async () => {
      const p = await proposed();
      t.jira.jira.tickets = Array.from({ length: 7 }, (_, i) => ({ key: `SDA-${i + 1}`, summary: `Ticket ${i + 1}`, description: '', issuetype: 'Story', labels: ['sdlc-agent'], priority: null }));
      const res = (await t.agent.post(`/projects/${p.id}/onboarding/dry-run`).expect(200)).body;
      expect(res.count).toBe(7);
      expect(res.tickets).toHaveLength(5);
      expect(res.tickets[0]).toEqual({ key: 'SDA-1', summary: 'Ticket 1', issueType: 'Story' });
      expect(res.jql).toBe('project = "SDA" AND labels = "sdlc-agent" AND issuetype in ("Bug", "Story") ORDER BY created ASC');
      expect(res.note).toBeNull();
      expect(t.jira.jira.searches.at(-1)?.jiraJql).toBe(res.jql);
    });

    it('says the label is not used yet when nothing matches because nobody applied it', async () => {
      const p = await proposed();
      const res = (await t.agent.post(`/projects/${p.id}/onboarding/dry-run`).expect(200)).body;
      expect(res).toMatchObject({ count: 0, note: expect.stringContaining('Label not used yet') });
      await patch(p.id, 'label', { action: 'edit', value: { intakeLabel: 'backend' } }).expect(200); // "backend" is in use
      expect((await t.agent.post(`/projects/${p.id}/onboarding/dry-run`).expect(200)).body.note).toBeNull();
    });

    it('a Jira problem is a 502 with its message; a project without Jira is a 409', async () => {
      const p = await proposed();
      t.jira.jira.failWith = new Error('Jira 503');
      expect((await t.agent.post(`/projects/${p.id}/onboarding/dry-run`).expect(502)).body.message).toContain('Jira 503');
      const noJira = await proposed({}, { jiraMode: 'off', jiraProjectKey: null });
      await t.agent.post(`/projects/${noJira.id}/onboarding/dry-run`).expect(409);
    });
  });

  describe('confirming', () => {
    it('refuses until the status map and the label are accepted explicitly', async () => {
      const p = await proposed();
      const res = await t.agent.post(`/projects/${p.id}/onboarding/confirm`).expect(409);
      expect(res.body.fields).toEqual({ statusMap: 'must be accepted', label: 'must be accepted' });
      await patch(p.id, 'statusMap', { action: 'accept' }).expect(200);
      expect((await t.agent.post(`/projects/${p.id}/onboarding/confirm`).expect(409)).body.fields).toEqual({ label: 'must be accepted' });
      expect((await reload(p.id)).onboardingStatus).toBe('proposed');
    });

    it('applies the proposal to the project and its settings, and activates it', async () => {
      const p = await proposed();
      await patch(p.id, 'statusMap', { action: 'accept' });
      await patch(p.id, 'label', { action: 'accept' });
      const res = (await t.agent.post(`/projects/${p.id}/onboarding/confirm`).expect(200)).body;
      expect(res.warnings).toEqual([]);
      expect(res.project).toMatchObject({ onboardingStatus: 'confirmed', stack: 'nestjs', testCmdTemplate: 'npx jest {files}', baseBranch: 'main', jiraMode: 'rest', jiraProjectKey: 'SDA' });
      const stored = await reload(p.id);
      expect(stored.jiraJql).toBe('project = "SDA" AND labels = "sdlc-agent" AND issuetype in ("Bug", "Story") ORDER BY created ASC');
      const settings = res.project.settings;
      expect(settings.jiraStatusMap).toMatchObject({ KB: 'In Progress', DONE: 'Done', PLANNING: null });
      expect(settings.jiraApprovalStatuses).toEqual({ plan: 'In Review' });
      expect(settings.jiraIssueTypeRouting).toEqual({ Story: 'feature', Bug: 'bug', Epic: 'ignore', 'Sub-task': 'ignore' });
      expect(settings.jiraSubtaskTypeName).toBe('Sub-task');
      expect(settings.confluence).toMatchObject({ spaceKey: 'ENG', parentPageId: expect.stringMatching(/^page-/) });
      expect(t.confluence.confluence.calls).toContain('parent ENG sdlc-agent plans');
    });

    it('starts a new project with the stage models and turn limits chosen in Settings', async () => {
      await t.prisma.globalSettings.upsert({ where: { id: 'global' }, update: { stageDefaults: { plan: { model: 'haiku', maxTurns: 6 }, implement: { model: 'opus', maxTurns: 90 } } }, create: { id: 'global', stageDefaults: { plan: { model: 'haiku', maxTurns: 6 }, implement: { model: 'opus', maxTurns: 90 } } } });
      const p = await proposed();
      await patch(p.id, 'statusMap', { action: 'accept' });
      await patch(p.id, 'label', { action: 'accept' });
      const stages = (await t.agent.post(`/projects/${p.id}/onboarding/confirm`).expect(200)).body.project.settings.stages;
      expect(stages.plan).toMatchObject({ model: 'haiku', maxTurns: 6 });
      expect(stages.implement).toMatchObject({ model: 'opus', maxTurns: 90, enabled: true });
      expect(stages.review).toMatchObject({ model: 'sonnet', maxTurns: 10 }); // not set: the built-in default
      await t.prisma.globalSettings.deleteMany();
    });

    it('closes the onboarding ticket and resolves it as confirmed', async () => {
      const p = await proposed();
      await raiser.raise({ kind: 'onboarding', projectId: p.id, title: 'Review', body: 'b', dedupeKey: `onboarding:${p.id}` });
      await patch(p.id, 'statusMap', { action: 'accept' });
      await patch(p.id, 'label', { action: 'accept' });
      await t.agent.post(`/projects/${p.id}/onboarding/confirm`).expect(200);
      expect(await t.prisma.supportTicket.findMany({ where: { projectId: p.id } })).toMatchObject([{ kind: 'onboarding', status: 'resolved', resolvedBy: 'user' }]);
    });

    it('a Confluence failure is a warning, not a failure: the project goes without it', async () => {
      const p = await proposed();
      await patch(p.id, 'statusMap', { action: 'accept' });
      await patch(p.id, 'label', { action: 'accept' });
      t.confluence.confluence.failWith = new Error('Confluence 403: no permission');
      const res = (await t.agent.post(`/projects/${p.id}/onboarding/confirm`).expect(200)).body;
      expect(res.warnings[0]).toContain('Confluence 403');
      expect(res.project.onboardingStatus).toBe('confirmed');
      expect(res.project.settings.confluence).toBeNull();
    });

    it('a project without Jira needs no status map or label, and gets no Jira settings', async () => {
      const p = await proposed(
        { facts: { github: { defaultBranch: 'main', languages: [] }, jira: null, confluence: { spaces: null, reason: 'not configured' } }, advice: { statusMap: {}, approvalStatuses: { plan: null, breakdown: null }, issueTypeRouting: {}, intakeLabel: 'sdlc-agent', confluenceSpaceKey: null } },
        { jiraMode: 'off', jiraProjectKey: null },
      );
      const res = (await t.agent.post(`/projects/${p.id}/onboarding/confirm`).expect(200)).body;
      expect(res.project).toMatchObject({ onboardingStatus: 'confirmed', jiraMode: 'off' });
      expect((await reload(p.id)).jiraJql).toBeNull();
    });

    it('a changed base branch queues a fresh mirror', async () => {
      const p = await proposed({}, { mirrorStatus: 'ok', baseBranch: 'main' });
      await patch(p.id, 'commands', { action: 'edit', value: { baseBranch: 'develop' } });
      await patch(p.id, 'statusMap', { action: 'accept' });
      await patch(p.id, 'label', { action: 'accept' });
      await t.agent.post(`/projects/${p.id}/onboarding/confirm`).expect(200);
      expect(await reload(p.id)).toMatchObject({ baseBranch: 'develop', mirrorStatus: 'pending' });
    });

    it('409 when there is nothing to confirm, and a confirmed project cannot be confirmed twice', async () => {
      const profiling = await proposed({}, { onboardingStatus: 'profiling', onboardingProposal: undefined });
      await t.agent.post(`/projects/${profiling.id}/onboarding/confirm`).expect(409);
      const p = await proposed();
      await patch(p.id, 'statusMap', { action: 'accept' });
      await patch(p.id, 'label', { action: 'accept' });
      await t.agent.post(`/projects/${p.id}/onboarding/confirm`).expect(200);
      await t.agent.post(`/projects/${p.id}/onboarding/confirm`).expect(409);
    });
  });

  describe('running it again', () => {
    it('makes a new proposal and changes nothing until it is confirmed again', async () => {
      const p = await proposed({}, { stack: 'nextjs', testCmdTemplate: 'keep {files}' });
      await raiser.raise({ kind: 'onboarding', projectId: p.id, title: 'Review', body: 'b', dedupeKey: `onboarding:${p.id}` });
      const res = (await t.agent.post(`/projects/${p.id}/onboarding/rerun`).expect(200)).body;
      expect(res).toMatchObject({ status: 'profiling', error: null });
      expect(await reload(p.id)).toMatchObject({ stack: 'nextjs', testCmdTemplate: 'keep {files}' }); // settings untouched
      expect((await t.prisma.supportTicket.findFirstOrThrow({ where: { projectId: p.id } })).status).toBe('dismissed');
      await t.agent.post(`/projects/${p.id}/onboarding/rerun`).expect(409); // already profiling
    });

    it('works from a failed draft too', async () => {
      const p = await proposed({}, { onboardingStatus: 'draft', onboardingError: 'GitHub: Not Found', onboardingProposal: undefined });
      expect((await t.agent.post(`/projects/${p.id}/onboarding/rerun`).expect(200)).body).toMatchObject({ status: 'profiling', error: null });
    });
  });

  it('the project API shows the onboarding state and does not let a PATCH change it', async () => {
    const p = await proposed();
    const got = (await t.agent.get(`/projects/${p.id}`).expect(200)).body;
    expect(got).toMatchObject({ onboardingStatus: 'proposed', onboardingError: null });
    const patched = (await t.agent.patch(`/projects/${p.id}`).send({ onboardingStatus: 'confirmed', kbDir: 'docs/kb2' }).expect(200)).body;
    expect(patched.kbDir).toBe('docs/kb2');
    expect((await reload(p.id)).onboardingStatus).toBe('proposed');
  });
});
