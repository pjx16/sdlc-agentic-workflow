import type { TicketStatus } from '@sdlc/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaStageRunStore } from '../worker/agent-runner/stage-run-store';
import { StateMachine } from '../state/state-machine.service';
import { SupportRaiser } from '../support/support-raiser';
import { type TestApp, createTestApp } from '../testing/test-app';
import { type TestDatabase, createTestDatabase } from '../testing/test-db';
import { TicketsModule } from './tickets.module';

describe('Rerun engine (BUILD_PLAN v1 6.8)', () => {
  let db: TestDatabase;
  let t: TestApp;
  let states: StateMachine;
  let raiser: SupportRaiser;
  let projectId: string;
  let n = 0;
  const FORWARD: TicketStatus[] = ['NEW', 'KB', 'PLANNING', 'AWAITING_PLAN_APPROVAL', 'BREAKDOWN', 'AWAITING_BREAKDOWN_APPROVAL', 'IN_PROGRESS', 'REVIEW'];

  const ago = (min: number) => new Date(Date.now() - min * 60_000);
  const setProject = (data: Record<string, unknown>) => t.prisma.project.update({ where: { id: projectId }, data: data as never });
  const rerun = (id: string, body: Record<string, unknown>) => t.agent.post(`/tickets/${id}/rerun`).send(body);
  const reload = (id: string) => t.prisma.ticket.findUniqueOrThrow({ where: { id } });

  /** A ticket that has been walked forward, move by move through the state machine, up to `to`. */
  const journey = async (to: TicketStatus = 'REVIEW', over: Record<string, unknown> = {}) => {
    const tk = await t.prisma.ticket.create({ data: { projectId, key: `R-${++n}`, source: 'paste', title: 'Export bookings', status: 'NEW', ...over } });
    for (const s of FORWARD.slice(1, FORWARD.indexOf(to) + 1)) await states.transition(tk.id, s, 'system', 'moved on');
    return tk;
  };
  const run = (ticketId: string, stage: string, over: Record<string, unknown> = {}) =>
    t.prisma.stageRun.create({ data: { projectId, ticketId, stage, model: 'sonnet', status: 'succeeded', startedAt: ago(30), endedAt: ago(29), ...over } as never });

  beforeAll(async () => {
    db = await createTestDatabase();
    t = await createTestApp(db.url, [TicketsModule]);
    states = t.app.get(StateMachine);
    raiser = t.app.get(SupportRaiser);
    projectId = (await t.prisma.project.create({ data: { name: 'p', repoUrl: 'https://x/y', stack: 'ts_node', testCmdTemplate: 'x {files}', localKeyPrefix: 'R', mirrorStatus: 'ok' } })).id;
  }, 180_000);
  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });
  beforeEach(async () => {
    await setProject({ settings: {}, jiraMode: 'off' });
    t.jira.jira.calls = [];
    t.jira.jira.commentBodies = {};
  });

  it('requires a session, and refuses an unknown ticket or a bad stage', async () => {
    await t.anonymous.post('/tickets/x/rerun').send({ stage: 'PLANNING' }).expect(401);
    await rerun('00000000-0000-0000-0000-000000000000', { stage: 'PLANNING' }).expect(404);
    const tk = await journey();
    const bad = await rerun(tk.id, { stage: 'AWAITING_PLAN_APPROVAL' }).expect(400);
    expect(bad.body.fields.stage).toBeDefined();
    await rerun(tk.id, { stage: 'PLANNING', note: 'x'.repeat(2001) }).expect(400);
  });

  describe('which reruns are legal', () => {
    it('refuses a stage that has not finished, one that is not before the ticket, and a DONE ticket', async () => {
      const early = await journey('PLANNING');
      expect((await rerun(early.id, { stage: 'BREAKDOWN' }).expect(409)).body.message).toContain('not before');
      expect((await rerun(early.id, { stage: 'PLANNING' }).expect(409)).body.message).toContain('not before');
      const mid = await journey('BREAKDOWN');
      expect((await rerun(mid.id, { stage: 'IN_PROGRESS' }).expect(409)).body.message).toContain('not before');
      const done = await journey('REVIEW');
      await t.prisma.ticket.update({ where: { id: done.id }, data: { status: 'DONE' } });
      expect((await rerun(done.id, { stage: 'KB' }).expect(409)).body.message).toContain('DONE');
    });

    it('refuses while a stage is running for the ticket, but not because of a chat', async () => {
      const tk = await journey();
      const running = await run(tk.id, 'review', { status: 'running', endedAt: null });
      expect((await rerun(tk.id, { stage: 'PLANNING' }).expect(409)).body.message).toContain('Stop it first');
      await t.prisma.stageRun.update({ where: { id: running.id }, data: { stage: 'assist' } });
      await rerun(tk.id, { stage: 'PLANNING' }).expect(200);
    });

    it('works from a held ticket, going back before the state it was held from', async () => {
      const tk = await journey();
      await states.hold(tk.id, 'needs_help', 'system', 'Stuck');
      await rerun(tk.id, { stage: 'BREAKDOWN', note: 'fewer subtasks' }).expect(200);
      expect(await reload(tk.id)).toMatchObject({ status: 'BREAKDOWN', holdReason: null, holdFromStatus: null });
    });
  });

  describe('what a rerun does', () => {
    it('records the move with its kind, note and actor, and writes the event in plain English', async () => {
      const tk = await journey();
      const res = await rerun(tk.id, { stage: 'PLANNING', note: 'use the existing booking repository' }).expect(200);
      expect(res.body).toMatchObject({ status: 'PLANNING' });
      expect((await t.prisma.stateTransition.findMany({ where: { ticketId: tk.id } })).at(-1)).toMatchObject({ kind: 'rerun', fromStatus: 'REVIEW', toStatus: 'PLANNING', actor: 'user', note: 'use the existing booking repository' });
      const ev = await t.prisma.event.findMany({ where: { ticketId: tk.id, message: { startsWith: 'Rerun of' } } });
      expect(ev.map((e) => e.message)).toEqual(['Rerun of PLANNING requested by user: "use the existing booking repository"']);
      expect(ev[0]).toMatchObject({ source: 'user', level: 'info' });
    });

    it('marks everything from the rerun stage on as stale, always, and nothing before it', async () => {
      const tk = await journey();
      const kb = await run(tk.id, 'kbBuild');
      const plan = await run(tk.id, 'plan');
      const breakdown = await run(tk.id, 'breakdown');
      const tests = await run(tk.id, 'tests', { startSha: 'aaa111', endSha: 'bbb222' });
      const impl = await run(tk.id, 'implement', { startSha: 'bbb222', endSha: 'ccc333' });
      const fixTests = await run(tk.id, 'fix', { reason: 'tests', startSha: 'ccc333', endSha: 'ddd444' });
      const review = await run(tk.id, 'review');
      for (const [stage, data] of [['kb', { featureKey: 'a' }], ['plan', { planMarkdown: '# p' }], ['breakdown', { subtasks: [] }], ['review', { round: 1, findings: [] }]] as const) {
        await t.prisma.stageArtifact.create({ data: { ticketId: tk.id, stage, version: 1, data } });
      }
      await rerun(tk.id, { stage: 'BREAKDOWN' }).expect(200);
      const stale = async (id: string) => (await t.prisma.stageRun.findUniqueOrThrow({ where: { id } })).supersededAt !== null;
      expect(await stale(kb.id)).toBe(false);
      expect(await stale(plan.id)).toBe(false);
      for (const r of [breakdown, tests, impl, fixTests, review]) expect(await stale(r.id), r.stage).toBe(true);
      const transition = (await t.prisma.stateTransition.findMany({ where: { ticketId: tk.id } })).at(-1);
      expect((await t.prisma.stageRun.findUniqueOrThrow({ where: { id: review.id } })).supersededByTransitionId).toBe(transition?.id);
      const artifacts = Object.fromEntries((await t.prisma.stageArtifact.findMany({ where: { ticketId: tk.id } })).map((a) => [a.stage, a.supersededAt !== null]));
      expect(artifacts).toEqual({ kb: false, plan: false, breakdown: true, review: true });
    });

    it('keeps runs and outputs: nothing is deleted, only marked', async () => {
      const tk = await journey();
      await run(tk.id, 'plan');
      await run(tk.id, 'review');
      await rerun(tk.id, { stage: 'PLANNING' }).expect(200);
      expect(await t.prisma.stageRun.count({ where: { ticketId: tk.id } })).toBe(2);
      expect(await t.prisma.stageRun.count({ where: { ticketId: tk.id, supersededAt: { not: null } } })).toBe(2);
    });

    it('records where the stale code starts: the earliest stale run that wrote code', async () => {
      const tk = await journey();
      await run(tk.id, 'tests', { startSha: 'start-a', endSha: 'x1', startedAt: ago(20) });
      await run(tk.id, 'implement', { startSha: 'x1', endSha: 'x2', startedAt: ago(10) });
      await run(tk.id, 'review'); // read-only: no sha
      await rerun(tk.id, { stage: 'PLANNING', note: 'again' }).expect(200);
      expect(await reload(tk.id)).toMatchObject({ revertFromSha: 'start-a', revertStage: 'PLANNING' });
    });

    it('sets nothing to revert when no code was written, and keeps an earlier pending revert', async () => {
      const none = await journey();
      await run(none.id, 'plan');
      await rerun(none.id, { stage: 'PLANNING' }).expect(200);
      expect((await reload(none.id)).revertFromSha).toBeNull();
      const pending = await journey('REVIEW', { revertFromSha: 'older-sha', revertStage: 'KB' });
      await run(pending.id, 'implement', { startSha: 'newer-sha', endSha: 'x' });
      await rerun(pending.id, { stage: 'PLANNING' }).expect(200);
      expect((await reload(pending.id)).revertFromSha).toBe('older-sha');
    });

    it('dismisses what was waiting for a person about the stale work, and the new run raises its own', async () => {
      const t2 = await journey();
      await raiser.raise({ kind: 'question', ticketId: t2.id, title: 'Which db?', body: 'q', stage: 'plan', dedupeKey: `q:${t2.id}` });
      await raiser.raise({ kind: 'open_question', ticketId: t2.id, title: 'Which repo?', body: 'q', stage: 'plan', dedupeKey: `oq:${t2.id}` });
      await rerun(t2.id, { stage: 'PLANNING' }).expect(200);
      const mine = await t.prisma.supportTicket.findMany({ where: { ticketId: t2.id, kind: { in: ['question', 'open_question'] } } });
      expect(mine.map((x) => [x.kind, x.status, x.resolvedBy]).sort()).toEqual([['open_question', 'dismissed', 'system'], ['question', 'dismissed', 'system']]);
    });

    it('rerunning the plan puts the ticket back at planning with the ordinary flow ahead of it, and approvals work again', async () => {
      const tk = await journey('REVIEW');
      await rerun(tk.id, { stage: 'PLANNING' }).expect(200);
      await states.transition(tk.id, 'AWAITING_PLAN_APPROVAL', 'system', 'Plan ready');
      const approval = await t.prisma.supportTicket.findFirstOrThrow({ where: { ticketId: tk.id, kind: 'approval', status: 'open' } });
      expect(approval.title).toContain('Approve the plan');
    });

    it('the breakdown rerun deletes the subtask rows; the implementation rerun resets them to pending', async () => {
      const a = await journey();
      await t.prisma.subtask.create({ data: { ticketId: a.id, seq: 1, title: 's', description: 'd', acceptanceCriteria: [], files: [], dependsOn: [], status: 'DONE', testCommit: 'abc', featCommit: 'def', testFiles: ['x.test.ts'] } });
      await rerun(a.id, { stage: 'BREAKDOWN' }).expect(200);
      expect(await t.prisma.subtask.count({ where: { ticketId: a.id } })).toBe(0);

      const b = await journey();
      await t.prisma.subtask.create({ data: { ticketId: b.id, seq: 1, title: 's', description: 'd', acceptanceCriteria: [], files: [], dependsOn: [], status: 'DONE', testCommit: 'abc', featCommit: 'def', testFiles: ['x.test.ts'], fixRounds: 2 } });
      await rerun(b.id, { stage: 'IN_PROGRESS', note: 'keep it simple' }).expect(200);
      expect(await t.prisma.subtask.findFirstOrThrow({ where: { ticketId: b.id } })).toMatchObject({ status: 'PENDING', testCommit: null, featCommit: null, testFiles: [], fixRounds: 0, lastFailure: expect.stringContaining('keep it simple') });
    });

    it('a review or earlier rerun resets the review loop: round zero, old findings closed', async () => {
      const tk = await journey('REVIEW', { reviewRound: 2, lastReviewedSha: 'abc', ciFixDone: true, ciFixPending: true, kbUpdatePending: true });
      await t.prisma.reviewFinding.create({ data: { ticketId: tk.id, round: 2, severity: 'high', file: 'a.ts', line: 1, issue: 'bad', rule: 'r', fix: 'f' } });
      await rerun(tk.id, { stage: 'IN_PROGRESS' }).expect(200);
      expect(await reload(tk.id)).toMatchObject({ reviewRound: 0, lastReviewedSha: null, ciFixDone: false, ciFixPending: false, kbUpdatePending: false });
      expect((await t.prisma.reviewFinding.findFirstOrThrow({ where: { ticketId: tk.id } })).status).toBe('fixed');
    });
  });

  describe('Jira (outbound only)', () => {
    it('posts one marker comment with the note, and never reads Jira to decide anything', async () => {
      await setProject({ jiraMode: 'rest', jiraProjectKey: 'ABC' });
      const tk = await journey('REVIEW', { source: 'jira', externalKey: 'ABC-1' });
      await rerun(tk.id, { stage: 'PLANNING', note: 'use the existing repository' }).expect(200);
      expect(t.jira.jira.commentBodies['ABC-1']).toHaveLength(1);
      expect(t.jira.jira.commentBodies['ABC-1']?.[0]).toContain('Rerun of PLANNING requested: use the existing repository');
      expect(t.jira.jira.commentBodies['ABC-1']?.[0]).toMatch(/\[sdlc-agent:R-\d+:rerun-PLANNING:[0-9a-f]{8}\]/);
    });

    it('a Jira problem is a warning and never blocks the rerun', async () => {
      await setProject({ jiraMode: 'rest', jiraProjectKey: 'ABC' });
      const tk = await journey('REVIEW', { source: 'jira', externalKey: 'ABC-2' });
      t.jira.jira.failWith = new Error('Jira 503');
      await rerun(tk.id, { stage: 'PLANNING' }).expect(200);
      t.jira.jira.failWith = null;
      expect((await reload(tk.id)).status).toBe('PLANNING');
      expect((await t.prisma.event.findMany({ where: { ticketId: tk.id, level: 'warn' } })).some((e) => e.message.includes('Jira failed: Jira 503'))).toBe(true);
    });

    it('a pasted ticket, or a project with comments off, gets no comment', async () => {
      await setProject({ jiraMode: 'rest', jiraProjectKey: 'ABC', settings: { jiraWriteBack: { comments: false } } });
      const tk = await journey('REVIEW', { source: 'jira', externalKey: 'ABC-3' });
      await rerun(tk.id, { stage: 'PLANNING' }).expect(200);
      expect(t.jira.jira.commentBodies['ABC-3']).toBeUndefined();
    });
  });

  describe('the loop guard', () => {
    it('lets a person rerun the same stage up to the limit, then holds the ticket with loop_limit and a support ticket', async () => {
      await setProject({ settings: { loopLimits: { userRerun: 2 } } });
      const tk = await journey('REVIEW');
      for (let i = 0; i < 2; i++) {
        await rerun(tk.id, { stage: 'PLANNING' }).expect(200);
        for (const s of ['AWAITING_PLAN_APPROVAL', 'BREAKDOWN', 'AWAITING_BREAKDOWN_APPROVAL', 'IN_PROGRESS', 'REVIEW'] as TicketStatus[]) await states.transition(tk.id, s, 'system', 'on');
      }
      const res = await rerun(tk.id, { stage: 'PLANNING' }).expect(409);
      expect(res.body.message).toContain('The limit of 2 rounds for rerunning the same stage (PLANNING) was reached');
      expect(await reload(tk.id)).toMatchObject({ status: 'ON_HOLD', holdReason: 'loop_limit' });
      expect(await t.prisma.supportTicket.findFirstOrThrow({ where: { ticketId: tk.id, kind: 'hold', status: 'open' } })).toMatchObject({ priority: 'blocking' });
      // Another stage has its own count.
      await states.resume(tk.id, 'user', 'carry on');
      await rerun(tk.id, { stage: 'KB' }).expect(200);
    });

    it('counts reruns per stage, and a held ticket over the limit gets a support ticket without a second hold', async () => {
      await setProject({ settings: { loopLimits: { userRerun: 1 } } });
      const tk = await journey('REVIEW');
      await rerun(tk.id, { stage: 'BREAKDOWN' }).expect(200);
      for (const s of ['AWAITING_BREAKDOWN_APPROVAL', 'IN_PROGRESS', 'REVIEW'] as TicketStatus[]) await states.transition(tk.id, s, 'system', 'on');
      await states.hold(tk.id, 'needs_help', 'system', 'stuck');
      await rerun(tk.id, { stage: 'BREAKDOWN' }).expect(409);
      expect((await reload(tk.id)).status).toBe('ON_HOLD');
      expect(await t.prisma.supportTicket.count({ where: { ticketId: tk.id, dedupeKey: `loop:${tk.id}:BREAKDOWN` } })).toBe(1);
    });
  });

  describe('which runs a rerun marks as started by a person', () => {
    it('the first run after a user rerun is `user`; the next ones are `auto`', async () => {
      const tk = await journey('REVIEW');
      const store = new PrismaStageRunStore(t.prisma);
      const first = await store.create({ projectId, ticketId: tk.id, stage: 'plan', model: 'm', attempt: 1, round: 0 });
      expect((await t.prisma.stageRun.findUniqueOrThrow({ where: { id: first } })).trigger).toBe('auto'); // not after a rerun
      await t.prisma.stageRun.update({ where: { id: first }, data: { status: 'succeeded', startedAt: ago(5), endedAt: ago(4) } });
      await rerun(tk.id, { stage: 'PLANNING' }).expect(200);
      const afterRerun = await store.create({ projectId, ticketId: tk.id, stage: 'plan', model: 'm', attempt: 1, round: 0 });
      expect((await t.prisma.stageRun.findUniqueOrThrow({ where: { id: afterRerun } })).trigger).toBe('user');
      await t.prisma.stageRun.update({ where: { id: afterRerun }, data: { startedAt: new Date() } });
      const second = await store.create({ projectId, ticketId: tk.id, stage: 'plan', model: 'm', attempt: 2, round: 0 });
      expect((await t.prisma.stageRun.findUniqueOrThrow({ where: { id: second } })).trigger).toBe('auto');
    });
  });

  describe('the transition history', () => {
    it('lists the kind and note of every move', async () => {
      const tk = await journey('REVIEW');
      await rerun(tk.id, { stage: 'PLANNING', note: 'again please' }).expect(200);
      const history = (await t.agent.get(`/tickets/${tk.id}/transitions`).expect(200)).body;
      expect(history.at(-1)).toMatchObject({ kind: 'rerun', note: 'again please', actor: 'user' });
      expect(history[0]).toMatchObject({ kind: 'advance', note: null });
    });
  });
});
