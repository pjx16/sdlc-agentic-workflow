import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Subtask, Ticket } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { type TestDatabase, createTestDatabase } from '../../testing/test-db';
import { InProgressHandler, type SubtaskSteps } from './in-progress.handler';
import type { StepOutcome } from './step-handler';

describe('IN_PROGRESS handler (subtask orchestration, BUILD_PLAN 6.6)', () => {
  let db: TestDatabase;
  let prisma: PrismaService;
  let projectId: string;
  let n = 0;
  const calls: string[] = [];
  let outcome: StepOutcome = { kind: 'continue' };
  let allDone: StepOutcome | void = undefined;

  const record = (name: string) => async (_t: Ticket, s: Subtask): Promise<StepOutcome> => {
    calls.push(`${name}:${s.seq}`);
    return outcome;
  };
  const steps: SubtaskSteps = { tests: record('tests'), verifyRed: record('red'), implement: record('implement'), verifyGreen: record('green'), fix: record('fix'), allDone: async () => allDone };
  const ticket = () => prisma.ticket.create({ data: { projectId, key: `K-${++n}`, source: 'paste', title: 't', status: 'IN_PROGRESS' } });
  const subtask = (ticketId: string, seq: number, status: string) => prisma.subtask.create({ data: { ticketId, seq, title: `s${seq}`, status: status as never } });
  const setSettings = (settings: object) => prisma.project.update({ where: { id: projectId }, data: { settings: settings as never } });
  const run = async (t: Ticket) => new InProgressHandler(prisma, steps).run(t);

  beforeAll(async () => {
    db = await createTestDatabase();
    process.env.DATABASE_URL = db.url;
    prisma = new PrismaService();
    await prisma.onModuleInit();
    projectId = (await prisma.project.create({ data: { name: 'p', repoUrl: 'https://x/y', stack: 'ts_node', testCmdTemplate: 'x {files}', localKeyPrefix: 'P', mirrorStatus: 'ok' } })).id;
  }, 180_000);
  afterAll(async () => {
    await prisma?.onModuleDestroy();
    await db?.drop();
  });
  beforeEach(async () => {
    calls.length = 0;
    outcome = { kind: 'continue' };
    allDone = undefined;
    await setSettings({});
  });

  it('runs the step for the first unfinished subtask only, in seq order', async () => {
    const t = await ticket();
    await subtask(t.id, 2, 'PENDING');
    await subtask(t.id, 1, 'DONE');
    await subtask(t.id, 3, 'PENDING');
    await run(t);
    expect(calls).toEqual(['tests:2']);
  });

  it('dispatches on the subtask state', async () => {
    for (const [status, expected] of [['PENDING', 'tests'], ['TESTS', 'tests'], ['VERIFY_RED', 'red'], ['IMPLEMENT', 'implement'], ['VERIFY_GREEN', 'green'], ['FIXING', 'fix']] as const) {
      calls.length = 0;
      const t = await ticket();
      await subtask(t.id, 1, status);
      await run(t);
      expect(calls, status).toEqual([`${expected}:1`]);
    }
  });

  it('with the tests stage off, a PENDING subtask goes straight to implement', async () => {
    await setSettings({ stages: { tests: { enabled: false } } });
    const t = await ticket();
    await subtask(t.id, 1, 'PENDING');
    await run(t);
    expect(calls).toEqual(['implement:1']);
  });

  it('passes the step outcome through (a hold stays a hold)', async () => {
    outcome = { kind: 'hold', reason: 'needs_help', note: 'verify-red invalid' };
    const t = await ticket();
    await subtask(t.id, 1, 'VERIFY_RED');
    expect(await run(t)).toEqual(outcome);
  });

  it('moves to REVIEW once every subtask is DONE, without running a step', async () => {
    const t = await ticket();
    await subtask(t.id, 1, 'DONE');
    await subtask(t.id, 2, 'DONE');
    expect(await run(t)).toEqual({ kind: 'transition', to: 'REVIEW', reason: 'Every subtask is done' });
    expect(calls).toEqual([]);
  });

  it('goes straight to KB_UPDATE when the review stage is off', async () => {
    await setSettings({ stages: { prReview: { enabled: false } } });
    const t = await ticket();
    await subtask(t.id, 1, 'DONE');
    expect(await run(t)).toMatchObject({ kind: 'transition', to: 'KB_UPDATE' });
  });

  it('lets the all-done hook intervene (for example to hold when the PR cannot be opened)', async () => {
    allDone = { kind: 'hold', reason: 'needs_help', note: 'no PR' };
    const t = await ticket();
    await subtask(t.id, 1, 'DONE');
    expect(await run(t)).toEqual(allDone);
    allDone = { kind: 'continue' };
    expect(await run(t)).toMatchObject({ kind: 'transition', to: 'REVIEW' });
  });

  it('holds a ticket that is in progress without any subtasks', async () => {
    expect(await run(await ticket())).toMatchObject({ kind: 'hold', reason: 'needs_help' });
  });
});
