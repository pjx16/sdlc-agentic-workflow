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

  describe('hold explanation and redo tests', () => {
    const held = async (over: Record<string, unknown> = {}) => {
      const tk = await ticket({ status: 'ON_HOLD', holdReason: 'needs_help', holdFromStatus: 'IN_PROGRESS', ...over });
      await t.prisma.stateTransition.create({ data: { ticketId: tk.id, fromStatus: 'IN_PROGRESS', toStatus: 'ON_HOLD', actor: 'system', reason: 'The fix stage failed twice: the test cannot pass' } });
      await t.prisma.stageRun.create({ data: { projectId, ticketId: tk.id, stage: 'fix', model: 'sonnet', attempt: 2, round: 1, status: 'failed', error: 'The stage reported it is blocked' } });
      return tk;
    };
    const subtask = (ticketId: string, over: Record<string, unknown> = {}) =>
      t.prisma.subtask.create({ data: { ticketId, seq: 1, title: 'Add the section', description: 'd', acceptanceCriteria: [], files: [], dependsOn: [], status: 'FIXING', fixRounds: 1, testCommit: 'abc123', testFiles: ['src/a.test.ts'], ...over } });

    it('GET /hold explains what happened: the reason, the failed run, the current subtask, and whether tests can be redone', async () => {
      const tk = await held();
      await subtask(tk.id);
      const res = await t.agent.get(`/tickets/${tk.id}/hold`).expect(200);
      expect(res.body).toMatchObject({
        status: 'ON_HOLD', holdReason: 'needs_help', holdFromStatus: 'IN_PROGRESS', note: 'The fix stage failed twice: the test cannot pass',
        failedRun: { stage: 'fix', attempt: 2, error: 'The stage reported it is blocked' }, subtask: { seq: 1, title: 'Add the section', status: 'FIXING', fixRounds: 1 }, canRedoTests: true,
      });
      await t.anonymous.get(`/tickets/${tk.id}/hold`).expect(401);
      await t.agent.get('/tickets/00000000-0000-0000-0000-000000000000/hold').expect(404);
    });

    it('GET /hold says tests cannot be redone when there is no subtask with tests, or the ticket is not held', async () => {
      const noSubtask = await held();
      expect((await t.agent.get(`/tickets/${noSubtask.id}/hold`).expect(200)).body).toMatchObject({ subtask: null, canRedoTests: false });
      const noTests = await held();
      await subtask(noTests.id, { testCommit: null, status: 'TESTS' });
      expect((await t.agent.get(`/tickets/${noTests.id}/hold`).expect(200)).body.canRedoTests).toBe(false);
      const running = await ticket();
      expect((await t.agent.get(`/tickets/${running.id}/hold`).expect(200)).body).toMatchObject({ note: null, failedRun: null, canRedoTests: false });
    });

    it('rerunning the tests of a subtask sends it back to the tests stage with the failure and the note, and resumes the ticket', async () => {
      const tk = await held();
      const s = await subtask(tk.id);
      const res = await t.agent.post(`/tickets/${tk.id}/subtasks/${s.seq}/rerun`).send({ part: 'tests', note: 'accept export const' }).expect(200);
      expect(res.body).toMatchObject({ status: 'IN_PROGRESS', holdReason: null });
      const row = await t.prisma.subtask.findUniqueOrThrow({ where: { id: s.id } });
      expect(row).toMatchObject({ status: 'TESTS', fixRounds: 0, redoTests: true, rerunPart: 'tests', testCommit: 'abc123' }); // the worker clears testCommit when it discards the work
      expect(row.retriedAt).not.toBeNull();
      expect(row.lastFailure).toContain('written again from scratch');
      expect(row.lastFailure).toContain('The fix stage failed twice: the test cannot pass');
      expect(row.lastFailure).toContain('Developer note: accept export const');
      expect(row.lastFailure).toContain('Do not require a particular code style');
      expect((await t.prisma.stateTransition.findMany({ where: { ticketId: tk.id } })).at(-1)).toMatchObject({ kind: 'resume', fromStatus: 'ON_HOLD' });
    });

    it('rerunning the implementation of a subtask goes back to the implement step and keeps the tests', async () => {
      const tk = await held();
      const s = await subtask(tk.id);
      await t.agent.post(`/tickets/${tk.id}/subtasks/${s.seq}/rerun`).send({ part: 'implementation' }).expect(200);
      expect(await t.prisma.subtask.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ status: 'IMPLEMENT', redoTests: false, rerunPart: 'implementation', testCommit: 'abc123' });
    });

    it('is refused (409) when the ticket is not held, the subtask is unknown or done, or has no tests; 400 for a bad part or note; 404 unknown', async () => {
      const noTests = await held();
      const s1 = await subtask(noTests.id, { testCommit: null, status: 'TESTS' });
      await t.agent.post(`/tickets/${noTests.id}/subtasks/${s1.seq}/rerun`).send({ part: 'tests' }).expect(409);
      await t.agent.post(`/tickets/${noTests.id}/subtasks/${s1.seq}/rerun`).send({ part: 'implementation' }).expect(409);
      const running = await ticket();
      await t.agent.post(`/tickets/${running.id}/subtasks/1/rerun`).send({ part: 'tests' }).expect(409);
      const ok = await held();
      const s2 = await subtask(ok.id);
      await t.agent.post(`/tickets/${ok.id}/subtasks/${s2.seq}/rerun`).send({ part: 'tests', note: 'x'.repeat(2001) }).expect(400);
      await t.agent.post(`/tickets/${ok.id}/subtasks/${s2.seq}/rerun`).send({ part: 'everything' }).expect(400);
      await t.agent.post(`/tickets/${ok.id}/subtasks/99/rerun`).send({ part: 'tests' }).expect(404);
      await t.prisma.subtask.update({ where: { id: s2.id }, data: { status: 'DONE' } });
      await t.agent.post(`/tickets/${ok.id}/subtasks/${s2.seq}/rerun`).send({ part: 'tests' }).expect(409);
      await t.anonymous.post(`/tickets/${ok.id}/subtasks/1/rerun`).send({ part: 'tests' }).expect(401);
      await t.agent.post(`/tickets/${ok.id}/redo-tests`).send({}).expect(404); // the old endpoint is gone
    });
  });
});
