import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type TestApp, createTestApp } from '../testing/test-app';
import { type TestDatabase, createTestDatabase } from '../testing/test-db';
import { TicketsModule } from './tickets.module';

const st = (seq: number, over: Record<string, unknown> = {}) => ({ seq, title: `Subtask ${seq}`, description: `do ${seq}`, acceptanceCriteria: [`criterion ${seq}`], files: [`src/f${seq}.ts`], dependsOn: [] as number[], ...over });
const draft = [st(1), st(2, { dependsOn: [1] }), st(3, { dependsOn: [1, 2] })];

describe('Breakdown gate API (F8, BUILD_PLAN 8)', () => {
  let db: TestDatabase;
  let t: TestApp;
  let projectId: string;
  let n = 0;

  const ticket = (over: Record<string, unknown> = {}) => t.prisma.ticket.create({ data: { projectId, key: `K-${++n}`, source: 'paste', title: 't', status: 'AWAITING_BREAKDOWN_APPROVAL', planMarkdown: '# plan', breakdownDraft: draft, ...over } });
  const reload = (id: string) => t.prisma.ticket.findUniqueOrThrow({ where: { id } });
  const rows = (ticketId: string) => t.prisma.subtask.findMany({ where: { ticketId }, orderBy: { seq: 'asc' } });

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
    await t.prisma.stateTransition.deleteMany();
    await t.prisma.project.update({ where: { id: projectId }, data: { settings: {} } });
  });

  it('requires a session', async () => {
    await t.anonymous.post('/tickets/x/breakdown/approve').send({}).expect(401);
    await t.anonymous.post('/tickets/x/breakdown/reject').send({ note: 'n' }).expect(401);
  });

  describe('approve', () => {
    it('creates ordered Subtask rows from the proposed list and moves to IN_PROGRESS', async () => {
      const tk = await ticket();
      const res = await t.agent.post(`/tickets/${tk.id}/breakdown/approve`).send({}).expect(200);
      expect(res.body.status).toBe('IN_PROGRESS');
      const created = await rows(tk.id);
      expect(created.map((r) => [r.seq, r.title, r.status, r.fixRounds])).toEqual([[1, 'Subtask 1', 'PENDING', 0], [2, 'Subtask 2', 'PENDING', 0], [3, 'Subtask 3', 'PENDING', 0]]);
      expect(created[2]).toMatchObject({ description: 'do 3', acceptanceCriteria: ['criterion 3'], files: ['src/f3.ts'], dependsOn: [1, 2], testFiles: [], testCommit: null, featCommit: null });
      expect((await t.prisma.stateTransition.findMany({ where: { ticketId: tk.id } }))[0]).toMatchObject({ fromStatus: 'AWAITING_BREAKDOWN_APPROVAL', toStatus: 'IN_PROGRESS', actor: 'user', reason: 'Breakdown approved' });
    });

    it('stores an edited list (titles, descriptions, criteria, order) and creates rows from it', async () => {
      const tk = await ticket();
      const edited = [st(1, { title: 'Renamed first', acceptanceCriteria: ['a', 'b'] }), st(2, { description: 'edited text', dependsOn: [1] })];
      await t.agent.post(`/tickets/${tk.id}/breakdown/approve`).send({ subtasks: edited }).expect(200);
      const created = await rows(tk.id);
      expect(created).toHaveLength(2);
      expect(created[0]).toMatchObject({ title: 'Renamed first', acceptanceCriteria: ['a', 'b'] });
      expect(created[1]?.description).toBe('edited text');
      expect(((await reload(tk.id)).breakdownDraft as unknown[]).length).toBe(2);
      expect((await t.prisma.stateTransition.findMany({ where: { ticketId: tk.id } }))[0]?.reason).toBe('Breakdown approved with edits');
    });

    it('sorts an edited list by seq', async () => {
      const tk = await ticket();
      await t.agent.post(`/tickets/${tk.id}/breakdown/approve`).send({ subtasks: [st(2, { dependsOn: [1] }), st(1)] }).expect(200);
      expect((await rows(tk.id)).map((r) => r.title)).toEqual(['Subtask 1', 'Subtask 2']);
    });

    it('rejects invalid breakdowns with field-level errors, creating nothing and keeping the ticket at the gate', async () => {
      const tk = await ticket();
      const cases: [unknown[], string, string][] = [
        [[st(1, { dependsOn: [2] }), st(2)], 'subtasks.0.dependsOn', 'depends on a later subtask'],
        [[st(1), st(3)], 'subtasks', 'seq values must be exactly 1 to 2'],
        [[st(1, { acceptanceCriteria: [] })], 'subtasks.0.acceptanceCriteria', 'at least one acceptance criterion'],
        [[st(1, { title: ' ' })], 'subtasks.0.title', 'required'],
        [Array.from({ length: 9 }, (_, i) => st(i + 1)), 'subtasks', 'more than the limit of 8'],
        [[], 'subtasks', 'at least one subtask is required'],
        [[st(1, { dependsOn: [1] })], 'subtasks.0.dependsOn', 'cannot depend on itself'],
      ];
      for (const [list, field, text] of cases) {
        const res = await t.agent.post(`/tickets/${tk.id}/breakdown/approve`).send({ subtasks: list }).expect(400);
        expect(res.body.error).toBe('validation_error');
        expect(res.body.fields[field], `${field} for ${text}`).toContain(text);
      }
      expect(await rows(tk.id)).toEqual([]);
      expect((await reload(tk.id)).status).toBe('AWAITING_BREAKDOWN_APPROVAL');
      expect(await t.prisma.stateTransition.count({ where: { ticketId: tk.id } })).toBe(0);
    });

    it('applies the project limit maxSubtasks', async () => {
      await t.prisma.project.update({ where: { id: projectId }, data: { settings: { limits: { maxSubtasks: 2 } } } });
      const tk = await ticket();
      const res = await t.agent.post(`/tickets/${tk.id}/breakdown/approve`).send({}).expect(400); // the stored draft has 3
      expect(res.body.fields.subtasks).toContain('more than the limit of 2');
    });

    it('returns 400 when there is no proposed list and none is sent', async () => {
      const tk = await ticket({ breakdownDraft: null });
      expect((await t.agent.post(`/tickets/${tk.id}/breakdown/approve`).send({}).expect(400)).body.fields.subtasks).toBeDefined();
    });

    it('returns 409 unless awaiting breakdown approval, and 404 for an unknown ticket; it cannot be approved twice', async () => {
      for (const status of ['PLANNING', 'AWAITING_PLAN_APPROVAL', 'IN_PROGRESS', 'ON_HOLD']) {
        expect((await t.agent.post(`/tickets/${(await ticket({ status })).id}/breakdown/approve`).send({}).expect(409)).body.error).toBe('conflict');
      }
      await t.agent.post('/tickets/nope/breakdown/approve').send({}).expect(404);
      const tk = await ticket();
      await t.agent.post(`/tickets/${tk.id}/breakdown/approve`).send({}).expect(200);
      await t.agent.post(`/tickets/${tk.id}/breakdown/approve`).send({}).expect(409);
      expect(await rows(tk.id)).toHaveLength(3); // not duplicated
    });
  });

  describe('reject', () => {
    it('sends the ticket back to BREAKDOWN with the note as the reason, keeping the draft', async () => {
      const tk = await ticket();
      await t.agent.post(`/tickets/${tk.id}/breakdown/reject`).send({ note: 'Split the API from the UI' }).expect(200);
      expect(await reload(tk.id)).toMatchObject({ status: 'BREAKDOWN' });
      expect(((await reload(tk.id)).breakdownDraft as unknown[]).length).toBe(3);
      expect((await t.prisma.stateTransition.findMany({ where: { ticketId: tk.id } }))[0]).toMatchObject({ fromStatus: 'AWAITING_BREAKDOWN_APPROVAL', toStatus: 'BREAKDOWN', actor: 'user', reason: 'Split the API from the UI' });
      expect(await rows(tk.id)).toEqual([]);
    });
    it('needs a note, and answers 409 / 404 otherwise', async () => {
      const tk = await ticket();
      expect((await t.agent.post(`/tickets/${tk.id}/breakdown/reject`).send({}).expect(400)).body.fields.note).toBeTruthy();
      expect((await t.agent.post(`/tickets/${(await ticket({ status: 'BREAKDOWN' })).id}/breakdown/reject`).send({ note: 'n' }).expect(409)).body.error).toBe('conflict');
      await t.agent.post('/tickets/nope/breakdown/reject').send({ note: 'n' }).expect(404);
    });
  });

  it('on approval creates Jira sub-tasks when write-back is on, storing their keys', async () => {
    await t.prisma.project.update({ where: { id: projectId }, data: { jiraMode: 'rest', settings: {} } });
    t.jira.jira.calls = [];
    const tk = await ticket({ source: 'jira', externalKey: 'ABC-50', key: 'ABC-50' });
    await t.agent.post(`/tickets/${tk.id}/breakdown/approve`).send({}).expect(200);
    expect(t.jira.jira.calls.filter((c) => c.startsWith('subtask'))).toHaveLength(3);
    expect((await rows(tk.id)).every((r) => r.externalKey === 'ABC-50-S')).toBe(true);
    await t.prisma.project.update({ where: { id: projectId }, data: { jiraMode: 'off' } });
  });

  it('a Jira failure during approval does not block it', async () => {
    await t.prisma.project.update({ where: { id: projectId }, data: { jiraMode: 'rest', settings: {} } });
    t.jira.jira.failWith = new Error('Jira 503');
    const tk = await ticket({ source: 'jira', externalKey: 'ABC-51', key: 'ABC-51' });
    await t.agent.post(`/tickets/${tk.id}/breakdown/approve`).send({}).expect(200);
    t.jira.jira.failWith = null;
    expect((await reload(tk.id)).status).toBe('IN_PROGRESS');
    expect(await rows(tk.id)).toHaveLength(3);
    await t.prisma.project.update({ where: { id: projectId }, data: { jiraMode: 'off' } });
  });

  it('the ticket detail includes the proposed list and the created subtasks', async () => {
    const tk = await ticket();
    expect((await t.agent.get(`/tickets/${tk.id}`).expect(200)).body.breakdownDraft).toHaveLength(3);
    await t.agent.post(`/tickets/${tk.id}/breakdown/approve`).send({}).expect(200);
    expect((await t.agent.get(`/tickets/${tk.id}`).expect(200)).body.subtasks.map((s: { seq: number }) => s.seq)).toEqual([1, 2, 3]);
  });
});
