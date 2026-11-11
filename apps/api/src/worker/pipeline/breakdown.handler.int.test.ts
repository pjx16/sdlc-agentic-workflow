import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { StageEnvelope } from '@sdlc/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../../prisma/prisma.service';
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
    handler = new BreakdownHandler(prisma, new StageLauncher(prisma, config, runner as never), new StageOutcomes(prisma));
  }, 180_000);
  afterAll(async () => {
    await prisma?.onModuleDestroy();
    await db?.drop();
    rmSync(tmp, { recursive: true, force: true });
  });
  beforeEach(async () => {
    requests = [];
    failWith = null;
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

  it('turns a failed or killed stage into the documented hold', async () => {
    failWith = { kind: 'turn_limit', stageRunId: 'r', attempts: 1 };
    expect(await handler.run(await ticket())).toMatchObject({ kind: 'hold', reason: 'needs_help', note: 'The breakdown stage reached its turn limit' });
    failWith = { kind: 'killed', stageRunId: 'r', attempts: 1 };
    expect(await handler.run(await ticket())).toMatchObject({ kind: 'hold', reason: 'manual' });
  });
});
