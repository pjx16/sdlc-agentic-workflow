import 'reflect-metadata';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { StageEnvelope } from '@sdlc/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SupportTicket } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { type TestDatabase, createTestDatabase } from '../../testing/test-db';
import type { StageRequest, StageResult } from '../agent-runner/agent-runner';
import { WorkerConfig } from '../worker-config';
import { AssistantRunner } from './assistant-runner';
import { buildContextPack, type PackDeps } from './context-pack';

describe('assistant runner and context packs (BUILD_PLAN v1 6.6)', () => {
  let db: TestDatabase;
  let prisma: PrismaService;
  let tmp: string;
  let config: WorkerConfig;
  let runner: AssistantRunner;
  let projectId: string;
  let n = 0;
  let requests: StageRequest[] = [];
  let next: () => StageResult;

  const done = (reply: string, draft: { kind: string; text: string } | null = null, sessionId = 'sess-1'): StageResult => {
    return { kind: 'done', stageRunId: `will-be-replaced`, attempts: 1, envelope: { status: 'done', summary: 's', data: { reply, draft } } as StageEnvelope, ...({ sessionId } as object) } as StageResult;
  };
  const deps: PackDeps = { logTail: async (_f, lines) => Array.from({ length: lines }, (_, i) => `log line ${i + 1}`).join('\n'), featureDoc: async () => '# Feature doc\nbookings', previousPlan: async () => '## Goal\nOld goal' };

  const ticket = (over: Record<string, unknown> = {}) => prisma.ticket.create({ data: { projectId, key: `A-${++n}`, source: 'paste', title: 'Export bookings', body: 'Please add a CSV export.\n\nSecond paragraph.', status: 'PLANNING', planMarkdown: '## Goal\nNew goal', ...over } });
  const support = (ticketId: string, over: Record<string, unknown> = {}) =>
    prisma.supportTicket.create({ data: { kind: 'question', title: 'Which delimiter?', body: 'Which delimiter?', ticketId, projectId, stage: 'plan', ...over } as never });
  const conversation = async (st: SupportTicket, text = 'What should I answer?') => {
    const c = await prisma.assistantConversation.create({ data: { supportTicketId: st.id, pendingAt: new Date(), messageCount: 1 } });
    await prisma.assistantMessage.create({ data: { conversationId: c.id, role: 'user', text } });
    return c;
  };
  const messages = (conversationId: string) => prisma.assistantMessage.findMany({ where: { conversationId }, orderBy: { at: 'asc' } });

  beforeAll(async () => {
    db = await createTestDatabase();
    process.env.DATABASE_URL = db.url;
    prisma = new PrismaService();
    await prisma.onModuleInit();
    tmp = mkdtempSync(path.join(tmpdir(), 'sdlc-assist-'));
    config = new WorkerConfig({ DATA_DIR: path.join(tmp, 'data'), DATABASE_URL: db.url } as NodeJS.ProcessEnv);
    projectId = (await prisma.project.create({ data: { name: 'p', repoUrl: 'https://x/y', stack: 'nestjs', testCmdTemplate: 'x {files}', localKeyPrefix: 'P', mirrorStatus: 'ok' } })).id;
    mkdirSync(config.mirrorPath(projectId), { recursive: true });
    const fake = {
      async run(req: StageRequest): Promise<StageResult> {
        requests.push(req);
        const r = next() as StageResult & { sessionId?: string };
        const run = await prisma.stageRun.create({ data: { projectId, ticketId: req.ticketId, stage: 'assist', model: 'm', status: 'succeeded', inputTokens: 100, outputTokens: 50, sessionId: r.sessionId ?? null } });
        return { ...r, stageRunId: run.id } as StageResult;
      },
    };
    runner = new AssistantRunner(prisma, config, fake as never);
    runner.deps = deps;
  }, 180_000);
  afterAll(async () => {
    await prisma?.onModuleDestroy();
    await db?.drop();
    rmSync(tmp, { recursive: true, force: true });
  });
  beforeEach(async () => {
    requests = [];
    next = () => done('Use a comma.');
    await prisma.assistantConversation.deleteMany();
    await prisma.globalSettings.deleteMany();
    await prisma.project.update({ where: { id: projectId }, data: { settings: {} } });
  });

  describe('context packs hold only their listed parts', () => {
    const headings = async (st: SupportTicket) => (await buildContextPack(prisma, st, deps)).sections.map((s) => s.heading);

    it('plan approval: summary, plan, plan diff, feature doc, open questions', async () => {
      const t = await ticket();
      await support(t.id, { kind: 'open_question', title: 'Which repository?', body: 'Which repository?', priority: 'normal', defaultAnswer: 'a new one' });
      const st = await support(t.id, { kind: 'approval', stage: 'plan', title: 'Approve the plan' });
      expect(await headings(st)).toEqual(['Ticket summary', 'Current plan', 'Plan diff', 'Feature doc', 'Open questions']);
      const pack = await buildContextPack(prisma, st, deps);
      expect(pack.sections.find((s) => s.heading === 'Plan diff')?.body).toBe('- Old goal\n+ New goal');
      expect(pack.sections.find((s) => s.heading === 'Open questions')?.body).toContain('the plan assumed: a new one');
    });

    it('plan approval without an earlier version has no diff', async () => {
      const t = await ticket();
      const st = await support(t.id, { kind: 'approval', stage: 'plan' });
      const pack = await buildContextPack(prisma, st, { ...deps, previousPlan: async () => null });
      expect(pack.sections.map((s) => s.heading)).not.toContain('Plan diff');
    });

    it('breakdown approval: summary, acceptance criteria and subtasks, and no plan text', async () => {
      const t = await ticket();
      await prisma.subtask.create({ data: { ticketId: t.id, seq: 1, title: 'Add parser', description: 'Parse it', acceptanceCriteria: ['It parses CSV', 'It rejects junk'], files: [], dependsOn: [] } });
      const st = await support(t.id, { kind: 'approval', stage: 'breakdown' });
      const pack = await buildContextPack(prisma, st, deps);
      expect(pack.sections.map((s) => s.heading)).toEqual(['Ticket summary', 'Acceptance criteria', 'Subtasks']);
      expect(pack.text).toContain('It parses CSV');
      expect(pack.text).not.toContain('New goal');
    });

    it('a question: the question, the asking stage, the plan section and the feature doc', async () => {
      const t = await ticket();
      const run = await prisma.stageRun.create({ data: { projectId, ticketId: t.id, stage: 'plan', model: 'm', status: 'needs_input', resultJson: { summary: 'I need the delimiter' } } });
      const st = await support(t.id, { stageRunId: run.id });
      expect(await headings(st)).toEqual(['Question', 'Asking stage', 'Plan section', 'Feature doc']);
      expect((await buildContextPack(prisma, st, deps)).sections[1]?.body).toBe('plan: I need the delimiter');
    });

    it('a hold: the error, the last 60 log lines and the stage inputs', async () => {
      const t = await ticket();
      const run = await prisma.stageRun.create({ data: { projectId, ticketId: t.id, stage: 'implement', model: 'm', status: 'failed', errorCode: 'TIMEOUT', error: 'implement took longer than 20 minutes.', logPath: '/x/run.log', round: 2 } });
      const st = await support(t.id, { kind: 'hold', stage: 'implement', stageRunId: run.id, title: 'on hold', body: 'It is on hold.' });
      const pack = await buildContextPack(prisma, st, deps);
      expect(pack.sections.map((s) => s.heading)).toEqual(['Why it needs you', 'Error', 'Last 60 lines of the log', 'Stage inputs']);
      expect(pack.text).toContain('TIMEOUT: implement took longer than 20 minutes.');
      expect(pack.text).toContain('log line 60');
      expect(pack.text).not.toContain('log line 61');
      expect(pack.text).toContain('fix round 2');
    });

    it('anything else gets only its own title and text', async () => {
      const st = await prisma.supportTicket.create({ data: { kind: 'credential', title: 'Claude rejected the credential', body: 'Update it.', stage: '' } });
      expect(await headings(st)).toEqual(['Ticket']);
    });
  });

  describe('answering', () => {
    it('answers the waiting message, stores a draft, adds the tokens and keeps the session', async () => {
      const t = await ticket();
      const st = await support(t.id);
      const c = await conversation(st);
      next = () => done('Use a comma, it is the default.', { kind: 'answer', text: 'Comma' }, 'sess-9');
      expect(await runner.tick()).toBe('answered');
      const [, reply] = await messages(c.id);
      expect(reply).toMatchObject({ role: 'assistant', text: 'Use a comma, it is the default.', draft: { kind: 'answer', text: 'Comma' } });
      expect(await prisma.assistantConversation.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ pendingAt: null, messageCount: 2, tokens: 150, sessionId: 'sess-9' });
      expect(requests[0]).toMatchObject({ stage: 'assist', workspacePath: config.mirrorPath(projectId), ticketId: t.id, maxTurns: 8 });
      expect(requests[0]?.inputs.assist?.pack).toContain('Which delimiter?');
      expect(requests[0]?.resumeSession).toBeUndefined();
    });

    it('continues the CLI session on the next message', async () => {
      const t = await ticket();
      const st = await support(t.id);
      const c = await conversation(st);
      await prisma.assistantConversation.update({ where: { id: c.id }, data: { sessionId: 'sess-old' } });
      await runner.tick();
      expect(requests[0]?.resumeSession).toBe('sess-old');
    });

    it('past 10 messages the older turns are summarised and a fresh session starts', async () => {
      const t = await ticket();
      const st = await support(t.id);
      const c = await prisma.assistantConversation.create({ data: { supportTicketId: st.id, sessionId: 'sess-old', messageCount: 11, pendingAt: new Date() } });
      for (let i = 1; i <= 11; i++) await prisma.assistantMessage.create({ data: { conversationId: c.id, role: i % 2 ? 'user' : 'assistant', text: `turn ${i}`, at: new Date(Date.now() - (30 - i) * 1000) } });
      await runner.tick();
      const sent = requests[0]?.inputs.assist;
      expect(sent?.summary).toContain('Person: turn 1');
      expect(sent?.history.map((m) => m.text)).toEqual(['turn 7', 'turn 8', 'turn 9', 'turn 10']);
      expect(sent?.message).toBe('turn 11'); // the latest user message, still waiting
      expect(requests[0]?.resumeSession).toBeUndefined();
      expect((await prisma.assistantConversation.findUniqueOrThrow({ where: { id: c.id } })).summary).toContain('Person: turn 1');
    });

    it('is refused while the pipeline is paused for limits, and the message waits', async () => {
      const t = await ticket();
      const c = await conversation(await support(t.id));
      await prisma.globalSettings.create({ data: { id: 'global', pipelinePaused: true, pausedReason: 'Claude usage limit', pausedCode: 'CLAUDE_USAGE_LIMIT' } });
      expect(await runner.tick()).toBe('paused');
      expect(requests).toHaveLength(0);
      expect((await prisma.assistantConversation.findUniqueOrThrow({ where: { id: c.id } })).pendingAt).not.toBeNull();
      await prisma.globalSettings.update({ where: { id: 'global' }, data: { pipelinePaused: false } });
      expect(await runner.tick()).toBe('answered');
    });

    it('still answers when the pipeline was paused by hand', async () => {
      await conversation(await support((await ticket()).id));
      await prisma.globalSettings.create({ data: { id: 'global', pipelinePaused: true, pausedReason: 'manual' } });
      expect(await runner.tick()).toBe('answered');
    });

    it('answers one conversation at a time', async () => {
      const a = await conversation(await support((await ticket()).id));
      const b = await conversation(await support((await ticket()).id));
      let release: () => void = () => undefined;
      const gate = new Promise<void>((r) => (release = r));
      const slow = runner as unknown as { runner: { run: (r: StageRequest) => Promise<StageResult> } };
      const original = slow.runner.run.bind(slow.runner);
      slow.runner.run = async (r) => (await gate, original(r));
      const first = runner.tick();
      expect(await runner.tick()).toBe('busy');
      release();
      expect(await first).toBe('answered');
      slow.runner.run = original;
      expect(await runner.tick()).toBe('answered');
      expect(requests).toHaveLength(2);
      expect((await messages(a.id)).length + (await messages(b.id)).length).toBe(4);
    });

    it('turns a failure into a plain message and does not leave the chat waiting', async () => {
      const c = await conversation(await support((await ticket()).id));
      next = () => ({ kind: 'failed', reason: 'boom', errorCode: 'TIMEOUT', stageRunId: 'x', attempts: 2 }) as StageResult;
      await runner.tick();
      const [, reply] = await messages(c.id);
      expect(reply?.text).toContain('took longer than');
      expect((await prisma.assistantConversation.findUniqueOrThrow({ where: { id: c.id } })).pendingAt).toBeNull();
    });

    it('says so when the assistant is off for the project, or the mirror is missing', async () => {
      const c = await conversation(await support((await ticket()).id));
      await prisma.project.update({ where: { id: projectId }, data: { settings: { stages: { assist: { enabled: false } } } } });
      await runner.tick();
      expect((await messages(c.id)).at(-1)?.text).toBe('The assistant is turned off for this project.');
      expect(requests).toHaveLength(0);
    });

    it('answers a ticket with no project from what is written on it', async () => {
      const st = await prisma.supportTicket.create({ data: { kind: 'credential', title: 'Claude rejected the credential', body: 'b', stage: '' } });
      const c = await conversation(st, 'what now?');
      await runner.tick();
      expect((await messages(c.id)).at(-1)?.text).toContain('not about a project');
    });
  });
});
