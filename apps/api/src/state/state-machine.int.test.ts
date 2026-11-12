import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { type TestDatabase, createTestDatabase } from '../testing/test-db';
import { InvalidTransitionError, StateMachine, type TransitionListener, type TransitionResult } from './state-machine.service';

describe('StateMachine against a real database (F15)', () => {
  let db: TestDatabase;
  let prisma: PrismaService;
  let sm: StateMachine;
  let projectId: string;
  let n = 0;
  const seen: TransitionResult[] = [];
  let listenerShouldFail = false;
  const listener: TransitionListener = {
    async onTransition(r) {
      seen.push(r);
      if (listenerShouldFail) throw new Error('jira is down');
    },
  };

  const ticket = (status = 'NEW') => prisma.ticket.create({ data: { projectId, key: `T-${++n}`, source: 'paste', title: 't', status: status as never } });

  beforeAll(async () => {
    db = await createTestDatabase();
    process.env.DATABASE_URL = db.url;
    prisma = new PrismaService();
    await prisma.onModuleInit();
    sm = new StateMachine(prisma, [listener]);
    projectId = (await prisma.project.create({ data: { name: 'p', repoUrl: 'https://x/y', stack: 'ts_node', testCmdTemplate: 'x {files}', localKeyPrefix: 'P' } })).id;
  }, 180_000);
  afterAll(async () => {
    await prisma?.onModuleDestroy();
    await db?.drop();
  });
  beforeEach(() => {
    seen.length = 0;
    listenerShouldFail = false;
  });

  it('applies an allowed transition and records it, with actor, reason and stage run', async () => {
    const t = await ticket();
    const { ticket: updated, transition } = await sm.transition(t.id, 'KB', 'system', 'picked up', undefined);
    expect(updated.status).toBe('KB');
    expect(transition).toMatchObject({ ticketId: t.id, fromStatus: 'NEW', toStatus: 'KB', actor: 'system', reason: 'picked up', jiraSyncResult: 'none' });
    const rows = await prisma.stateTransition.findMany({ where: { ticketId: t.id } });
    expect(rows).toHaveLength(1);
    expect((await prisma.event.findMany({ where: { ticketId: t.id } }))[0]?.message).toBe(`${t.key}: NEW -> KB (picked up)`);
  });

  it('walks the whole happy path, recording every step in order', async () => {
    const t = await ticket();
    const path = ['KB', 'PLANNING', 'AWAITING_PLAN_APPROVAL', 'BREAKDOWN', 'AWAITING_BREAKDOWN_APPROVAL', 'IN_PROGRESS', 'REVIEW', 'KB_UPDATE', 'AWAITING_CI', 'IN_HUMAN_REVIEW', 'DONE'] as const;
    for (const to of path) await sm.transition(t.id, to, 'system');
    const rows = await prisma.stateTransition.findMany({ where: { ticketId: t.id }, orderBy: { at: 'asc' } });
    expect(rows.map((r) => r.toStatus)).toEqual([...path]);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('DONE');
  });

  it('rejects an invalid transition without changing the ticket or writing a row', async () => {
    const t = await ticket();
    await expect(sm.transition(t.id, 'DONE', 'user')).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(sm.transition(t.id, 'DONE', 'user')).rejects.toMatchObject({ status: 409, code: 'invalid_transition', from: 'NEW', to: 'DONE' });
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('NEW');
    expect(await prisma.stateTransition.count({ where: { ticketId: t.id } })).toBe(0);
    expect(seen).toHaveLength(0);
  });

  it('returns 404 for an unknown ticket', async () => {
    await expect(sm.transition('nope', 'KB', 'system')).rejects.toMatchObject({ status: 404 });
  });

  it('holds from any state, remembers where it came from, and resumes there', async () => {
    const t = await ticket('PLANNING');
    const held = await sm.hold(t.id, 'needs_help', 'system', 'planning failed twice');
    expect(held.ticket).toMatchObject({ status: 'ON_HOLD', holdReason: 'needs_help', holdFromStatus: 'PLANNING' });
    const resumed = await sm.resume(t.id, 'user');
    expect(resumed.ticket).toMatchObject({ status: 'PLANNING', holdReason: null, holdFromStatus: null });
    expect((await prisma.stateTransition.findMany({ where: { ticketId: t.id }, orderBy: { at: 'asc' } })).map((r) => `${r.fromStatus}>${r.toStatus}`)).toEqual(['PLANNING>ON_HOLD', 'ON_HOLD>PLANNING']);
  });

  it('requires a hold reason, and a held ticket cannot move anywhere but back', async () => {
    const t = await ticket('REVIEW');
    await expect(sm.transition(t.id, 'ON_HOLD', 'user')).rejects.toMatchObject({ status: 400, fields: { holdReason: 'required' } });
    await sm.hold(t.id, 'manual', 'user');
    await expect(sm.transition(t.id, 'KB_UPDATE', 'user')).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(sm.hold(t.id, 'manual', 'user')).rejects.toBeInstanceOf(InvalidTransitionError); // already on hold
  });

  it('cannot hold a DONE or FAILED ticket', async () => {
    await expect(sm.hold((await ticket('DONE')).id, 'manual', 'user')).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(sm.hold((await ticket('FAILED')).id, 'manual', 'user')).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it('fails from any state but DONE, and retry returns to the state it failed in', async () => {
    const t = await ticket('IN_PROGRESS');
    const failed = await sm.fail(t.id, 'workspace could not be created');
    expect(failed.ticket).toMatchObject({ status: 'FAILED', holdFromStatus: 'IN_PROGRESS' });
    expect((await sm.resume(t.id, 'user', 'retry')).ticket).toMatchObject({ status: 'IN_PROGRESS', holdFromStatus: null });
    await expect(sm.fail((await ticket('DONE')).id, 'x')).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it('can fail a ticket that is on hold, and retry then returns to the state before the hold', async () => {
    const t = await ticket('BREAKDOWN');
    await sm.hold(t.id, 'awaiting_answer', 'system');
    await sm.fail(t.id, 'gave up');
    // The failure keeps the state the ticket was held from, so a retry returns there, not to ON_HOLD.
    const retried = await sm.resume(t.id, 'user');
    expect(retried.ticket).toMatchObject({ status: 'BREAKDOWN', holdFromStatus: null, holdReason: null });
  });

  it('refuses to resume a ticket that is neither on hold nor failed', async () => {
    await expect(sm.resume((await ticket('KB')).id, 'user')).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it('lets only one of two concurrent changes win (optimistic lock)', async () => {
    const t = await ticket('AWAITING_PLAN_APPROVAL');
    const results = await Promise.allSettled([sm.transition(t.id, 'BREAKDOWN', 'user'), sm.transition(t.id, 'PLANNING', 'user')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.stateTransition.count({ where: { ticketId: t.id } })).toBe(1);
  });

  it('notifies listeners after commit, and a failing listener never blocks or undoes the transition', async () => {
    const t = await ticket();
    listenerShouldFail = true;
    const res = await sm.transition(t.id, 'KB', 'system');
    expect(res.ticket.status).toBe('KB');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.transition.toStatus).toBe('KB');
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('KB');
  });
});
