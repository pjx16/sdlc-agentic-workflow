import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { StateMachine } from '../state/state-machine.service';
import { type TestApp, createTestApp } from '../testing/test-app';
import { type TestDatabase, createTestDatabase } from '../testing/test-db';
import { SupportRaiser } from './support-raiser';
import { SupportModule } from './support.module';

describe('Assistant chat API (BUILD_PLAN v1 6.6)', () => {
  let db: TestDatabase;
  let t: TestApp;
  let projectId: string;
  let raiser: SupportRaiser;
  let states: StateMachine;
  let n = 0;

  const ticket = (over: Record<string, unknown> = {}) => t.prisma.ticket.create({ data: { projectId, key: `K-${++n}`, source: 'paste', title: 'Export bookings', status: 'PLANNING', planMarkdown: '# plan', ...over } });
  const question = async () => {
    const tk = await ticket({ status: 'ON_HOLD', holdReason: 'awaiting_answer', holdFromStatus: 'PLANNING' });
    const { ticket: q } = await raiser.raise({ kind: 'question', ticketId: tk.id, stage: 'plan', title: 'Which delimiter?', body: 'Which delimiter?', dedupeKey: `q:${tk.id}` });
    return { tk, q };
  };
  const approval = async () => {
    const tk = await ticket();
    await states.transition(tk.id, 'AWAITING_PLAN_APPROVAL', 'system');
    return { tk, q: (await t.prisma.supportTicket.findFirstOrThrow({ where: { ticketId: tk.id, kind: 'approval' } })) };
  };
  const send = (id: string, text = 'What should I answer?') => t.agent.post(`/support-tickets/${id}/assistant/messages`).send({ text });
  /** What the worker does: answers the waiting message. */
  const workerReplies = async (id: string, reply: string, draft: unknown = null) => {
    const c = await t.prisma.assistantConversation.findUniqueOrThrow({ where: { supportTicketId: id } });
    await t.prisma.assistantMessage.create({ data: { conversationId: c.id, role: 'assistant', text: reply, draft: draft as never } });
    await t.prisma.assistantConversation.update({ where: { id: c.id }, data: { pendingAt: null } });
    return (await t.agent.get(`/support-tickets/${id}/assistant`).expect(200)).body.messages.at(-1);
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    t = await createTestApp(db.url, [SupportModule]);
    projectId = (await t.prisma.project.create({ data: { name: 'p', repoUrl: 'https://x/y', stack: 'ts_node', testCmdTemplate: 'x {files}', localKeyPrefix: 'P', mirrorStatus: 'ok' } })).id;
    raiser = t.app.get(SupportRaiser);
    states = t.app.get(StateMachine);
  }, 180_000);
  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });
  beforeEach(async () => {
    await t.prisma.assistantConversation.deleteMany();
    await t.prisma.supportTicket.deleteMany();
    await t.prisma.globalSettings.deleteMany();
  });

  it('requires a session', async () => {
    await t.anonymous.get('/support-tickets/x/assistant').expect(401);
    await t.anonymous.post('/support-tickets/x/assistant/messages').send({ text: 'hi' }).expect(401);
  });

  it('starts empty, and a sent message is stored and waits for the worker', async () => {
    const { q } = await question();
    const empty = (await t.agent.get(`/support-tickets/${q.id}/assistant`).expect(200)).body;
    expect(empty).toMatchObject({ canSend: true, pending: false, tokens: 0, tokenCap: 200000, messages: [] });
    const sent = (await send(q.id).expect(200)).body;
    expect(sent).toMatchObject({ pending: true, canSend: false, blockedReason: expect.stringContaining('still answering'), messages: [{ role: 'user', text: 'What should I answer?' }] });
  });

  it('one waiting message at a time per chat', async () => {
    const { q } = await question();
    await send(q.id).expect(200);
    await send(q.id, 'again').expect(409);
    await workerReplies(q.id, 'Use a comma.');
    await send(q.id, 'and the quote character?').expect(200);
  });

  it('400 for an empty or very long message, 404 for an unknown ticket, 409 for a closed ticket', async () => {
    const { q } = await question();
    await send(q.id, '  ').expect(400);
    await send(q.id, 'x'.repeat(4001)).expect(400);
    await send('00000000-0000-0000-0000-000000000000').expect(404);
    await t.prisma.supportTicket.update({ where: { id: q.id }, data: { status: 'dismissed' } });
    await send(q.id).expect(409);
  });

  it('is refused while the pipeline is paused for limits, but not when paused by hand', async () => {
    const { q } = await question();
    await t.prisma.globalSettings.create({ data: { id: 'global', pipelinePaused: true, pausedReason: 'Claude usage limit reached', pausedCode: 'CLAUDE_USAGE_LIMIT' } });
    const res = await send(q.id).expect(409);
    expect(res.body.message).toContain('paused');
    expect((await t.agent.get(`/support-tickets/${q.id}/assistant`).expect(200)).body).toMatchObject({ canSend: false, blockedReason: expect.stringContaining('paused') });
    await t.prisma.globalSettings.update({ where: { id: 'global' }, data: { pausedReason: 'manual', pausedCode: null } });
    await send(q.id).expect(200);
  });

  it('stops at the token cap from Settings and says why', async () => {
    const { q } = await question();
    await t.prisma.globalSettings.create({ data: { id: 'global', assistantTokenCap: 1000 } });
    await send(q.id).expect(200);
    await workerReplies(q.id, 'ok');
    await t.prisma.assistantConversation.updateMany({ data: { tokens: 1000 } });
    const state = (await t.agent.get(`/support-tickets/${q.id}/assistant`).expect(200)).body;
    expect(state).toMatchObject({ capReached: true, canSend: false, tokenCap: 1000, blockedReason: expect.stringContaining('token budget') });
    await send(q.id).expect(409);
  });

  describe('applying a draft goes through the normal support action', () => {
    it('answer: answers the question and resumes the ticket', async () => {
      const { tk, q } = await question();
      await send(q.id).expect(200);
      const m = await workerReplies(q.id, 'Use a comma.', { kind: 'answer', text: 'Comma' });
      expect(m.draft).toMatchObject({ kind: 'answer', text: 'Comma', appliedAt: null });
      const res = await t.agent.post(`/support-tickets/${q.id}/assistant/messages/${m.id}/apply`).expect(200);
      expect(res.body).toMatchObject({ status: 'answered', response: 'Comma' });
      expect((await t.prisma.ticket.findUniqueOrThrow({ where: { id: tk.id } })).status).toBe('PLANNING');
      expect((await t.agent.get(`/support-tickets/${q.id}/assistant`).expect(200)).body.messages.at(-1).draft.appliedAt).not.toBeNull();
    });

    it('a draft can only be applied once', async () => {
      const { q } = await question();
      await send(q.id).expect(200);
      const m = await workerReplies(q.id, 'x', { kind: 'answer', text: 'Comma' });
      await t.agent.post(`/support-tickets/${q.id}/assistant/messages/${m.id}/apply`).expect(200);
      await t.agent.post(`/support-tickets/${q.id}/assistant/messages/${m.id}/apply`).expect(409);
    });

    it('plan_edit: approves the plan with the edited text', async () => {
      const { tk, q } = await approval();
      await send(q.id, 'Make the plan smaller').expect(200);
      const m = await workerReplies(q.id, 'Here is a smaller plan.', { kind: 'plan_edit', text: '# smaller plan' });
      await t.agent.post(`/support-tickets/${q.id}/assistant/messages/${m.id}/apply`).expect(200);
      expect(await t.prisma.ticket.findUniqueOrThrow({ where: { id: tk.id } })).toMatchObject({ status: 'BREAKDOWN', planMarkdown: '# smaller plan' });
    });

    it('rerun_note: sends the ticket back with the note', async () => {
      const { tk, q } = await approval();
      await send(q.id).expect(200);
      const m = await workerReplies(q.id, 'I would reject it.', { kind: 'rerun_note', text: 'Use the existing repository.' });
      await t.agent.post(`/support-tickets/${q.id}/assistant/messages/${m.id}/apply`).expect(200);
      expect((await t.prisma.ticket.findUniqueOrThrow({ where: { id: tk.id } })).status).toBe('PLANNING');
      expect((await t.prisma.stateTransition.findMany({ where: { ticketId: tk.id } })).at(-1)?.reason).toBe('Use the existing repository.');
    });

    it('refuses a draft that does not fit the kind of ticket, and a message without a draft', async () => {
      const { q } = await question();
      await send(q.id).expect(200);
      const bad = await workerReplies(q.id, 'x', { kind: 'plan_edit', text: '# plan' });
      await t.agent.post(`/support-tickets/${q.id}/assistant/messages/${bad.id}/apply`).expect(409);
      const none = await workerReplies(q.id, 'just words');
      await t.agent.post(`/support-tickets/${q.id}/assistant/messages/${none.id}/apply`).expect(404);
    });

    it('the assistant itself never changes the ticket: a reply with a draft leaves everything as it was', async () => {
      const { tk, q } = await question();
      await send(q.id).expect(200);
      await workerReplies(q.id, 'Use a comma.', { kind: 'answer', text: 'Comma' });
      expect((await t.prisma.ticket.findUniqueOrThrow({ where: { id: tk.id } })).status).toBe('ON_HOLD');
      expect((await t.prisma.supportTicket.findUniqueOrThrow({ where: { id: q.id } })).status).toBe('open');
    });
  });
});
