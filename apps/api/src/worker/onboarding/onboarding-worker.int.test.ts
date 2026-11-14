import 'reflect-metadata';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { OnboardAdvice, OnboardingProposal, RepoProfile, StageEnvelope } from '@sdlc/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JiraNotConfiguredError } from '../../jira/jira-clients';
import { PrismaService } from '../../prisma/prisma.service';
import { SupportRaiser } from '../../support/support-raiser';
import { FakeConfluence, FakeConfluenceClients } from '../../testing/fake-confluence';
import { FakeGitHub } from '../../testing/fake-github';
import { FakeJira, FakeJiraClients } from '../../testing/fake-jira';
import { type TestDatabase, createTestDatabase } from '../../testing/test-db';
import type { StageRequest, StageResult } from '../agent-runner/agent-runner';
import { WorkerConfig } from '../worker-config';
import { OnboardingWorker, factsText, sanitizeAdvice } from './onboarding-worker';

const profile: RepoProfile = { stack: 'nestjs', installCmd: 'npm ci', typecheckCmd: 'npx tsc --noEmit', testCmdTemplate: 'npx jest {files}', kbDir: 'docs/kb', testFilePattern: '**/*.spec.ts', exampleTestFile: 'src/a.spec.ts' };
const advice: OnboardAdvice = {
  statusMap: { KB: 'In Progress', PLANNING: 'In Progress', DONE: 'Done', FAILED: 'Made up status' },
  approvalStatuses: { plan: 'Plan Approved', breakdown: null },
  issueTypeRouting: { Story: 'feature', Bug: 'bug', Epic: 'ignore', 'Sub-task': 'feature' },
  intakeLabel: 'sdlc-agent',
  confluenceSpaceKey: 'ENG',
};
const done = (data: unknown): StageResult => ({ kind: 'done', envelope: { status: 'done', summary: 's', data } as StageEnvelope, stageRunId: 'r', attempts: 1 });

describe('OnboardingWorker (BUILD_PLAN v1 6.7)', () => {
  let db: TestDatabase;
  let prisma: PrismaService;
  let tmp: string;
  let worker: OnboardingWorker;
  let github: FakeGitHub;
  let jiraClients: FakeJiraClients;
  let jira: FakeJira;
  let confluence: FakeConfluence;
  let requests: StageRequest[] = [];
  let agent: (req: StageRequest) => StageResult;
  let verifyCalls: { cmd: string }[] = [];
  let verifyOk: Record<string, boolean>;
  let n = 0;

  const project = (over: Record<string, unknown> = {}) =>
    prisma.project.create({ data: { name: `acme-${++n}`, repoUrl: 'https://github.com/acme/billing', stack: 'ts_node', testCmdTemplate: 'echo {files}', localKeyPrefix: `A${n}`, onboardingStatus: 'profiling', jiraMode: 'rest', jiraProjectKey: 'SDA', ...over } });
  const reload = (id: string) => prisma.project.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    db = await createTestDatabase();
    process.env.DATABASE_URL = db.url;
    prisma = new PrismaService();
    await prisma.onModuleInit();
    tmp = mkdtempSync(path.join(tmpdir(), 'sdlc-onboard-'));
    const config = new WorkerConfig({ DATA_DIR: path.join(tmp, 'data'), DATABASE_URL: db.url } as NodeJS.ProcessEnv);
    github = new FakeGitHub();
    jiraClients = new FakeJiraClients();
    jira = jiraClients.jira;
    const confluenceClients = new FakeConfluenceClients();
    confluence = confluenceClients.confluence;
    const mirrors = {
      async clone(p: { id: string }) {
        mkdirSync(config.mirrorPath(p.id), { recursive: true });
        await prisma.project.update({ where: { id: p.id }, data: { mirrorStatus: github.facts.defaultBranch === 'broken' ? 'failed' : 'ok', mirrorError: github.facts.defaultBranch === 'broken' ? 'Base branch "broken" was not found' : null } });
      },
    };
    const git = { async run(args: string[]) { mkdirSync(args[args.length - 1] as string, { recursive: true }); return { stdout: '', stderr: '' }; } };
    const runner = { async run(req: StageRequest) { requests.push(req); return agent(req); } };
    const verify = {
      async runCmd(a: { cmd: string }) {
        verifyCalls.push({ cmd: a.cmd });
        const ok = verifyOk[a.cmd] ?? true;
        return { ok, exitCode: ok ? 0 : 1, timedOut: false, tail: ok ? 'ok' : 'error TS2304: Cannot find name', output: '' };
      },
    };
    worker = new OnboardingWorker(prisma, config, mirrors as never, git as never, github, jiraClients, confluenceClients, runner as never, verify as never, new SupportRaiser(prisma));
  }, 180_000);
  afterAll(async () => {
    await prisma?.onModuleDestroy();
    await db?.drop();
    rmSync(tmp, { recursive: true, force: true });
  });
  beforeEach(async () => {
    requests = [];
    verifyCalls = [];
    verifyOk = {};
    github.facts = { defaultBranch: 'main', languages: ['TypeScript'] };
    github.failFacts = null;
    jira.failWith = null;
    confluence.failWith = null;
    agent = (req) => done(req.stage === 'repoProfile' ? profile : advice);
    await prisma.supportTicket.deleteMany();
    await prisma.globalSettings.deleteMany();
    await prisma.project.deleteMany({ where: { name: { startsWith: 'acme-' } } });
  });

  it('collects the facts, runs both agents and leaves a proposal for review, with one onboarding ticket', async () => {
    const p = await project();
    await worker.check();
    const after = await reload(p.id);
    expect(after).toMatchObject({ onboardingStatus: 'proposed', onboardingError: null, baseBranch: 'main', mirrorStatus: 'ok' });
    const proposal = after.onboardingProposal as unknown as OnboardingProposal;
    expect(proposal.facts.github).toEqual({ defaultBranch: 'main', languages: ['TypeScript'] });
    expect(proposal.facts.jira?.issueTypes.map((t) => t.name)).toContain('Story');
    expect(proposal.facts.confluence).toEqual({ spaces: [{ key: 'ENG', name: 'Engineering' }, { key: 'SDA', name: 'SDA Platform' }] });
    expect(proposal.profile).toMatchObject({ stack: 'nestjs', testCmdTemplate: 'npx jest {files}', baseBranch: 'main', installCheck: { command: 'npm ci', ok: true }, typecheckCheck: { command: 'npx tsc --noEmit', ok: true } });
    expect(proposal.accepted).toEqual({});
    expect(requests.map((r) => r.stage)).toEqual(['repoProfile', 'onboardAdvise']);
    expect(requests[0]?.workspacePath).toContain(path.join('onboarding', p.id));
    expect(requests[1]?.workspacePath).toBeUndefined();
    expect(requests[1]?.inputs.onboard?.facts).toContain('Issue types:');
    expect(await prisma.supportTicket.findMany({ where: { projectId: p.id } })).toMatchObject([{ kind: 'onboarding', status: 'open', priority: 'blocking', ticketId: null }]);
  });

  it('never leaves an invented Jira status, issue type route or Confluence space in the proposal', async () => {
    const p = await project();
    agent = (req) => done(req.stage === 'repoProfile' ? profile : { ...advice, confluenceSpaceKey: 'NOPE', approvalStatuses: { plan: 'Plan Approved', breakdown: 'Ghost' } });
    await worker.check();
    const a = ((await reload(p.id)).onboardingProposal as unknown as OnboardingProposal).advice;
    expect(a.statusMap.FAILED).toBeNull(); // not a status of the project
    expect(a.statusMap.KB).toBe('In Progress');
    expect(a.approvalStatuses).toEqual({ plan: null, breakdown: null }); // "Plan Approved" is not in the fake project either
    expect(a.confluenceSpaceKey).toBeNull();
    expect(a.issueTypeRouting['Sub-task']).toBe('ignore'); // the sub-task type is always ignored
  });

  it('without a Jira key there is no advisor run, and the proposal still has the commands', async () => {
    const p = await project({ jiraMode: 'off', jiraProjectKey: null });
    await worker.check();
    expect(requests.map((r) => r.stage)).toEqual(['repoProfile']);
    const proposal = (await reload(p.id)).onboardingProposal as unknown as OnboardingProposal;
    expect(proposal.facts.jira).toBeNull();
    expect(proposal.advice).toMatchObject({ intakeLabel: 'sdlc-agent', issueTypeRouting: {}, confluenceSpaceKey: null });
  });

  it('works when Confluence cannot be reached, and says why', async () => {
    const p = await project();
    confluence.failWith = new Error('Confluence 401: Unauthorized');
    await worker.check();
    const proposal = (await reload(p.id)).onboardingProposal as unknown as OnboardingProposal;
    expect(proposal.facts.confluence).toEqual({ spaces: null, reason: 'Confluence 401: Unauthorized' });
    expect(proposal.advice.confluenceSpaceKey).toBeNull();
  });

  it('records a failing install and does not run the typecheck after it', async () => {
    const p = await project();
    verifyOk['npm ci'] = false;
    await worker.check();
    const proposal = (await reload(p.id)).onboardingProposal as unknown as OnboardingProposal;
    expect(proposal.profile.installCheck).toMatchObject({ ok: false, tail: expect.stringContaining('TS2304') });
    expect(proposal.profile.typecheckCheck).toBeNull();
    expect(verifyCalls.map((c) => c.cmd)).toEqual(['npm ci']);
  });

  it('skips an empty command', async () => {
    const p = await project();
    agent = (req) => done(req.stage === 'repoProfile' ? { ...profile, typecheckCmd: '' } : advice);
    await worker.check();
    expect(((await reload(p.id)).onboardingProposal as unknown as OnboardingProposal).profile.typecheckCheck).toBeNull();
    expect(verifyCalls.map((c) => c.cmd)).toEqual(['npm ci']);
  });

  describe('failure leaves the project in draft with the reason, never half-configured', () => {
    it('a GitHub problem', async () => {
      const p = await project();
      github.failFacts = new Error('gh: Not Found (HTTP 404)');
      await worker.check();
      expect(await reload(p.id)).toMatchObject({ onboardingStatus: 'draft', onboardingProposal: null, onboardingError: expect.stringContaining('gh: Not Found (HTTP 404). Check the GitHub token') });
      expect(requests).toHaveLength(0);
    });

    it('Jira not configured, or a wrong key', async () => {
      const p = await project();
      jira.failWith = new JiraNotConfiguredError();
      await worker.check();
      expect((await reload(p.id)).onboardingError).toContain('Jira is not configured');
      const q = await project();
      jira.failWith = new Error('Jira 404: No project could be found with key SDA');
      await worker.check();
      expect((await reload(q.id)).onboardingError).toContain('Check the project key');
    });

    it('a mirror that cannot be cloned', async () => {
      const p = await project();
      github.facts = { defaultBranch: 'broken', languages: [] };
      await worker.check();
      expect(await reload(p.id)).toMatchObject({ onboardingStatus: 'draft', onboardingError: 'Base branch "broken" was not found' });
    });

    it('an agent that fails, asks, or hits a limit', async () => {
      const p = await project();
      agent = () => ({ kind: 'needs_input', question: 'Which package manager?', stageRunId: 'r', attempts: 1 });
      await worker.check();
      expect((await reload(p.id)).onboardingError).toContain('Which package manager?');
      const q = await project();
      agent = () => ({ kind: 'rate_limited', errorCode: 'CLAUDE_USAGE_LIMIT', resetsAt: null, stageRunId: 'r', attempts: 1 });
      await worker.check();
      expect((await reload(q.id)).onboardingError).toContain('usage limit');
    });

    it('output that does not fit the schema is refused by the runner, so the error is plain', async () => {
      const p = await project();
      agent = () => ({ kind: 'failed', reason: 'Output failed validation: data.testCmdTemplate: must contain {files}', errorCode: 'INVALID_OUTPUT', stageRunId: 'r', attempts: 2 });
      await worker.check();
      expect((await reload(p.id)).onboardingError).toContain('must contain {files}');
    });
  });

  it('handles one project at a time and ignores projects that are not profiling', async () => {
    const a = await project();
    const b = await project();
    await project({ onboardingStatus: 'confirmed' });
    await worker.check();
    expect((await reload(a.id)).onboardingStatus).toBe('proposed');
    expect((await reload(b.id)).onboardingStatus).toBe('profiling');
    await worker.check();
    expect((await reload(b.id)).onboardingStatus).toBe('proposed');
    await worker.check(); // nothing left
    expect(requests.length).toBe(4);
  });

  it('waits while the pipeline is paused for limits, but not when paused by hand', async () => {
    const p = await project();
    await prisma.globalSettings.create({ data: { id: 'global', pipelinePaused: true, pausedReason: 'Claude usage limit', pausedCode: 'CLAUDE_USAGE_LIMIT' } });
    await worker.check();
    expect((await reload(p.id)).onboardingStatus).toBe('profiling');
    await prisma.globalSettings.update({ where: { id: 'global' }, data: { pausedReason: 'manual', pausedCode: null } });
    await worker.check();
    expect((await reload(p.id)).onboardingStatus).toBe('proposed');
  });
});

describe('factsText and sanitizeAdvice (pure)', () => {
  it('writes the facts as plain text the advisor can read', () => {
    const t = factsText('billing', {
      github: { defaultBranch: 'main', languages: ['TypeScript'] },
      jira: { projectName: 'Billing', issueTypes: [{ name: 'Story', subtask: false }, { name: 'Sub-task', subtask: true }], statusesByType: [{ type: 'Story', statuses: [{ name: 'To Do', category: 'new' }] }], labels: [] },
      confluence: { spaces: null, reason: 'no access' },
    });
    expect(t).toContain('- Sub-task (the sub-task type)');
    expect(t).toContain('- Story: To Do [new]');
    expect(t).toContain('Labels already in use: none');
    expect(t).toContain('Confluence is not available: no access');
  });

  it('with no advice at all, falls back on the default routing and label', () => {
    const jira = { projectName: 'x', issueTypes: [{ name: 'Bug', subtask: false }, { name: 'Epic', subtask: false }], statusesByType: [], labels: [] };
    expect(sanitizeAdvice(null, jira, [])).toEqual({ statusMap: {}, approvalStatuses: { plan: null, breakdown: null }, issueTypeRouting: { Bug: 'bug', Epic: 'ignore' }, intakeLabel: 'sdlc-agent', confluenceSpaceKey: null });
  });
});
