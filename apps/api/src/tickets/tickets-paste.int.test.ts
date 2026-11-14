import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type TestApp, createTestApp } from '../testing/test-app';
import { type TestDatabase, createTestDatabase } from '../testing/test-db';
import { TicketsModule } from './tickets.module';

describe('Pasted tickets (F3)', () => {
  let db: TestDatabase;
  let t: TestApp;
  let projectId: string;

  const makeProject = (over: Record<string, unknown> = {}) =>
    t.prisma.project.create({ data: { name: `p-${Math.random().toString(36).slice(2, 8)}`, repoUrl: 'https://x/y', stack: 'ts_node', testCmdTemplate: 'x {files}', localKeyPrefix: 'BILL', mirrorStatus: 'ok', ...over } });

  beforeAll(async () => {
    db = await createTestDatabase();
    t = await createTestApp(db.url, [TicketsModule]);
  }, 180_000);
  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });
  beforeEach(async () => {
    await t.prisma.event.deleteMany();
    await t.prisma.ticket.deleteMany();
    await t.prisma.project.deleteMany();
    projectId = (await makeProject()).id;
  });

  it('requires a session', async () => {
    await t.anonymous.post('/tickets').send({ projectId, title: 'x' }).expect(401);
  });

  it('creates a NEW ticket with the next local key', async () => {
    const res = await t.agent.post('/tickets').send({ projectId, title: 'Add export', body: 'CSV please', type: 'story', featureKey: 'export' }).expect(201);
    expect(res.body).toMatchObject({ key: 'BILL-1', source: 'paste', externalKey: null, status: 'NEW', title: 'Add export', body: 'CSV please', type: 'story', featureKey: 'export', projectId });
    const second = await t.agent.post('/tickets').send({ projectId, title: 'Fix crash', type: 'bug' }).expect(201);
    expect(second.body).toMatchObject({ key: 'BILL-2', type: 'bug', status: 'NEW' });
    expect((await t.prisma.project.findUniqueOrThrow({ where: { id: projectId } })).nextLocalNumber).toBe(3);
    expect(await t.prisma.event.count({ where: { type: 'intake' } })).toBe(2);
  });

  it('a pasted ticket carries a kind, and the older type stays consistent with it', async () => {
    const make = async (body: Record<string, unknown>) => (await t.agent.post('/tickets').send({ projectId, title: 'x', ...body }).expect(201)).body.id as string;
    const stored = async (id: string) => t.prisma.ticket.findUniqueOrThrow({ where: { id } });
    expect(await stored(await make({}))).toMatchObject({ kind: 'feature', type: 'story' });
    expect(await stored(await make({ kind: 'bug' }))).toMatchObject({ kind: 'bug', type: 'bug' });
    expect(await stored(await make({ kind: 'chore' }))).toMatchObject({ kind: 'chore', type: 'tech' });
    expect(await stored(await make({ type: 'tech' }))).toMatchObject({ kind: 'chore', type: 'tech' }); // only the old field sent
    expect(await stored(await make({ kind: 'feature', type: 'bug' }))).toMatchObject({ kind: 'feature', type: 'story' }); // the kind wins
    const bad = await t.agent.post('/tickets').send({ projectId, title: 'x', kind: 'epic' }).expect(400);
    expect(bad.body.fields.kind).toContain('feature, bug, chore');
  });

  it('works in every Jira mode', async () => {
    for (const jiraMode of ['off', 'rest'] as const) {
      const p = await makeProject({ jiraMode, localKeyPrefix: jiraMode.toUpperCase() });
      const res = await t.agent.post('/tickets').send({ projectId: p.id, title: `in ${jiraMode}` }).expect(201);
      expect(res.body).toMatchObject({ key: `${jiraMode.toUpperCase()}-1`, status: 'NEW', source: 'paste' });
    }
  });

  it('numbers each project independently', async () => {
    const other = await makeProject({ localKeyPrefix: 'OTHR' });
    await t.agent.post('/tickets').send({ projectId, title: 'a' }).expect(201);
    expect((await t.agent.post('/tickets').send({ projectId: other.id, title: 'b' }).expect(201)).body.key).toBe('OTHR-1');
  });

  it('never hands out the same key twice, even for simultaneous pastes', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => t.agent.post('/tickets').send({ projectId, title: `t${i}` })));
    expect(results.every((r) => r.status === 201)).toBe(true);
    const keys = results.map((r) => r.body.key as string).sort();
    expect(new Set(keys).size).toBe(8);
    expect(await t.prisma.ticket.count({ where: { projectId } })).toBe(8);
  });

  it('stores a ticket once per (projectId, key)', async () => {
    const first = (await t.agent.post('/tickets').send({ projectId, title: 'a' }).expect(201)).body;
    await expect(t.prisma.ticket.create({ data: { projectId, key: first.key, source: 'paste', title: 'dup' } })).rejects.toThrow(/unique/i);
  });

  it('returns field-level errors and saves nothing', async () => {
    const res = await t.agent.post('/tickets').send({ projectId, title: '', type: 'epic' }).expect(400);
    expect(res.body.fields).toMatchObject({ title: 'required', type: 'must be one of story, bug, tech' });
    expect(await t.prisma.ticket.count()).toBe(0);
    expect((await t.agent.post('/tickets').send({}).expect(400)).body.fields.projectId).toBe('required');
  });

  it('rejects an unknown field (a typo for body) and saves nothing', async () => {
    const res = await t.agent.post('/tickets').send({ projectId, title: 'x', description: 'meant body' }).expect(400);
    expect(res.body.fields).toEqual({ description: 'unknown field' });
    expect(await t.prisma.ticket.count()).toBe(0);
  });

  it('rejects an unknown, disabled or paste-disabled project', async () => {
    expect((await t.agent.post('/tickets').send({ projectId: 'nope', title: 'x' }).expect(400)).body.fields.projectId).toBe('unknown project');
    const disabled = await makeProject({ enabled: false });
    expect((await t.agent.post('/tickets').send({ projectId: disabled.id, title: 'x' }).expect(400)).body.fields.projectId).toBe('this project is disabled');
    const noPaste = await makeProject({ settings: { intake: { paste: false } } });
    expect((await t.agent.post('/tickets').send({ projectId: noPaste.id, title: 'x' }).expect(400)).body.fields.projectId).toContain('turned off');
    expect(await t.prisma.ticket.count()).toBe(0);
  });

  it('accepts tickets only when the mirror is ready (F2) and does not use up a number otherwise', async () => {
    const pending = await makeProject({ mirrorStatus: 'pending', localKeyPrefix: 'PEND' });
    const res = await t.agent.post('/tickets').send({ projectId: pending.id, title: 'x' }).expect(409);
    expect(res.body.error).toBe('conflict');
    expect(res.body.message).toContain('still being cloned');
    const failed = await makeProject({ mirrorStatus: 'failed', mirrorError: 'boom' });
    expect((await t.agent.post('/tickets').send({ projectId: failed.id, title: 'x' }).expect(409)).body.message).toContain('failed');
    expect((await t.prisma.project.findUniqueOrThrow({ where: { id: pending.id } })).nextLocalNumber).toBe(1);
  });
});
