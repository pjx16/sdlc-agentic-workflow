import 'reflect-metadata';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { StageEnvelope } from '@sdlc/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../../prisma/prisma.service';
import { FakeJira, FakeJiraClients } from '../../testing/fake-jira';
import { type TestDatabase, createTestDatabase } from '../../testing/test-db';
import type { StageRequest, StageResult } from '../agent-runner/agent-runner';
import { WorkerConfig } from '../worker-config';
import { composePlan, PlanHandler } from './plan.handler';
import { StageLauncher } from './stage-launcher';
import { StageOutcomes } from './stage-outcomes';

const planAnswer = (over: object = {}): StageEnvelope => ({ status: 'done', summary: 'plan', data: { planMarkdown: '## Goal\nExport CSV', risks: ['Large exports may time out'], openQuestions: ['Which delimiter?'], ...over } as never });

describe('plan stage (F7)', () => {
  let db: TestDatabase;
  let prisma: PrismaService;
  let tmp: string;
  let jira: FakeJira;
  let handler: PlanHandler;
  let projectId: string;
  let n = 0;
  let requests: StageRequest[] = [];
  let answer: StageEnvelope;
  let failWith: StageResult | null = null;

  const setProject = (data: Record<string, unknown>) => prisma.project.update({ where: { id: projectId }, data: data as never });
  const ticket = (over: Record<string, unknown> = {}) => prisma.ticket.create({ data: { projectId, key: `ABC-${++n}`, source: 'paste', title: 'Export bookings', body: 'Please add a CSV export.', status: 'PLANNING', ...over } });

  beforeAll(async () => {
    db = await createTestDatabase();
    process.env.DATABASE_URL = db.url;
    prisma = new PrismaService();
    await prisma.onModuleInit();
    tmp = mkdtempSync(path.join(tmpdir(), 'sdlc-plan-'));
    const config = new WorkerConfig({ DATA_DIR: path.join(tmp, 'data'), DATABASE_URL: db.url } as NodeJS.ProcessEnv);
    projectId = (await prisma.project.create({ data: { name: 'p', repoUrl: 'https://x/y', stack: 'nestjs', testCmdTemplate: 'x {files}', localKeyPrefix: 'P', mirrorStatus: 'ok' } })).id;
    const runner = {
      async run(req: StageRequest): Promise<StageResult> {
        requests.push(req);
        return failWith ?? { kind: 'done', envelope: answer, stageRunId: 'run-plan', attempts: 1 };
      },
    };
    const clients = new FakeJiraClients();
    jira = clients.jira;
    handler = new PlanHandler(prisma, new StageLauncher(prisma, config, runner as never), new StageOutcomes(prisma), clients);
  }, 180_000);
  afterAll(async () => {
    await prisma?.onModuleDestroy();
    await db?.drop();
    rmSync(tmp, { recursive: true, force: true });
  });
  beforeEach(async () => {
    requests = [];
    failWith = null;
    answer = planAnswer();
    jira.calls = [];
    jira.failWith = null;
    await prisma.event.deleteMany();
    await prisma.stateTransition.deleteMany();
    await setProject({ jiraMode: 'off', settings: {} });
  });

  it('composes the plan with its risks and open questions', () => {
    expect(composePlan({ planMarkdown: '# P\n', risks: ['r1', 'r2'], openQuestions: ['q1'] })).toBe('# P\n\n## Risks\n\n- r1\n- r2\n\n## Open questions\n\n- q1');
    expect(composePlan({ planMarkdown: 'just the plan', risks: [], openQuestions: [] })).toBe('just the plan');
  });

  it('runs the plan stage, saves the plan on the ticket, and stops at the gate', async () => {
    const t = await ticket();
    const out = await handler.run(t);
    expect(out).toEqual({ kind: 'transition', to: 'AWAITING_PLAN_APPROVAL', reason: 'Plan ready for approval', stageRunId: 'run-plan' });
    expect(requests[0]).toMatchObject({ stage: 'plan', modelAlias: 'opus', maxTurns: 15, stack: 'nestjs', claudeMdMode: 'both' });
    expect(requests[0]?.inputs.ticket).toEqual({ key: t.key, title: 'Export bookings', body: 'Please add a CSV export.' });
    expect(requests[0]?.inputs.previousPlan).toBeUndefined();
    const saved = (await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).planMarkdown;
    expect(saved).toBe('## Goal\nExport CSV\n\n## Risks\n\n- Large exports may time out\n\n## Open questions\n\n- Which delimiter?');
  });

  it('goes straight to breakdown when the plan gate is off', async () => {
    await setProject({ settings: { gates: { plan: false } } });
    expect(await handler.run(await ticket())).toMatchObject({ kind: 'transition', to: 'BREAKDOWN', reason: 'Plan stored; the plan gate is off' });
  });

  it('with the plan stage off, the ticket body becomes the plan and no stage runs', async () => {
    await setProject({ settings: { stages: { plan: { enabled: false } } } });
    const t = await ticket();
    expect(await handler.run(t)).toMatchObject({ kind: 'transition', to: 'BREAKDOWN' });
    expect(requests).toHaveLength(0);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).planMarkdown).toBe('Please add a CSV export.');
  });

  it('passes the KB doc to the stage when the ticket has a matching feature', async () => {
    const t = await ticket({ featureKey: 'bookings' });
    const ws = path.join(tmp, 'data', 'workspaces', projectId, t.key);
    mkdirSync(path.join(ws, 'docs/kb'), { recursive: true });
    writeFileSync(path.join(ws, 'docs/kb/features.json'), JSON.stringify({ version: 1, features: [{ key: 'bookings', doc: 'bookings.md' }] }));
    writeFileSync(path.join(ws, 'docs/kb/bookings.md'), '# Bookings KB');
    await handler.run(t);
    expect(requests[0]?.inputs.kbDoc).toBe('# Bookings KB');
    await handler.run(await ticket({ featureKey: 'unknown' }));
    expect(requests[1]?.inputs.kbDoc).toBeUndefined(); // planned without a KB doc
  });

  describe('rejection re-run', () => {
    it('gives the stage the previous plan and the note after a rejection at the gate', async () => {
      const t = await ticket({ planMarkdown: '# First plan' });
      await prisma.stateTransition.create({ data: { ticketId: t.id, fromStatus: 'AWAITING_PLAN_APPROVAL', toStatus: 'PLANNING', actor: 'user', reason: 'Reuse the existing job queue' } });
      await handler.run(t);
      expect(requests[0]?.inputs).toMatchObject({ previousPlan: '# First plan', rejectionNote: 'Reuse the existing job queue' });
    });

    it('does not treat a resume from hold, or a first run, as a rejection', async () => {
      const t = await ticket({ planMarkdown: '# Plan' });
      await prisma.stateTransition.create({ data: { ticketId: t.id, fromStatus: 'ON_HOLD', toStatus: 'PLANNING', actor: 'user', reason: 'resumed' } });
      await handler.run(t);
      expect(requests[0]?.inputs.rejectionNote).toBeUndefined();
      await handler.run(await ticket());
      expect(requests[1]?.inputs.previousPlan).toBeUndefined();
    });

    it('only the latest move into PLANNING counts', async () => {
      const t = await ticket({ planMarkdown: '# Plan' });
      await prisma.stateTransition.create({ data: { ticketId: t.id, fromStatus: 'AWAITING_PLAN_APPROVAL', toStatus: 'PLANNING', actor: 'user', reason: 'old note', at: new Date('2026-01-01') } });
      await prisma.stateTransition.create({ data: { ticketId: t.id, fromStatus: 'ON_HOLD', toStatus: 'PLANNING', actor: 'user', reason: 'resumed', at: new Date('2026-01-02') } });
      await handler.run(t);
      expect(requests[0]?.inputs.rejectionNote).toBeUndefined();
    });
  });

  describe('Jira comment', () => {
    const jiraTicket = () => ticket({ source: 'jira', externalKey: `JIRA-${n + 1}` });

    it('posts the plan as a comment when write-back is on (REST mode)', async () => {
      await setProject({ jiraMode: 'rest' });
      const t = await jiraTicket();
      await handler.run(t);
      expect(jira.calls).toEqual([`comment ${t.externalKey}`]);
    });

    it('does not post when comments are off, the ticket was pasted, or Jira is off for the project', async () => {
      await setProject({ jiraMode: 'rest', settings: { jiraWriteBack: { comments: false } } });
      await handler.run(await jiraTicket());
      await setProject({ jiraMode: 'rest', settings: {} });
      await handler.run(await ticket());
      await setProject({ jiraMode: 'off' });
      await handler.run(await jiraTicket());
      expect(jira.calls).toEqual([]);
    });

    it('a failed comment is recorded as a warning and never blocks the plan', async () => {
      await setProject({ jiraMode: 'rest' });
      jira.failWith = new Error('Jira 403: no permission');
      const t = await jiraTicket();
      expect(await handler.run(t)).toMatchObject({ kind: 'transition', to: 'AWAITING_PLAN_APPROVAL' });
      expect((await prisma.event.findMany({ where: { ticketId: t.id, type: 'jira' } }))[0]?.message).toContain('Could not post the plan to Jira: Jira 403');
    });
  });

  it('turns a failed stage into a hold, and a question into a support query', async () => {
    failWith = { kind: 'failed', reason: 'invalid output', stageRunId: 'r', attempts: 2 };
    expect(await handler.run(await ticket())).toMatchObject({ kind: 'hold', reason: 'needs_help' });
    const t = await ticket();
    const asked = await prisma.stageRun.create({ data: { projectId, ticketId: t.id, stage: 'plan', model: 'opus', status: 'needs_input' } });
    failWith = { kind: 'needs_input', question: 'Which delimiter?', stageRunId: asked.id, attempts: 1 };
    expect(await handler.run(t)).toMatchObject({ kind: 'hold', reason: 'awaiting_answer' });
    expect(await prisma.supportQuery.count({ where: { ticketId: t.id } })).toBe(1);
  });
});
