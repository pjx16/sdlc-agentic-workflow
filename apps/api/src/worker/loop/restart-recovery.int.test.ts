import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../../prisma/prisma.service';
import { StateMachine } from '../../state/state-machine.service';
import { FakeEngine } from '../agent-runner/fake-engine';
import { type TestDatabase, createTestDatabase } from '../../testing/test-db';
import { RestartRecovery } from './restart-recovery';

describe('restart recovery (F4, BUILD_PLAN 6.8)', () => {
  let db: TestDatabase;
  let prisma: PrismaService;
  let recovery: RestartRecovery;
  let engine: FakeEngine;
  let projectId: string;
  let n = 0;

  const ticket = (status = 'PLANNING') => prisma.ticket.create({ data: { projectId, key: `T-${++n}`, source: 'paste', title: 't', status: status as never } });
  const run = (ticketId: string | null, over: Record<string, unknown> = {}) =>
    prisma.stageRun.create({ data: { projectId, ticketId, stage: 'plan', model: 'opus', status: 'running', startedAt: new Date(), ...over } });

  beforeAll(async () => {
    db = await createTestDatabase();
    process.env.DATABASE_URL = db.url;
    prisma = new PrismaService();
    await prisma.onModuleInit();
    engine = new FakeEngine();
    recovery = new RestartRecovery(prisma, new StateMachine(prisma), engine);
    projectId = (await prisma.project.create({ data: { name: 'p', repoUrl: 'https://x/y', stack: 'ts_node', testCmdTemplate: 'x {files}', localKeyPrefix: 'P' } })).id;
  }, 180_000);
  afterAll(async () => {
    await prisma?.onModuleDestroy();
    await db?.drop();
  });
  beforeEach(async () => {
    engine.removedLabels.length = 0;
    engine.removeResult = 2;
    await prisma.event.deleteMany();
    await prisma.stateTransition.deleteMany();
    await prisma.stageRun.deleteMany();
    await prisma.ticket.deleteMany();
  });

  it('marks running StageRuns as failed (worker_restart) and removes leftover agent containers', async () => {
    const t = await ticket();
    const r = await run(t.id);
    const res = await recovery.recover();
    expect(res).toEqual({ interrupted: 1, containersRemoved: 2, held: 0 });
    expect(engine.removedLabels).toEqual(['sdlc.agent=true']);
    expect(await prisma.stageRun.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ status: 'failed', error: 'worker_restart' });
    expect((await prisma.stageRun.findUniqueOrThrow({ where: { id: r.id } })).endedAt).not.toBeNull();
  });

  it('leaves the ticket where it was, so its stage runs again from attempt 1 (not counted as an attempt)', async () => {
    const t = await ticket('PLANNING');
    await run(t.id, { attempt: 1 });
    await recovery.recover();
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('PLANNING');
    expect((await prisma.event.findMany({ where: { ticketId: t.id } }))[0]?.message).toContain('will run again');
  });

  it('puts the ticket on hold when the same stage is interrupted by a restart a second time', async () => {
    const t = await ticket('PLANNING');
    await run(t.id, { status: 'failed', error: 'worker_restart', endedAt: new Date() }); // the first interruption
    await run(t.id); // interrupted again
    const res = await recovery.recover();
    expect(res.held).toBe(1);
    expect(await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ status: 'ON_HOLD', holdReason: 'needs_help', holdFromStatus: 'PLANNING' });
  });

  it('does not touch finished, failed or queued runs, and handles project-level runs without a ticket', async () => {
    const t = await ticket();
    const done = await run(t.id, { status: 'succeeded', endedAt: new Date() });
    const queued = await run(t.id, { status: 'queued', startedAt: null });
    const intake = await run(null, { stage: 'jiraIntake' });
    const res = await recovery.recover();
    expect(res.interrupted).toBe(1);
    expect((await prisma.stageRun.findUniqueOrThrow({ where: { id: done.id } })).status).toBe('succeeded');
    expect((await prisma.stageRun.findUniqueOrThrow({ where: { id: queued.id } })).status).toBe('queued');
    expect(await prisma.stageRun.findUniqueOrThrow({ where: { id: intake.id } })).toMatchObject({ status: 'failed', error: 'worker_restart' });
  });

  it('does nothing when there is nothing to recover, and survives a container-engine failure', async () => {
    engine.removeResult = 0;
    expect(await recovery.recover()).toMatchObject({ interrupted: 0, held: 0 });
    engine.removeResult = new Error('docker is down');
    const t = await ticket();
    await run(t.id);
    expect(await recovery.recover()).toMatchObject({ interrupted: 1, containersRemoved: 0 });
  });
});
