import { CredentialsService } from '../../credentials/credentials.service';
import { staticCredentials } from '../../testing/static-credentials';
import 'reflect-metadata';
import type { TicketStatus } from '@sdlc/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalPoller } from '../../jira/approval-poller';
import { SubtasksService } from '../../subtasks/subtasks.service';
import { PrismaService } from '../../prisma/prisma.service';
import { StateMachine } from '../../state/state-machine.service';
import { FakeJiraClients } from '../../testing/fake-jira';
import { type TestDatabase, createTestDatabase } from '../../testing/test-db';
import { IntakePoller } from '../intake/intake-poller';
import type { StepHandler, StepOutcome } from '../pipeline/step-handler';
import { MirrorService } from '../git/mirror.service';
import { WorkerConfig } from '../worker-config';
import { WorkerLoop } from './worker-loop';

describe('worker loop (BUILD_PLAN 6.6, F4)', () => {
  let db: TestDatabase;
  let prisma: PrismaService;
  let states: StateMachine;
  let jira: FakeJiraClients;
  let projectId: string;
  let n = 0;
  let clock = 5_000_000;
  const ran: string[] = [];

  const handler = (status: TicketStatus, outcome: (t: { key: string }) => StepOutcome | Promise<StepOutcome>): StepHandler => ({
    status,
    async run(ticket) {
      ran.push(`${ticket.key}:${status}`);
      return outcome(ticket);
    },
  });
  const loopWith = (handlers: StepHandler[]) => {
    const config = new WorkerConfig({ DATA_DIR: '/tmp/sdlc-loop', DATABASE_URL: db.url } as NodeJS.ProcessEnv);
    return new WorkerLoop(prisma, new MirrorService(prisma, config, staticCredentials()), new IntakePoller(prisma, jira, () => clock), new ApprovalPoller(prisma, jira, states, new SubtasksService(prisma, jira)), states, handlers, () => clock);
  };
  const ticket = async (status: TicketStatus = 'NEW', over: Record<string, unknown> = {}) => {
    n++;
    return prisma.ticket.create({ data: { projectId, key: `T-${n}`, source: 'paste', title: `t${n}`, status, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)), ...over } });
  };
  const status = async (id: string) => (await prisma.ticket.findUniqueOrThrow({ where: { id } })).status;

  beforeAll(async () => {
    db = await createTestDatabase();
    process.env.DATABASE_URL = db.url;
    prisma = new PrismaService();
    await prisma.onModuleInit();
    states = new StateMachine(prisma);
    jira = new FakeJiraClients();
  }, 180_000);
  afterAll(async () => {
    await prisma?.onModuleDestroy();
    await db?.drop();
  });
  beforeEach(async () => {
    ran.length = 0;
    await prisma.event.deleteMany();
    await prisma.stateTransition.deleteMany();
    await prisma.stageRun.deleteMany();
    await prisma.ticket.deleteMany();
    await prisma.project.deleteMany();
    await prisma.globalSettings.deleteMany();
    projectId = (await prisma.project.create({ data: { name: `p${++n}`, repoUrl: 'https://x/y', stack: 'ts_node', testCmdTemplate: 'x {files}', localKeyPrefix: 'P', mirrorStatus: 'ok' } })).id;
    clock += 1_000_000;
  });

  it('runs no step and clones nothing while the required credentials are missing (setup incomplete)', async () => {
    const saved = { ...process.env };
    for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'GITHUB_TOKEN', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'DASHBOARD_PASSWORD']) delete process.env[k];
    try {
      const config = new WorkerConfig({ DATA_DIR: '/tmp/sdlc-loop', DATABASE_URL: db.url } as NodeJS.ProcessEnv);
      const creds = new CredentialsService(prisma);
      const loop = new WorkerLoop(prisma, new MirrorService(prisma, config, creds), new IntakePoller(prisma, jira, () => clock), new ApprovalPoller(prisma, jira, states, new SubtasksService(prisma, jira)), states, [handler('NEW', () => ({ kind: 'stay' }))], () => clock, [], undefined, creds);
      const t = await ticket('NEW');
      const pending = await prisma.project.update({ where: { id: projectId }, data: { mirrorStatus: 'pending', mirrorError: null } });
      expect(await loop.tick()).toBe('not_configured');
      expect(ran).toEqual([]);
      expect(await status(t.id)).toBe('NEW');
      expect((await prisma.project.findUniqueOrThrow({ where: { id: pending.id } })).mirrorError).toContain('Waiting for setup');
      await prisma.project.update({ where: { id: projectId }, data: { mirrorStatus: 'ok', mirrorError: null } });
    } finally {
      process.env = saved;
    }
  });

  it('runs exactly one step for the oldest actionable ticket, then applies the transition', async () => {
    const old = await ticket('NEW');
    const newer = await ticket('NEW');
    const loop = loopWith([handler('NEW', () => ({ kind: 'transition', to: 'KB', reason: 'picked up' }))]);
    expect(await loop.tick()).toBe('stepped');
    expect(ran).toEqual([`${old.key}:NEW`]);
    expect(await status(old.id)).toBe('KB');
    expect(await status(newer.id)).toBe('NEW');
    expect((await prisma.stateTransition.findMany({ where: { ticketId: old.id } }))[0]).toMatchObject({ toStatus: 'KB', actor: 'system', reason: 'picked up' });
  });

  it('keeps running one ticket until it reaches a gate, then moves on to the next', async () => {
    const first = await ticket('NEW');
    const second = await ticket('NEW');
    const loop = loopWith([
      handler('NEW', () => ({ kind: 'transition', to: 'KB' })),
      handler('KB', () => ({ kind: 'transition', to: 'PLANNING' })),
      handler('PLANNING', () => ({ kind: 'transition', to: 'AWAITING_PLAN_APPROVAL' })), // a gate: no handler for AWAITING_PLAN_APPROVAL
    ]);
    const outcomes: string[] = [];
    for (let i = 0; i < 8; i++) outcomes.push(await loop.tick());
    expect(ran.slice(0, 3)).toEqual([`${first.key}:NEW`, `${first.key}:KB`, `${first.key}:PLANNING`]);
    expect(await status(first.id)).toBe('AWAITING_PLAN_APPROVAL');
    expect(await status(second.id)).toBe('AWAITING_PLAN_APPROVAL');
    expect(outcomes.at(-1)).toBe('idle'); // nothing actionable is left: both wait at the gate
  });

  it('only picks actionable tickets: not held, awaiting, waiting, finished or failed ones', async () => {
    for (const s of ['ON_HOLD', 'AWAITING_PLAN_APPROVAL', 'AWAITING_BREAKDOWN_APPROVAL', 'AWAITING_CI', 'IN_HUMAN_REVIEW', 'DONE', 'FAILED'] as TicketStatus[]) await ticket(s);
    const all = (['NEW', 'KB', 'PLANNING', 'BREAKDOWN', 'IN_PROGRESS', 'REVIEW', 'KB_UPDATE', 'AWAITING_CI'] as TicketStatus[]).map((s) => handler(s, () => ({ kind: 'stay' })));
    expect(await loopWith(all).tick()).toBe('idle');
    expect(ran).toEqual([]);
  });

  it('picks an AWAITING_CI ticket only when a CI fix is pending', async () => {
    const waiting = await ticket('AWAITING_CI');
    const fixing = await ticket('AWAITING_CI', { ciFixPending: true });
    const loop = loopWith([handler('AWAITING_CI', () => ({ kind: 'stay' }))]);
    await loop.tick();
    expect(ran).toEqual([`${fixing.key}:AWAITING_CI`]);
    expect(await status(waiting.id)).toBe('AWAITING_CI');
  });

  it('skips tickets of disabled projects, and states with no handler, without spinning', async () => {
    const other = await prisma.project.create({ data: { name: 'off', repoUrl: 'https://x/y', stack: 'ts_node', testCmdTemplate: 'x {files}', localKeyPrefix: 'O', enabled: false, mirrorStatus: 'ok' } });
    await ticket('NEW', { projectId: other.id });
    const planning = await ticket('PLANNING'); // no handler registered for PLANNING
    const kb = await ticket('KB');
    const loop = loopWith([handler('KB', () => ({ kind: 'transition', to: 'PLANNING' }))]);
    expect(await loop.tick()).toBe('stepped');
    expect(ran).toEqual([`${kb.key}:KB`]);
    expect(await status(planning.id)).toBe('PLANNING');
    expect(await loop.tick()).toBe('idle');
  });

  it('ignores a project that is not confirmed yet: no ticket is picked and no mirror is cloned (BUILD_PLAN v1 6.7)', async () => {
    const draft = await prisma.project.create({ data: { name: `draft-${++n}`, repoUrl: 'https://x/y', stack: 'ts_node', testCmdTemplate: 'x {files}', localKeyPrefix: `D${n}`, mirrorStatus: 'pending', onboardingStatus: 'proposed' } });
    const t = await prisma.ticket.create({ data: { projectId: draft.id, key: `D${n}-1`, source: 'paste', title: 'x', status: 'KB' } });
    const loop = loopWith([handler('KB', () => ({ kind: 'continue' }))]);
    ran.length = 0;
    expect(await loop.pickNext()).toBeNull();
    await loop.tick();
    expect(ran).not.toContain(`${t.key}:KB`);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: draft.id } })).mirrorStatus).toBe('pending');
    await prisma.project.update({ where: { id: draft.id }, data: { onboardingStatus: 'confirmed' } });
    expect((await loop.pickNext())?.id).toBe(t.id);
    await prisma.ticket.delete({ where: { id: t.id } });
    await prisma.project.delete({ where: { id: draft.id } });
  });

  it('a running assistant chat does not block the pipeline, but a running stage does (BUILD_PLAN v1 D7)', async () => {
    const loop = loopWith([handler('KB', () => ({ kind: 'continue' }))]);
    await prisma.stageRun.deleteMany();
    const run = (stage: string) => prisma.stageRun.create({ data: { projectId, stage, model: 'm', status: 'running', startedAt: new Date() } });
    const chat = await run('assist');
    await ticket('KB');
    expect(await loop.tick()).not.toBe('blocked');
    const stage = await run('implement');
    expect(await loop.tick()).toBe('blocked');
    await prisma.stageRun.deleteMany({ where: { id: { in: [chat.id, stage.id] } } });
  });

  it('ends a pause caused by Claude\'s limit at the reset time, but never one the user chose', async () => {
    const loop = loopWith([]);
    await prisma.globalSettings.upsert({ where: { id: 'global' }, update: { pipelinePaused: true, pausedCode: 'CLAUDE_RATE_LIMIT', pausedReason: 'limit', resetsAt: new Date(clock + 60_000) }, create: { id: 'global', pipelinePaused: true, pausedCode: 'CLAUDE_RATE_LIMIT', pausedReason: 'limit', resetsAt: new Date(clock + 60_000) } });
    expect(await loop.tick()).toBe('paused'); // before the reset
    clock += 120_000;
    expect(await loop.tick()).not.toBe('paused');
    expect(await prisma.globalSettings.findUniqueOrThrow({ where: { id: 'global' } })).toMatchObject({ pipelinePaused: false, pausedCode: null, resetsAt: null });
    await prisma.globalSettings.update({ where: { id: 'global' }, data: { pipelinePaused: true, pausedCode: null, resetsAt: new Date(clock - 1000) } });
    expect(await loop.tick()).toBe('paused'); // a manual or threshold pause stays until someone resumes
    await prisma.globalSettings.update({ where: { id: 'global' }, data: { pipelinePaused: false } });
  });

  it('does not run a step while the pipeline is paused, but pausing never interrupts housekeeping', async () => {
    const t = await ticket('NEW');
    await prisma.globalSettings.create({ data: { id: 'global', pipelinePaused: true } });
    const loop = loopWith([handler('NEW', () => ({ kind: 'transition', to: 'KB' }))]);
    expect(await loop.tick()).toBe('paused');
    expect(ran).toEqual([]);
    expect(await status(t.id)).toBe('NEW');
    await prisma.globalSettings.update({ where: { id: 'global' }, data: { pipelinePaused: false } });
    expect(await loop.tick()).toBe('stepped');
  });

  it('never runs two steps at once: a second iteration while one is running does nothing', async () => {
    const t = await ticket('NEW');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const loop = loopWith([handler('NEW', async () => {
      await gate;
      return { kind: 'transition', to: 'KB' };
    })]);
    const first = loop.tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(await loop.tick()).toBe('busy');
    release();
    expect(await first).toBe('stepped');
    expect(ran).toEqual([`${t.key}:NEW`]); // picked up once
    expect(await status(t.id)).toBe('KB');
  });

  it('does not start a step while a stage is already running system-wide', async () => {
    const t = await ticket('NEW');
    await prisma.stageRun.create({ data: { projectId, stage: 'plan', model: 'opus', status: 'running', startedAt: new Date() } });
    const loop = loopWith([handler('NEW', () => ({ kind: 'transition', to: 'KB' }))]);
    expect(await loop.tick()).toBe('blocked');
    expect(await status(t.id)).toBe('NEW');
  });

  it('a hold outcome puts the ticket on hold with its reason', async () => {
    const t = await ticket('PLANNING');
    await loopWith([handler('PLANNING', () => ({ kind: 'hold', reason: 'needs_help', note: 'failed twice' }))]).tick();
    expect(await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ status: 'ON_HOLD', holdReason: 'needs_help', holdFromStatus: 'PLANNING' });
  });

  it('an unexpected error in a step fails the ticket, and the loop carries on with the next one', async () => {
    const bad = await ticket('NEW');
    const good = await ticket('NEW');
    const loop = loopWith([handler('NEW', (t) => {
      if (t.key === bad.key) throw new Error('workspace could not be created');
      return { kind: 'transition', to: 'KB' };
    })]);
    expect(await loop.tick()).toBe('stepped');
    expect(await prisma.ticket.findUniqueOrThrow({ where: { id: bad.id } })).toMatchObject({ status: 'FAILED', holdFromStatus: 'NEW' });
    expect((await prisma.stateTransition.findMany({ where: { ticketId: bad.id } }))[0]?.reason).toBe('workspace could not be created');
    expect(await loop.tick()).toBe('stepped');
    expect(await status(good.id)).toBe('KB');
  });

  it('an invalid transition requested by a step cannot corrupt the ticket', async () => {
    const t = await ticket('NEW');
    const loop = loopWith([handler('NEW', () => ({ kind: 'transition', to: 'DONE' }))]); // not allowed by 6.6
    await loop.tick(); // the iteration logs the rejection and survives
    expect(await status(t.id)).toBe('NEW');
    expect(await prisma.stateTransition.count({ where: { ticketId: t.id } })).toBe(0);
  });

  it('a continue outcome counts as a step without changing the ticket, so the next iteration starts at once', async () => {
    const t = await ticket('IN_PROGRESS');
    expect(await loopWith([handler('IN_PROGRESS', () => ({ kind: 'continue' }))]).tick()).toBe('stepped');
    expect(await status(t.id)).toBe('IN_PROGRESS');
    expect(await prisma.stateTransition.count({ where: { ticketId: t.id } })).toBe(0);
  });

  it('a stay outcome waits instead of spinning', async () => {
    await ticket('NEW');
    expect(await loopWith([handler('NEW', () => ({ kind: 'stay' }))]).tick()).toBe('idle');
  });

  it('polls Jira only when due', async () => {
    const loop = loopWith([]);
    const project = await prisma.project.create({ data: { name: 'jira', repoUrl: 'https://x/y', stack: 'ts_node', testCmdTemplate: 'x {files}', localKeyPrefix: 'J', jiraMode: 'rest', jiraProjectKey: 'ABC', jiraJql: 'project = ABC', mirrorStatus: 'ok' } });
    await prisma.globalSettings.create({ data: { id: 'global', pollIntervalSec: 120 } });
    jira.jira.searches = [];
    await loop.tick();
    expect(jira.jira.searches).toHaveLength(1);
    clock += 60_000;
    await loop.tick();
    expect(jira.jira.searches).toHaveLength(1); // not due yet
    clock += 61_000;
    await loop.tick();
    expect(jira.jira.searches).toHaveLength(2);
    void project;
  });

  it('keeps polling for new tickets while the pipeline is paused, but not while intake is paused', async () => {
    await prisma.project.create({ data: { name: 'jira2', repoUrl: 'https://x/y', stack: 'ts_node', testCmdTemplate: 'x {files}', localKeyPrefix: 'J2', jiraMode: 'rest', jiraProjectKey: 'ABC', jiraJql: 'x', mirrorStatus: 'ok' } });
    jira.jira.tickets = [{ key: 'ABC-1', summary: 's', description: 'd', issuetype: 'Story', labels: [], priority: null }];
    await prisma.globalSettings.create({ data: { id: 'global', pipelinePaused: true } });
    const loop = loopWith([]);
    expect(await loop.tick()).toBe('paused');
    expect(await prisma.ticket.count({ where: { source: 'jira' } })).toBe(1);

    await prisma.ticket.deleteMany({ where: { source: 'jira' } });
    await prisma.globalSettings.update({ where: { id: 'global' }, data: { pipelinePaused: false, intakePaused: true } });
    clock += 200_000;
    await loop.tick();
    expect(await prisma.ticket.count({ where: { source: 'jira' } })).toBe(0);
    jira.jira.tickets = [];
  });

  it('the orchestrator hook may replace the default move of a step, and a step without it moves as before', async () => {
    const t = await ticket('REVIEW');
    const seen: string[] = [];
    const config = new WorkerConfig({ DATA_DIR: '/tmp/sdlc-loop', DATABASE_URL: db.url } as NodeJS.ProcessEnv);
    const orchestrator = {
      async review(tk: { key: string }, outcome: StepOutcome): Promise<StepOutcome> {
        seen.push(tk.key);
        return outcome.kind === 'transition' ? { ...outcome, to: 'AWAITING_CI' } : outcome;
      },
    };
    const loop = new WorkerLoop(prisma, new MirrorService(prisma, config, staticCredentials()), new IntakePoller(prisma, jira, () => clock), new ApprovalPoller(prisma, jira, states, new SubtasksService(prisma, jira)), states, [handler('REVIEW', () => ({ kind: 'transition', to: 'KB_UPDATE', reason: 'done' }))], () => clock, [], undefined, undefined, undefined, orchestrator);
    await loop.tick();
    expect(seen).toEqual([t.key]);
    expect(await status(t.id)).toBe('AWAITING_CI');
  });
});
