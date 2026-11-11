import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { StageLauncher } from '../worker/pipeline/stage-launcher';
import { StageOutcomes } from '../worker/pipeline/stage-outcomes';
import { WorkerConfig } from '../worker/worker-config';
import { type TestApp, createTestApp } from '../testing/test-app';
import { type TestDatabase, createTestDatabase } from '../testing/test-db';
import { SupportModule } from './support.module';

describe('Support queries (F13)', () => {
  let db: TestDatabase;
  let t: TestApp;
  let projectId: string;
  let n = 0;
  let outcomes: StageOutcomes;
  let launcher: StageLauncher;
  let lastInputs: Record<string, unknown> | null = null;

  const ticket = (over: Record<string, unknown> = {}) => t.prisma.ticket.create({ data: { projectId, key: `K-${++n}`, source: 'paste', title: `title ${n}`, status: 'PLANNING', ...over } });
  const run = (ticketId: string, stage = 'plan') => t.prisma.stageRun.create({ data: { projectId, ticketId, stage: stage as never, model: 'm', attempt: 1, status: 'failed' } });
  const reload = (id: string) => t.prisma.ticket.findUniqueOrThrow({ where: { id } });
  /** A held ticket with an open question, as the worker leaves it. */
  const asked = async (stage = 'plan', question = 'Which currency?') => {
    const tk = await ticket({ status: 'ON_HOLD', holdReason: 'awaiting_answer', holdFromStatus: 'PLANNING' });
    const r = await run(tk.id, stage);
    const q = await t.prisma.supportQuery.create({ data: { ticketId: tk.id, stageRunId: r.id, stage, question } });
    return { tk, q };
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    t = await createTestApp(db.url, [SupportModule]);
    projectId = (await t.prisma.project.create({ data: { name: 'p', repoUrl: 'https://x/y', stack: 'ts_node', testCmdTemplate: 'x {files}', localKeyPrefix: 'P', mirrorStatus: 'ok' } })).id;
    outcomes = new StageOutcomes(t.prisma);
    launcher = new StageLauncher(t.prisma, new WorkerConfig({ DATA_DIR: '/tmp/sdlc-support-test', DATABASE_URL: db.url } as NodeJS.ProcessEnv), { run: async (req: { inputs: Record<string, unknown> }) => ((lastInputs = req.inputs), { kind: 'done' }) } as never);
  }, 180_000);
  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });
  beforeEach(async () => {
    lastInputs = null;
    await t.prisma.supportQuery.deleteMany();
  });

  it('requires a session', async () => {
    await t.anonymous.get('/support-queries').expect(401);
    await t.anonymous.post('/support-queries/x/answer').send({ answer: 'a' }).expect(401);
  });

  describe('a stage asks (worker side)', () => {
    it('stores the question and holds the ticket (awaiting_answer)', async () => {
      const tk = await ticket();
      const r = await run(tk.id);
      const out = await outcomes.forResult(tk.id, 'plan', { kind: 'needs_input', question: 'Which currency?', stageRunId: r.id } as never);
      expect(out).toMatchObject({ kind: 'hold', reason: 'awaiting_answer' });
      expect(await t.prisma.supportQuery.findMany({ where: { ticketId: tk.id } })).toMatchObject([{ stage: 'plan', question: 'Which currency?', status: 'open' }]);
    });

    it('the 4th question of a stage holds the ticket for help instead (max 3 per ticket and stage)', async () => {
      const tk = await ticket();
      const r = await run(tk.id);
      for (let i = 1; i <= 3; i++) {
        expect(await outcomes.forResult(tk.id, 'plan', { kind: 'needs_input', question: `q${i}`, stageRunId: r.id } as never)).toMatchObject({ reason: 'awaiting_answer' });
      }
      const fourth = await outcomes.forResult(tk.id, 'plan', { kind: 'needs_input', question: 'q4', stageRunId: r.id } as never);
      expect(fourth).toMatchObject({ kind: 'hold', reason: 'needs_help' });
      expect(await t.prisma.supportQuery.count({ where: { ticketId: tk.id } })).toBe(3);
      expect(await outcomes.forResult(tk.id, 'breakdown', { kind: 'needs_input', question: 'other', stageRunId: r.id } as never)).toMatchObject({ reason: 'awaiting_answer' });
    });
  });

  describe('GET /support-queries', () => {
    it('lists open questions first (oldest first), then answered ones, with the ticket and stage', async () => {
      const a = await asked('plan', 'first');
      const b = await asked('breakdown', 'second');
      await asked('plan', 'third');
      await t.agent.post(`/support-queries/${a.q.id}/answer`).send({ answer: 'x' }).expect(200);
      const res = await t.agent.get('/support-queries').expect(200);
      expect(res.body.map((q: { question: string; status: string }) => [q.question, q.status])).toEqual([['second', 'open'], ['third', 'open'], ['first', 'answered']]);
      expect(res.body[0]).toMatchObject({ ticketKey: b.tk.key, stage: 'breakdown', ticketId: b.tk.id });
      expect((await t.agent.get('/support-queries?status=open').expect(200)).body).toHaveLength(2);
    });
  });

  describe('POST /support-queries/:id/answer', () => {
    it('stores the answer and re-queues the stage: the ticket resumes to the state it was held from', async () => {
      const { tk, q } = await asked();
      const res = await t.agent.post(`/support-queries/${q.id}/answer`).send({ answer: 'EUR' }).expect(200);
      expect(res.body).toMatchObject({ id: q.id, status: 'answered', answer: 'EUR' });
      expect(await reload(tk.id)).toMatchObject({ status: 'PLANNING', holdReason: null });
      expect((await t.prisma.stateTransition.findMany({ where: { ticketId: tk.id } })).at(-1)).toMatchObject({ fromStatus: 'ON_HOLD', toStatus: 'PLANNING', actor: 'user' });
    });

    it('409 when already answered, 404 when unknown, 400 for an empty answer', async () => {
      const { q } = await asked();
      await t.agent.post(`/support-queries/${q.id}/answer`).send({ answer: ' ' }).expect(400);
      await t.agent.post(`/support-queries/${q.id}/answer`).send({ answer: 'a' }).expect(200);
      await t.agent.post(`/support-queries/${q.id}/answer`).send({ answer: 'b' }).expect(409);
      await t.agent.post('/support-queries/00000000-0000-0000-0000-000000000000/answer').send({ answer: 'a' }).expect(404);
      expect((await t.prisma.supportQuery.findUniqueOrThrow({ where: { id: q.id } })).answer).toBe('a');
    });

    it('answering a question of a ticket that is not waiting just stores the answer', async () => {
      const { tk, q } = await asked();
      await t.prisma.ticket.update({ where: { id: tk.id }, data: { status: 'PLANNING', holdReason: null, holdFromStatus: null } });
      await t.agent.post(`/support-queries/${q.id}/answer`).send({ answer: 'a' }).expect(200);
      expect((await reload(tk.id)).status).toBe('PLANNING');
    });

    it('a ticket with another open question keeps waiting until every question is answered', async () => {
      const { tk, q } = await asked();
      const r = await run(tk.id);
      const q2 = await t.prisma.supportQuery.create({ data: { ticketId: tk.id, stageRunId: r.id, stage: 'plan', question: 'two' } });
      await t.agent.post(`/support-queries/${q.id}/answer`).send({ answer: 'a' }).expect(200);
      expect((await reload(tk.id)).status).toBe('ON_HOLD');
      await t.agent.post(`/support-queries/${q2.id}/answer`).send({ answer: 'b' }).expect(200);
      expect((await reload(tk.id)).status).toBe('PLANNING');
    });
  });

  it('the re-run stage gets every earlier question and answer of that stage (and none of another stage)', async () => {
    const { tk, q } = await asked('plan', 'Which currency?');
    await t.agent.post(`/support-queries/${q.id}/answer`).send({ answer: 'EUR' }).expect(200);
    const r = await run(tk.id);
    const q2 = await t.prisma.supportQuery.create({ data: { ticketId: tk.id, stageRunId: r.id, stage: 'plan', question: 'Rounding?' } });
    await t.prisma.supportQuery.update({ where: { id: q2.id }, data: { answer: 'Half up', status: 'answered' } });
    await t.prisma.supportQuery.create({ data: { ticketId: tk.id, stageRunId: r.id, stage: 'breakdown', question: 'other', answer: 'nope', status: 'answered' } });
    await t.prisma.supportQuery.create({ data: { ticketId: tk.id, stageRunId: r.id, stage: 'plan', question: 'unanswered' } });
    await launcher.launch(await reload(tk.id), 'plan', { ticket: { key: tk.key, title: 't', body: 'b' } });
    expect(lastInputs?.qa).toEqual([{ question: 'Which currency?', answer: 'EUR' }, { question: 'Rounding?', answer: 'Half up' }]);
  });
});
