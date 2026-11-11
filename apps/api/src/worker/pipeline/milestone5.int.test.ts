import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApprovalPoller } from '../../jira/approval-poller';
import { PrismaService } from '../../prisma/prisma.service';
import { SubtasksService } from '../../subtasks/subtasks.service';
import { StateMachine } from '../../state/state-machine.service';
import { TicketsModule } from '../../tickets/tickets.module';
import { docker, leftoverAgentContainers, startEgress, type EgressFixture } from '../../testing/docker-fixture';
import { FakeJiraClients } from '../../testing/fake-jira';
import { type TestApp, createTestApp } from '../../testing/test-app';
import { type TestDatabase, createTestDatabase } from '../../testing/test-db';
import { AgentRunner } from '../agent-runner/agent-runner';
import { DockerodeEngine } from '../agent-runner/container-engine';
import { ContainerRunner } from '../agent-runner/container-runner';
import { FileLogSink } from '../agent-runner/file-log-sink';
import { PrismaStageRunStore } from '../agent-runner/stage-run-store';
import { GitRunner } from '../git/git-runner';
import { MirrorService } from '../git/mirror.service';
import { WorkspaceService } from '../git/workspace.service';
import { IntakePoller } from '../intake/intake-poller';
import { WorkerLoop } from '../loop/worker-loop';
import { VerifyService } from '../verify/verify.service';
import { WorkerConfig } from '../worker-config';
import { KbBuildService } from './kb-build.service';
import { KbHandler } from './kb.handler';
import { NewTicketHandler } from './new-ticket.handler';
import { PlanHandler } from './plan.handler';
import { StageLauncher } from './stage-launcher';
import { StageOutcomes } from './stage-outcomes';

const ROOT = path.resolve(__dirname, '../../../../..');
const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

/**
 * Milestone 5, "done when": with fake-claude, a ticket goes from NEW to AWAITING_PLAN_APPROVAL, can be edited, approved and
 * rejected, and the docs commit appears on the ticket branch. Real worker loop, real git, real containers; only the model is a stub.
 */
describe('milestone 5 end to end (real containers, fake-claude)', () => {
  let db: TestDatabase;
  let prisma: PrismaService;
  let app: TestApp;
  let egress: EgressFixture;
  let tmp: string;
  let dataDir: string;
  let projectId: string;
  let loop: WorkerLoop;
  let n = 0;

  const ticket = (title: string) => prisma.ticket.create({ data: { projectId, key: `BILL-${++n}`, source: 'paste', title, body: 'Please add a CSV export of all bookings.', status: 'NEW' } });
  const status = async (id: string) => (await prisma.ticket.findUniqueOrThrow({ where: { id } })).status;
  const runUntilIdle = async () => {
    for (let i = 0; i < 12; i++) if ((await loop.tick()) !== 'stepped') return;
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    process.env.DATABASE_URL = db.url;
    prisma = new PrismaService();
    await prisma.onModuleInit();
    tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'sdlc-m5-')));
    dataDir = path.join(tmp, 'data');
    mkdirSync(dataDir, { recursive: true });
    chmodSync(dataDir, 0o777);

    // The target repository: it already has a KB with one feature.
    const source = path.join(tmp, 'source');
    execFileSync('git', ['init', '-q', '-b', 'dev', source]);
    mkdirSync(path.join(source, 'docs/kb'), { recursive: true });
    mkdirSync(path.join(source, 'src'));
    writeFileSync(path.join(source, 'package.json'), '{}');
    writeFileSync(path.join(source, 'src/app.ts'), 'export {};\n');
    writeFileSync(path.join(source, 'docs/kb/features.json'), JSON.stringify({ version: 1, features: [{ key: 'bookings', title: 'Bookings', doc: 'bookings.md' }] }));
    writeFileSync(path.join(source, 'docs/kb/bookings.md'), '# Bookings');
    sh(source, 'add', '.');
    sh(source, 'commit', '-q', '-m', 'init');

    const config = new WorkerConfig({
      DATA_DIR: dataDir, DATABASE_URL: db.url, CLAUDE_CODE_OAUTH_TOKEN: 'fake-token', GUIDELINES_DIR: path.join(ROOT, 'guidelines'),
      GIT_AUTHOR_NAME: 'Dev Bot', GIT_AUTHOR_EMAIL: 'bot@example.com',
      AGENT_EXTRA_BINDS: `${ROOT}/test/fake-claude/claude:/usr/local/bin/claude:ro,${ROOT}/test/fake-claude:/fake-claude:ro`,
      AGENT_EXTRA_ENV: 'FAKE_SCENARIO=kb-new,FAKE_SCENARIOS_DIR=/fake-claude/scenarios',
    } as NodeJS.ProcessEnv);

    const project = await prisma.project.create({ data: { name: 'billing', repoUrl: `file://${source}`, baseBranch: 'dev', stack: 'nestjs', installCmd: 'echo installed', testCmdTemplate: 'x {files}', localKeyPrefix: 'BILL', mirrorStatus: 'pending' } });
    projectId = project.id;
    const mirrors = new MirrorService(prisma, config);
    await mirrors.clone(project);

    egress = await startEgress();
    const containers = new ContainerRunner(new DockerodeEngine(docker));
    const git = new GitRunner({ githubToken: '' });
    const workspaces = new WorkspaceService(prisma, config, git, new VerifyService(containers, config));
    const agent = new AgentRunner(containers, config, new PrismaStageRunStore(prisma), new FileLogSink(config));
    const launcher = new StageLauncher(prisma, config, agent);
    const outcomes = new StageOutcomes(prisma);
    const kbBuild = new KbBuildService(prisma, launcher, outcomes, workspaces, git);
    const jira = new FakeJiraClients();
    const states = new StateMachine(prisma);
    loop = new WorkerLoop(
      prisma, mirrors, new IntakePoller(prisma, jira), new ApprovalPoller(prisma, jira, states, new SubtasksService(prisma)), states,
      [new NewTicketHandler(workspaces), new KbHandler(prisma, workspaces, kbBuild), new PlanHandler(prisma, launcher, outcomes, jira)],
    );
    app = await createTestApp(db.url, [TicketsModule]);
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await egress?.stop();
    await prisma?.onModuleDestroy();
    await db?.drop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('takes a ticket from NEW to AWAITING_PLAN_APPROVAL, with the docs commit on the ticket branch', async () => {
    const t = await ticket('Export bookings to CSV');
    await runUntilIdle();
    expect(await status(t.id)).toBe('AWAITING_PLAN_APPROVAL');

    const transitions = (await prisma.stateTransition.findMany({ where: { ticketId: t.id }, orderBy: { at: 'asc' } })).map((r) => `${r.fromStatus}>${r.toStatus}`);
    expect(transitions).toEqual(['NEW>KB', 'KB>PLANNING', 'PLANNING>AWAITING_PLAN_APPROVAL']);

    const ws = path.join(dataDir, 'workspaces', projectId, t.key);
    const branch = `feature/${t.key}-export-bookings-to-csv`;
    expect(sh(ws, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branch);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).branch).toBe(branch);

    // The docs commit: right message, right author, only KB files, index updated, nothing outside kbDir.
    expect(sh(ws, 'log', '-1', '--format=%s')).toBe(`docs(${t.key}): add billing-export knowledge base doc`);
    expect(sh(ws, 'log', '-1', '--format=%an <%ae>')).toBe('Dev Bot <bot@example.com>');
    expect(sh(ws, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual(['docs/kb/billing-export.md', 'docs/kb/features.json']);
    expect(sh(ws, 'log', '--format=%s', `dev..${branch}`)).toBe(`docs(${t.key}): add billing-export knowledge base doc`);
    expect(JSON.parse(readFileSync(path.join(ws, 'docs/kb/features.json'), 'utf8')).features.map((f: { key: string }) => f.key)).toEqual(['billing-export', 'bookings']);
    expect(existsSync(path.join(ws, 'src/oops.ts'))).toBe(false); // the stray edit outside kbDir was reverted
    expect((await prisma.event.findMany({ where: { ticketId: t.id, type: 'git' } })).some((e) => e.message.includes('outside docs/kb'))).toBe(true);

    // The plan is saved, and every stage run was recorded and logged.
    const row = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
    expect(row.featureKey).toBe('billing-export');
    expect(row.planMarkdown).toContain('# Plan');
    const runs = await prisma.stageRun.findMany({ where: { ticketId: t.id }, orderBy: { startedAt: 'asc' } });
    expect(runs.map((r) => [r.stage, r.status])).toEqual([['kbBuild', 'succeeded'], ['plan', 'succeeded']]);
    for (const r of runs) expect(existsSync(r.logPath as string)).toBe(true);
    expect(await leftoverAgentContainers()).toEqual([]);

    // Waiting at the gate: nothing more happens.
    expect(await loop.tick()).toBe('idle');
    expect(await status(t.id)).toBe('AWAITING_PLAN_APPROVAL');
  }, 240_000);

  it('the plan can be edited and approved, and the ticket moves on', async () => {
    const t = await ticket('Add booking export filters');
    await runUntilIdle();
    expect(await status(t.id)).toBe('AWAITING_PLAN_APPROVAL');
    await app.agent.post(`/tickets/${t.id}/plan/approve`).send({ planMarkdown: '# Plan (edited by the developer)' }).expect(200);
    const row = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
    expect(row).toMatchObject({ status: 'BREAKDOWN', planMarkdown: '# Plan (edited by the developer)' });
    expect(await loop.tick()).toBe('idle'); // breakdown is milestone 6
  }, 240_000);

  it('a rejected plan is planned again with the previous plan and the note', async () => {
    const t = await ticket('Add booking export scheduling');
    await runUntilIdle();
    const firstPlan = (await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).planMarkdown;
    await app.agent.post(`/tickets/${t.id}/plan/reject`).send({ note: 'Reuse the existing job queue' }).expect(200);
    expect(await status(t.id)).toBe('PLANNING');
    await runUntilIdle();
    expect(await status(t.id)).toBe('AWAITING_PLAN_APPROVAL');

    const planRuns = await prisma.stageRun.findMany({ where: { ticketId: t.id, stage: 'plan' }, orderBy: { startedAt: 'asc' } });
    expect(planRuns).toHaveLength(2);
    const prompt = readFileSync(path.join(dataDir, 'runs', (planRuns[1] as { id: string }).id, 'prompt.md'), 'utf8');
    expect(prompt).toContain('## Previous plan');
    expect(prompt).toContain(firstPlan as string);
    expect(prompt).toContain('## Rejection note');
    expect(prompt).toContain('Reuse the existing job queue');
    expect(readFileSync(path.join(dataDir, 'runs', (planRuns[0] as { id: string }).id, 'prompt.md'), 'utf8')).not.toContain('Rejection note');
    expect(readdirSync(path.join(dataDir, 'runs')).length).toBeGreaterThanOrEqual(6);
  }, 240_000);
});
