import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { StageEnvelope } from '@sdlc/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../../prisma/prisma.service';
import { SubtasksService } from '../../subtasks/subtasks.service';
import { FakeJira, FakeJiraClients } from '../../testing/fake-jira';
import { type TestDatabase, createTestDatabase } from '../../testing/test-db';
import type { StageRequest, StageResult } from '../agent-runner/agent-runner';
import { WorkerConfig } from '../worker-config';
import { BreakdownHandler } from './breakdown.handler';
import { StageLauncher } from './stage-launcher';
import { StageOutcomes } from './stage-outcomes';

const st = (seq: number, over: Record<string, unknown> = {}) => ({ seq, title: `Subtask ${seq}`, description: 'd', acceptanceCriteria: ['works'], files: ['src/a.ts'], dependsOn: [] as number[], ...over });
const answer = (subtasks: unknown): StageEnvelope => ({ status: 'done', summary: 'split', data: { subtasks } as never });

describe('breakdown stage (F8)', () => {
  let db: TestDatabase;
  let prisma: PrismaService;
  let tmp: string;
  let handler: BreakdownHandler;
  let jira: FakeJira;
  let projectId: string;
  let n = 0;
  let requests: StageRequest[] = [];
  let reply: StageEnvelope;
  let failWith: StageResult | null = null;

  const ticket = (over: Record<string, unknown> = {}) => prisma.ticket.create({ data: { projectId, key: `K-${++n}`, source: 'paste', title: 'Export', body: 'body', status: 'BREAKDOWN', planMarkdown: '# Approved plan', ...over } });

  beforeAll(async () => {
    db = await createTestDatabase();
    process.env.DATABASE_URL = db.url;
    prisma = new PrismaService();
    await prisma.onModuleInit();
    tmp = mkdtempSync(path.join(tmpdir(), 'sdlc-bd-'));
    const config = new WorkerConfig({ DATA_DIR: path.join(tmp, 'data'), DATABASE_URL: db.url } as NodeJS.ProcessEnv);
    projectId = (await prisma.project.create({ data: { name: 'p', repoUrl: 'https://x/y', stack: 'ts_node', testCmdTemplate: 'x {files}', localKeyPrefix: 'P', mirrorStatus: 'ok' } })).id;
    // Stands in for AgentRunner: records the request, then applies the same validate hook the real one does.
    const runner = {
      async run(req: StageRequest): Promise<StageResult> {
        requests.push(req);
        if (failWith) return failWith;
        const message = req.validate?.(reply);
        return message ? { kind: 'failed', reason: `Validation failed: ${message}`, stageRunId: 'r', attempts: 2 } : { kind: 'done', envelope: reply, stageRunId: 'run-bd', attempts: 1 };
      },
    };
    const clients = new FakeJiraClients();
    jira = clients.jira;
    handler = new BreakdownHandler(prisma, new StageLauncher(prisma, config, runner as never), new StageOutcomes(prisma), new SubtasksService(prisma, clients));
  }, 180_000);
  afterAll(async () => {
    await prisma?.onModuleDestroy();
    await db?.drop();
    rmSync(tmp, { recursive: true, force: true });
  });
  beforeEach(async () => {
    requests = [];
    failWith = null;
    jira.calls = [];
    jira.failWith = null;
    reply = answer([st(1), st(2, { dependsOn: [1] })]);
    await prisma.stateTransition.deleteMany();
    await prisma.project.update({ where: { id: projectId }, data: { settings: {} } });
  });

  it('runs the stage with the plan and the limit, stores the validated list as the draft, and stops at the gate', async () => {
    const t = await ticket();
    const out = await handler.run(t);
    expect(out).toEqual({ kind: 'transition', to: 'AWAITING_BREAKDOWN_APPROVAL', reason: 'Breakdown ready for approval (2 subtasks)', stageRunId: 'run-bd' });
    expect(requests[0]).toMatchObject({ stage: 'breakdown', modelAlias: 'haiku', maxTurns: 10 });
    expect(requests[0]?.inputs).toMatchObject({ plan: '# Approved plan', maxSubtasks: 8 });
    const draft = (await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).breakdownDraft as { seq: number }[];
    expect(draft.map((s) => s.seq)).toEqual([1, 2]);
  });

  it('stores the list sorted by seq even if the model returned it out of order', async () => {
    reply = answer([st(2, { dependsOn: [1] }), st(1)]);
    const t = await ticket();
    await handler.run(t);
    expect(((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).breakdownDraft as { seq: number }[]).map((s) => s.seq)).toEqual([1, 2]);
  });

  it('uses the project limit maxSubtasks', async () => {
    await prisma.project.update({ where: { id: projectId }, data: { settings: { limits: { maxSubtasks: 2 } } } });
    reply = answer([st(1), st(2), st(3)]);
    const out = await handler.run(await ticket());
    expect(requests[0]?.inputs.maxSubtasks).toBe(2);
    expect(out).toMatchObject({ kind: 'hold', reason: 'needs_help' });
    expect((out as { note: string }).note).toContain('3 subtasks is more than the limit of 2');
  });

  describe('a rejected output counts as a failed attempt', () => {
    const rejected = async (subtasks: unknown) => {
      reply = answer(subtasks);
      const t = await ticket();
      const out = (await handler.run(t)) as { kind: string; reason?: string; note?: string };
      expect(out).toMatchObject({ kind: 'hold', reason: 'needs_help' });
      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).breakdownDraft).toBeNull(); // nothing is stored
      return out.note as string;
    };
    it('a dependency cycle or a forward dependency', async () => {
      expect(await rejected([st(1, { dependsOn: [2] }), st(2, { dependsOn: [1] })])).toContain('depends on a later subtask');
    });
    it('bad seq values', async () => {
      expect(await rejected([st(1), st(3)])).toContain('seq values must be exactly 1 to 2');
    });
    it('no acceptance criteria', async () => {
      expect(await rejected([st(1, { acceptanceCriteria: [] })])).toContain('at least one acceptance criterion');
    });
    it('an empty list', async () => {
      expect(await rejected([])).toContain('at least one subtask is required');
    });
  });

  describe('rejection re-run', () => {
    it('gives the stage the previous breakdown and the note after a rejection at the gate', async () => {
      const draft = [st(1)];
      const t = await ticket({ breakdownDraft: draft });
      await prisma.stateTransition.create({ data: { ticketId: t.id, fromStatus: 'AWAITING_BREAKDOWN_APPROVAL', toStatus: 'BREAKDOWN', actor: 'user', reason: 'Split the API from the UI' } });
      await handler.run(t);
      expect(requests[0]?.inputs.rejectionNote).toBe('Split the API from the UI');
      expect(JSON.parse(requests[0]?.inputs.previousBreakdown as string)).toEqual(draft);
    });
    it('a first run and a resume from hold are not rejections', async () => {
      await handler.run(await ticket());
      expect(requests[0]?.inputs.rejectionNote).toBeUndefined();
      const t = await ticket({ breakdownDraft: [st(1)] });
      await prisma.stateTransition.create({ data: { ticketId: t.id, fromStatus: 'ON_HOLD', toStatus: 'BREAKDOWN', actor: 'user', reason: 'resumed' } });
      await handler.run(t);
      expect(requests[1]?.inputs.rejectionNote).toBeUndefined();
    });
  });

  describe('when breakdown or its gate is off (F2, rows 7 and 8)', () => {
    const setSettings = (settings: object, extra: object = {}) => prisma.project.update({ where: { id: projectId }, data: { settings, ...extra } as never });
    const subtasksOf = (id: string) => prisma.subtask.findMany({ where: { ticketId: id }, orderBy: { seq: 'asc' } });

    it('with the gate off, creates the Subtask rows at once and goes to IN_PROGRESS', async () => {
      await setSettings({ gates: { breakdown: false } });
      const t = await ticket();
      expect(await handler.run(t)).toMatchObject({ kind: 'transition', to: 'IN_PROGRESS', reason: 'Breakdown stored; the breakdown gate is off', stageRunId: 'run-bd' });
      expect((await subtasksOf(t.id)).map((s) => [s.seq, s.title, s.status])).toEqual([[1, 'Subtask 1', 'PENDING'], [2, 'Subtask 2', 'PENDING']]);
    });

    it('with the breakdown stage off, runs the ticket as one subtask whose description is the plan, and does not run the stage', async () => {
      await setSettings({ stages: { breakdown: { enabled: false } } });
      const t = await ticket({ body: 'Add an export.\n\n## Acceptance criteria\n- Exports all rows\n- Handles empty data' });
      expect(await handler.run(t)).toMatchObject({ kind: 'transition', to: 'IN_PROGRESS', reason: 'The breakdown stage is off: one subtask runs the whole plan' });
      expect(requests).toHaveLength(0);
      const rows = await subtasksOf(t.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ seq: 1, title: 'Export', description: '# Approved plan', acceptanceCriteria: ['Exports all rows', 'Handles empty data'], dependsOn: [] });
    });

    it('with no "Acceptance criteria" section the single subtask gets the default criterion', async () => {
      await setSettings({ stages: { breakdown: { enabled: false } } });
      const t = await ticket({ body: 'Just a description.' });
      await handler.run(t);
      expect((await subtasksOf(t.id))[0]?.acceptanceCriteria).toEqual(['The change described in the ticket is implemented and tested']);
    });

    it('breakdown off falls back to the ticket body when there is no plan', async () => {
      await setSettings({ stages: { breakdown: { enabled: false } } });
      const t = await ticket({ planMarkdown: null, body: 'The body is the plan.' });
      await handler.run(t);
      expect((await subtasksOf(t.id))[0]?.description).toBe('The body is the plan.');
    });
  });

  describe('Jira sub-tasks (F8)', () => {
    const setSettings = (settings: object, extra: object = {}) => prisma.project.update({ where: { id: projectId }, data: { settings, ...extra } as never });
    const jiraTicket = () => ticket({ source: 'jira', externalKey: `ABC-${n + 100}` });

    it('creates a Jira sub-task per subtask and stores the keys, when write-back is on', async () => {
      await setSettings({ gates: { breakdown: false }, jiraSubtaskTypeName: 'Subtask' }, { jiraMode: 'rest' });
      const t = await jiraTicket();
      await handler.run(t);
      expect(jira.calls.filter((c) => c.startsWith('subtask'))).toEqual([`subtask ${t.externalKey} Subtask 1`, `subtask ${t.externalKey} Subtask 2`]);
      expect((await prisma.subtask.findMany({ where: { ticketId: t.id }, orderBy: { seq: 'asc' } })).map((s) => s.externalKey)).toEqual([`${t.externalKey}-S`, `${t.externalKey}-S`]);
    });

    it('does nothing for pasted tickets, Jira off, or write-back turned off', async () => {
      await setSettings({ gates: { breakdown: false } }, { jiraMode: 'rest' });
      await handler.run(await ticket());
      await setSettings({ gates: { breakdown: false }, jiraWriteBack: { createSubtasks: false } }, { jiraMode: 'rest' });
      await handler.run(await jiraTicket());
      await setSettings({ gates: { breakdown: false } }, { jiraMode: 'off' });
      await handler.run(await jiraTicket());
      expect(jira.calls.filter((c) => c.startsWith('subtask'))).toEqual([]);
    });

    it('a failed Jira sub-task is a recorded warning and never blocks the pipeline', async () => {
      await setSettings({ gates: { breakdown: false } }, { jiraMode: 'rest' });
      jira.failWith = new Error('Jira 400: issue type Sub-task is not valid');
      const t = await jiraTicket();
      expect(await handler.run(t)).toMatchObject({ kind: 'transition', to: 'IN_PROGRESS' });
      expect(await prisma.subtask.count({ where: { ticketId: t.id } })).toBe(2);
      const warnings = await prisma.event.findMany({ where: { ticketId: t.id, type: 'jira' } });
      expect(warnings.length).toBe(2);
      expect(warnings[0]?.message).toContain('Could not create the Jira sub-task');
    });

    it('works with breakdown off too (one Jira sub-task)', async () => {
      await setSettings({ stages: { breakdown: { enabled: false } } }, { jiraMode: 'rest' });
      const t = await jiraTicket();
      await handler.run(t);
      expect(jira.calls.filter((c) => c.startsWith('subtask'))).toHaveLength(1);
    });

    it('publishing again skips subtasks that already have a Jira key', async () => {
      await setSettings({ gates: { breakdown: false } }, { jiraMode: 'rest' });
      const t = await jiraTicket();
      await handler.run(t);
      jira.calls = [];
      expect(await new SubtasksService(prisma, new FakeJiraClients(jira)).publishToJira(t.id)).toEqual({ created: 0, failed: 0 });
      expect(jira.calls).toEqual([]);
    });
  });

  it('turns a failed or killed stage into the documented hold', async () => {
    failWith = { kind: 'turn_limit', stageRunId: 'r', attempts: 1 };
    expect(await handler.run(await ticket())).toMatchObject({ kind: 'hold', reason: 'needs_help', note: 'breakdown ran out of turns.' });
    failWith = { kind: 'killed', stageRunId: 'r', attempts: 1 };
    expect(await handler.run(await ticket())).toMatchObject({ kind: 'hold', reason: 'manual' });
  });
});
