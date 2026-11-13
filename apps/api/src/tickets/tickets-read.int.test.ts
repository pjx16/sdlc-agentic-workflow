import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { StateMachine } from '../state/state-machine.service';
import { type TestApp, createTestApp } from '../testing/test-app';
import { type TestDatabase, createTestDatabase } from '../testing/test-db';
import { TicketsModule } from './tickets.module';

describe('Tickets API: list, detail, history, timeline (BUILD_PLAN 8)', () => {
  let db: TestDatabase;
  let t: TestApp;
  let sm: StateMachine;
  let a: string; // project ids
  let b: string;
  let n = 0;

  const project = (name: string) => t.prisma.project.create({ data: { name, repoUrl: 'https://x/y', stack: 'ts_node', testCmdTemplate: 'x {files}', localKeyPrefix: name.slice(0, 3).toUpperCase(), mirrorStatus: 'ok' } });
  const ticket = (projectId: string, over: Record<string, unknown> = {}) => t.prisma.ticket.create({ data: { projectId, key: `K-${++n}`, source: 'paste', title: `title ${n}`, ...over } });

  beforeAll(async () => {
    db = await createTestDatabase();
    t = await createTestApp(db.url, [TicketsModule]);
    sm = new StateMachine(t.prisma);
  }, 180_000);
  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });
  beforeEach(async () => {
    await t.prisma.event.deleteMany();
    await t.prisma.stateTransition.deleteMany();
    await t.prisma.stageRun.deleteMany();
    await t.prisma.ticket.deleteMany();
    await t.prisma.project.deleteMany();
    a = (await project('Alpha')).id;
    b = (await project('Beta')).id;
  });

  it('requires a session', async () => {
    await t.anonymous.get('/tickets').expect(401);
    await t.anonymous.get('/tickets/x').expect(401);
    await t.anonymous.get('/tickets/x/transitions').expect(401);
  });

  it('lists tickets with their project, newest activity first', async () => {
    const first = await ticket(a);
    const second = await ticket(b);
    await t.prisma.ticket.update({ where: { id: first.id }, data: { title: 'touched' } });
    const res = (await t.agent.get('/tickets').expect(200)).body;
    expect(res.map((x: { key: string }) => x.key)).toEqual([first.key, second.key]);
    expect(res[0]).toMatchObject({ projectName: 'Alpha', status: 'NEW', source: 'paste', title: 'touched' });
  });

  it('filters by project and by state', async () => {
    await ticket(a);
    await ticket(a, { status: 'PLANNING' });
    await ticket(b, { status: 'PLANNING' });
    expect((await t.agent.get(`/tickets?projectId=${a}`).expect(200)).body).toHaveLength(2);
    expect((await t.agent.get('/tickets?status=PLANNING').expect(200)).body).toHaveLength(2);
    expect((await t.agent.get(`/tickets?projectId=${b}&status=PLANNING`).expect(200)).body).toHaveLength(1);
    expect((await t.agent.get('/tickets?status=DONE').expect(200)).body).toEqual([]);
    const bad = await t.agent.get('/tickets?status=BOGUS').expect(400);
    expect(bad.body.fields.status).toContain('must be one of');
  });

  it('shows pasted and polled tickets together, all as NEW', async () => {
    await ticket(a);
    await ticket(a, { source: 'jira', externalKey: 'ABC-5', key: 'ABC-5' });
    const res = (await t.agent.get('/tickets').expect(200)).body;
    expect(res.map((x: { source: string; status: string }) => [x.source, x.status]).sort()).toEqual([['jira', 'NEW'], ['paste', 'NEW']]);
  });

  it('returns the ticket with subtasks, stage runs, findings and support queries', async () => {
    const tk = await ticket(a, { planMarkdown: '# Plan' });
    await t.prisma.subtask.create({ data: { ticketId: tk.id, seq: 2, title: 'second' } });
    await t.prisma.subtask.create({ data: { ticketId: tk.id, seq: 1, title: 'first', status: 'DONE' } });
    const run = await t.prisma.stageRun.create({ data: { projectId: a, ticketId: tk.id, stage: 'plan', model: 'opus', status: 'succeeded', startedAt: new Date(), endedAt: new Date(), inputTokens: 5, outputTokens: 7, costUsd: 0.0123, numTurns: 3 } });
    await t.prisma.reviewFinding.create({ data: { ticketId: tk.id, round: 1, severity: 'high', file: 'a.ts', line: 3, issue: 'bad', rule: 'r', fix: 'f' } });
    await t.prisma.supportTicket.create({ data: { kind: 'question', title: 'Which db?', body: 'Which db?', ticketId: tk.id, stageRunId: run.id, stage: 'plan' } });
    const res = (await t.agent.get(`/tickets/${tk.id}`).expect(200)).body;
    expect(res).toMatchObject({ key: tk.key, projectName: 'Alpha', planMarkdown: '# Plan', maxSubtasks: 8 });
    expect(res.subtasks.map((s: { seq: number }) => s.seq)).toEqual([1, 2]);
    expect(res.stageRuns[0]).toMatchObject({ stage: 'plan', status: 'succeeded', inputTokens: 5, outputTokens: 7, costUsd: 0.0123, numTurns: 3 });
    expect(res.findings[0]).toMatchObject({ severity: 'high', file: 'a.ts', line: 3, status: 'open' });
    expect(res.supportQueries[0]).toMatchObject({ question: 'Which db?', status: 'open', answer: null });
  });

  it('records every transition and returns the history oldest first, with Jira sync results', async () => {
    const tk = await ticket(a);
    await sm.transition(tk.id, 'KB', 'system', 'picked up');
    const planning = await sm.transition(tk.id, 'PLANNING', 'system');
    await t.prisma.stateTransition.update({ where: { id: planning.transition.id }, data: { jiraSyncResult: 'failed', jiraStatusApplied: 'Shipped', jiraSyncError: 'Jira has no transition to "Shipped"' } });
    await sm.hold(tk.id, 'needs_help', 'system', 'failed twice');
    const res = (await t.agent.get(`/tickets/${tk.id}/transitions`).expect(200)).body;
    expect(res.map((r: { fromStatus: string; toStatus: string }) => `${r.fromStatus}>${r.toStatus}`)).toEqual(['NEW>KB', 'KB>PLANNING', 'PLANNING>ON_HOLD']);
    expect(res[0]).toMatchObject({ actor: 'system', reason: 'picked up', jiraSyncResult: 'none', jiraStatusApplied: null });
    expect(res[1]).toMatchObject({ jiraSyncResult: 'failed', jiraStatusApplied: 'Shipped', jiraSyncError: 'Jira has no transition to "Shipped"' });
  });

  it('returns stage runs as timeline bars', async () => {
    const tk = await ticket(a);
    const start = new Date('2026-01-01T10:00:00Z');
    await t.prisma.stageRun.create({ data: { projectId: a, ticketId: tk.id, stage: 'plan', model: 'opus', attempt: 1, status: 'failed', startedAt: start, endedAt: new Date('2026-01-01T10:05:00Z') } });
    await t.prisma.stageRun.create({ data: { projectId: a, ticketId: tk.id, stage: 'plan', model: 'opus', attempt: 2, status: 'succeeded', startedAt: new Date('2026-01-01T10:06:00Z'), endedAt: new Date('2026-01-01T10:09:00Z') } });
    const res = (await t.agent.get(`/tickets/${tk.id}/timeline`).expect(200)).body;
    expect(res.map((r: { attempt: number; status: string }) => [r.attempt, r.status])).toEqual([[1, 'failed'], [2, 'succeeded']]);
    expect(res[0]).toMatchObject({ stage: 'plan', startedAt: '2026-01-01T10:00:00.000Z', endedAt: '2026-01-01T10:05:00.000Z' });
  });

  it('returns 404 for an unknown ticket on every endpoint', async () => {
    for (const path of ['/tickets/nope', '/tickets/nope/transitions', '/tickets/nope/timeline']) expect((await t.agent.get(path).expect(404)).body.error).toBe('not_found');
  });

  it('rejects an invalid transition and records nothing', async () => {
    const tk = await ticket(a);
    await expect(sm.transition(tk.id, 'DONE', 'user')).rejects.toMatchObject({ status: 409, code: 'invalid_transition' });
    expect((await t.agent.get(`/tickets/${tk.id}/transitions`).expect(200)).body).toEqual([]);
  });
});
