import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type TestApp, createTestApp } from '../testing/test-app';
import { type TestDatabase, createTestDatabase } from '../testing/test-db';
import { TicketsModule } from './tickets.module';

describe('Hold, resume and retry (3.7, BUILD_PLAN 6.6 rows 16-18, 6.8)', () => {
  let db: TestDatabase;
  let t: TestApp;
  let projectId: string;
  let n = 0;

  const ticket = (over: Record<string, unknown> = {}) => t.prisma.ticket.create({ data: { projectId, key: `K-${++n}`, source: 'paste', title: 'title', status: 'IN_PROGRESS', ...over } });
  const reload = (id: string) => t.prisma.ticket.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    db = await createTestDatabase();
    t = await createTestApp(db.url, [TicketsModule]);
    projectId = (await t.prisma.project.create({ data: { name: 'p', repoUrl: 'https://x/y', stack: 'ts_node', testCmdTemplate: 'x {files}', localKeyPrefix: 'P', mirrorStatus: 'ok' } })).id;
  }, 180_000);
  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });
  beforeEach(async () => {
    await t.prisma.project.update({ where: { id: projectId }, data: { jiraMode: 'off' } });
  });

  it('requires a session', async () => {
    for (const a of ['hold', 'resume', 'retry']) await t.anonymous.post(`/tickets/x/${a}`).expect(401);
  });

  describe('hold', () => {
    it('puts a running ticket on hold (manual), remembering where it was', async () => {
      const tk = await ticket();
      const res = await t.agent.post(`/tickets/${tk.id}/hold`).expect(200);
      expect(res.body).toMatchObject({ status: 'ON_HOLD', holdReason: 'manual', holdFromStatus: 'IN_PROGRESS' });
      expect((await t.prisma.stateTransition.findMany({ where: { ticketId: tk.id } }))[0]).toMatchObject({ actor: 'user', toStatus: 'ON_HOLD' });
    });
    it.each(['DONE', 'FAILED', 'ON_HOLD'])('409 for a %s ticket', async (status) => {
      const tk = await ticket({ status, holdFromStatus: status === 'IN_PROGRESS' ? null : 'IN_PROGRESS' });
      await t.agent.post(`/tickets/${tk.id}/hold`).expect(409);
    });
    it('404 for an unknown ticket', async () => {
      await t.agent.post('/tickets/00000000-0000-0000-0000-000000000000/hold').expect(404);
    });
  });

  describe('resume', () => {
    it('returns a held ticket to the state it was held from', async () => {
      const tk = await ticket({ status: 'ON_HOLD', holdReason: 'manual', holdFromStatus: 'REVIEW' });
      const res = await t.agent.post(`/tickets/${tk.id}/resume`).expect(200);
      expect(res.body).toMatchObject({ status: 'REVIEW', holdReason: null, holdFromStatus: null });
    });
    it('409 when the ticket is not held or failed', async () => {
      const tk = await ticket();
      await t.agent.post(`/tickets/${tk.id}/resume`).expect(409);
      await t.agent.post(`/tickets/${tk.id}/retry`).expect(409);
    });
  });

  describe('retry', () => {
    it.each(['awaiting_answer', 'needs_help', 'manual', 'pr_closed'])('recovers a ticket held for %s', async (reason) => {
      const tk = await ticket({ status: 'ON_HOLD', holdReason: reason, holdFromStatus: 'IN_PROGRESS' });
      const res = await t.agent.post(`/tickets/${tk.id}/retry`).expect(200);
      expect(res.body).toMatchObject({ status: 'IN_PROGRESS', holdReason: null });
    });

    it('recovers a FAILED ticket to the state it failed in', async () => {
      const tk = await ticket({ status: 'FAILED', holdFromStatus: 'KB' });
      expect((await t.agent.post(`/tickets/${tk.id}/retry`).expect(200)).body.status).toBe('KB');
    });

    it('resets the counters of the work in progress, but not finished subtasks', async () => {
      const tk = await ticket({ status: 'ON_HOLD', holdReason: 'needs_help', holdFromStatus: 'IN_PROGRESS', ciFixDone: true, ciWaitStartedAt: new Date() });
      const mk = (seq: number, status: string) => t.prisma.subtask.create({ data: { ticketId: tk.id, seq, title: `s${seq}`, status: status as never, fixRounds: 2, lastFailure: 'boom' } });
      const done = await mk(1, 'DONE');
      const active = await mk(2, 'VERIFY_GREEN');
      await t.agent.post(`/tickets/${tk.id}/retry`).expect(200);
      expect(await t.prisma.subtask.findUniqueOrThrow({ where: { id: active.id } })).toMatchObject({ fixRounds: 0, lastFailure: null, status: 'VERIFY_GREEN' });
      expect((await t.prisma.subtask.findUniqueOrThrow({ where: { id: active.id } })).retriedAt).not.toBeNull();
      expect(await t.prisma.subtask.findUniqueOrThrow({ where: { id: done.id } })).toMatchObject({ fixRounds: 2, lastFailure: 'boom', retriedAt: null });
      expect(await reload(tk.id)).toMatchObject({ ciFixDone: false, ciFixPending: false, ciWaitStartedAt: null });
    });
  });
});
