import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type TestApp, createTestApp } from '../testing/test-app';
import { type TestDatabase, createTestDatabase } from '../testing/test-db';
import { TicketsModule } from './tickets.module';

describe('Plan gate API (F7, BUILD_PLAN 8)', () => {
  let db: TestDatabase;
  let t: TestApp;
  let projectId: string;
  let n = 0;

  const setProject = (data: Record<string, unknown>) => t.prisma.project.update({ where: { id: projectId }, data: data as never });
  const ticket = (over: Record<string, unknown> = {}) => t.prisma.ticket.create({ data: { projectId, key: `K-${++n}`, source: 'paste', title: 'title', body: 'body', status: 'AWAITING_PLAN_APPROVAL', planMarkdown: '# Plan v1', ...over } });
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
    await t.prisma.event.deleteMany();
    await t.prisma.stateTransition.deleteMany();
    await setProject({ jiraMode: 'off' });
    t.jira.jira.calls = [];
    t.jira.jira.failWith = null;
  });

  it('requires a session', async () => {
    await t.anonymous.post('/tickets/x/plan/approve').send({}).expect(401);
    await t.anonymous.post('/tickets/x/plan/reject').send({ note: 'n' }).expect(401);
  });

  describe('approve', () => {
    it('approves the plan as it is: BREAKDOWN, recorded as a user action', async () => {
      const tk = await ticket();
      const res = await t.agent.post(`/tickets/${tk.id}/plan/approve`).send({}).expect(200);
      expect(res.body).toMatchObject({ id: tk.id, status: 'BREAKDOWN' });
      const row = await reload(tk.id);
      expect(row.planMarkdown).toBe('# Plan v1');
      expect(await t.prisma.stateTransition.findMany({ where: { ticketId: tk.id } })).toMatchObject([{ fromStatus: 'AWAITING_PLAN_APPROVAL', toStatus: 'BREAKDOWN', actor: 'user', reason: 'Plan approved' }]);
    });

    it('stores an edited plan before approving, and says so in the history', async () => {
      const tk = await ticket();
      await t.agent.post(`/tickets/${tk.id}/plan/approve`).send({ planMarkdown: '# Plan v2 (edited)' }).expect(200);
      expect((await reload(tk.id)).planMarkdown).toBe('# Plan v2 (edited)');
      expect((await t.prisma.stateTransition.findMany({ where: { ticketId: tk.id } }))[0]?.reason).toBe('Plan approved with edits');
    });

    it('an unchanged plan text is not recorded as an edit', async () => {
      const tk = await ticket();
      await t.agent.post(`/tickets/${tk.id}/plan/approve`).send({ planMarkdown: '# Plan v1' }).expect(200);
      expect((await t.prisma.stateTransition.findMany({ where: { ticketId: tk.id } }))[0]?.reason).toBe('Plan approved');
    });

    it('rejects an empty edited plan without changing anything', async () => {
      const tk = await ticket();
      const res = await t.agent.post(`/tickets/${tk.id}/plan/approve`).send({ planMarkdown: '   ' }).expect(400);
      expect(res.body.fields.planMarkdown).toBe('must not be empty');
      expect((await reload(tk.id)).status).toBe('AWAITING_PLAN_APPROVAL');
    });

    it('re-reads the Jira issue in REST mode, so edits made in Jira reach the breakdown', async () => {
      await setProject({ jiraMode: 'rest' });
      const tk = await ticket({ source: 'jira', externalKey: 'ABC-7', key: 'ABC-7', title: 'old', body: 'old body' });
      t.jira.jira.readStatus = async (key: string) => ({ key, status: 'To Do', summary: 'Retitled in Jira', description: 'Rewritten in Jira' });
      await t.agent.post(`/tickets/${tk.id}/plan/approve`).send({}).expect(200);
      expect(await reload(tk.id)).toMatchObject({ status: 'BREAKDOWN', title: 'Retitled in Jira', body: 'Rewritten in Jira' });
    });

    it('does not re-read Jira for pasted tickets or other Jira modes', async () => {
      await t.agent.post(`/tickets/${(await ticket()).id}/plan/approve`).send({}).expect(200);
      await setProject({ jiraMode: 'mcp' });
      await t.agent.post(`/tickets/${(await ticket({ source: 'jira', externalKey: 'ABC-8' })).id}/plan/approve`).send({}).expect(200);
      expect(t.jira.jira.calls.filter((c) => c.startsWith('read'))).toEqual([]);
    });

    it('a Jira problem is recorded but never blocks the approval', async () => {
      await setProject({ jiraMode: 'rest' });
      t.jira.jira.readStatus = async () => {
        throw new Error('Jira 503');
      };
      const tk = await ticket({ source: 'jira', externalKey: 'ABC-9', key: 'ABC-9' });
      await t.agent.post(`/tickets/${tk.id}/plan/approve`).send({}).expect(200);
      expect((await reload(tk.id)).status).toBe('BREAKDOWN');
      expect((await t.prisma.event.findMany({ where: { ticketId: tk.id, type: 'jira' } }))[0]?.message).toContain('could not re-read the Jira issue');
    });

    it('returns 409 unless the ticket is awaiting plan approval, and 404 for an unknown ticket', async () => {
      for (const status of ['NEW', 'PLANNING', 'BREAKDOWN', 'ON_HOLD', 'DONE']) {
        const res = await t.agent.post(`/tickets/${(await ticket({ status })).id}/plan/approve`).send({}).expect(409);
        expect(res.body.error).toBe('conflict');
        expect(res.body.message).toContain(status);
      }
      await t.agent.post('/tickets/nope/plan/approve').send({}).expect(404);
    });

    it('cannot be approved twice', async () => {
      const tk = await ticket();
      await t.agent.post(`/tickets/${tk.id}/plan/approve`).send({}).expect(200);
      await t.agent.post(`/tickets/${tk.id}/plan/approve`).send({}).expect(409);
    });
  });

  describe('reject', () => {
    it('sends the ticket back to PLANNING with the note as the reason, keeping the previous plan', async () => {
      const tk = await ticket();
      const res = await t.agent.post(`/tickets/${tk.id}/plan/reject`).send({ note: '  Reuse the existing queue  ' }).expect(200);
      expect(res.body).toMatchObject({ status: 'PLANNING' });
      expect((await reload(tk.id)).planMarkdown).toBe('# Plan v1');
      expect(await t.prisma.stateTransition.findMany({ where: { ticketId: tk.id } })).toMatchObject([{ fromStatus: 'AWAITING_PLAN_APPROVAL', toStatus: 'PLANNING', actor: 'user', reason: 'Reuse the existing queue' }]);
    });

    it('needs a note', async () => {
      const tk = await ticket();
      for (const body of [{}, { note: '' }, { note: '   ' }]) expect((await t.agent.post(`/tickets/${tk.id}/plan/reject`).send(body).expect(400)).body.fields.note).toBeTruthy();
      expect((await reload(tk.id)).status).toBe('AWAITING_PLAN_APPROVAL');
    });

    it('returns 409 unless awaiting plan approval, and 404 for an unknown ticket', async () => {
      expect((await t.agent.post(`/tickets/${(await ticket({ status: 'PLANNING' })).id}/plan/reject`).send({ note: 'n' }).expect(409)).body.error).toBe('conflict');
      await t.agent.post('/tickets/nope/plan/reject').send({ note: 'n' }).expect(404);
    });

    it('a rejected plan can be approved again after re-planning', async () => {
      const tk = await ticket();
      await t.agent.post(`/tickets/${tk.id}/plan/reject`).send({ note: 'again' }).expect(200);
      await t.prisma.ticket.update({ where: { id: tk.id }, data: { status: 'AWAITING_PLAN_APPROVAL', planMarkdown: '# Plan v2' } }); // what the plan stage would do
      await t.agent.post(`/tickets/${tk.id}/plan/approve`).send({}).expect(200);
      expect((await reload(tk.id)).status).toBe('BREAKDOWN');
    });
  });
});
