import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { StageEnvelope } from '@sdlc/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { allArtifacts, currentArtifact, latestArtifact, writeArtifact } from '../common/artifacts';
import { StateMachine } from '../state/state-machine.service';
import { FakeJiraClients } from '../testing/fake-jira';
import { type TestApp, createTestApp } from '../testing/test-app';
import { type TestDatabase, createTestDatabase } from '../testing/test-db';
import type { StageRequest, StageResult } from '../worker/agent-runner/agent-runner';
import { PlanHandler } from '../worker/pipeline/plan.handler';
import { StageLauncher } from '../worker/pipeline/stage-launcher';
import { StageOutcomes } from '../worker/pipeline/stage-outcomes';
import { WorkerConfig } from '../worker/worker-config';
import { TicketsModule } from './tickets.module';

describe('Versioned outputs and rerun context (BUILD_PLAN v1 6.8)', () => {
  let db: TestDatabase;
  let t: TestApp;
  let states: StateMachine;
  let projectId: string;
  let n = 0;
  let tmp: string;
  let requests: StageRequest[] = [];
  let launcher: StageLauncher;
  let handler: PlanHandler;
  let answer: StageEnvelope;
  const FORWARD = ['KB', 'PLANNING', 'AWAITING_PLAN_APPROVAL', 'BREAKDOWN', 'AWAITING_BREAKDOWN_APPROVAL', 'IN_PROGRESS', 'REVIEW'] as const;

  const ticket = async (to: (typeof FORWARD)[number] = 'PLANNING', over: Record<string, unknown> = {}) => {
    const tk = await t.prisma.ticket.create({ data: { projectId, key: `V-${++n}`, source: 'paste', title: 'Export bookings', body: 'CSV please', status: 'NEW', ...over } });
    for (const s of FORWARD.slice(0, FORWARD.indexOf(to) + 1)) await states.transition(tk.id, s, 'system', 'on');
    return tk;
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    t = await createTestApp(db.url, [TicketsModule]);
    states = t.app.get(StateMachine);
    projectId = (await t.prisma.project.create({ data: { name: 'p', repoUrl: 'https://x/y', stack: 'ts_node', testCmdTemplate: 'x {files}', localKeyPrefix: 'V', mirrorStatus: 'ok' } })).id;
    tmp = mkdtempSync(path.join(tmpdir(), 'sdlc-art-'));
    const config = new WorkerConfig({ DATA_DIR: path.join(tmp, 'data'), DATABASE_URL: db.url } as NodeJS.ProcessEnv);
    const runner = {
      async run(req: StageRequest): Promise<StageResult> {
        requests.push(req);
        const run = await t.prisma.stageRun.create({ data: { projectId, ticketId: req.ticketId, stage: req.stage, model: 'm', status: 'succeeded' } });
        return { kind: 'done', envelope: answer, stageRunId: run.id, attempts: 1 };
      },
    };
    launcher = new StageLauncher(t.prisma, config, runner as never);
    handler = new PlanHandler(t.prisma, launcher, new StageOutcomes(t.prisma), new FakeJiraClients());
  }, 180_000);
  afterAll(async () => {
    await t?.close();
    await db?.drop();
    rmSync(tmp, { recursive: true, force: true });
  });
  beforeEach(() => {
    requests = [];
    answer = { status: 'done', summary: 'plan', data: { planMarkdown: '## Goal\nNew plan', risks: [], openQuestions: [] } } as never;
  });

  describe('artifact versions', () => {
    it('every write is a new version, never an overwrite, and each stage counts on its own', async () => {
      const tk = await ticket();
      const a = await writeArtifact(t.prisma, tk.id, 'plan', { planMarkdown: 'v1' });
      const b = await writeArtifact(t.prisma, tk.id, 'plan', { planMarkdown: 'v2' });
      const c = await writeArtifact(t.prisma, tk.id, 'breakdown', { subtasks: [] });
      expect([a.version, b.version, c.version]).toEqual([1, 2, 1]);
      expect((await currentArtifact(t.prisma, tk.id, 'plan'))?.data).toEqual({ planMarkdown: 'v2' });
      expect((await allArtifacts(t.prisma, tk.id)).map((x) => `${x.stage}${x.version}`)).toEqual(['breakdown1', 'plan1', 'plan2']);
    });

    it('the current output is the latest version that is not stale; the stale one is still the latest for context', async () => {
      const tk = await ticket();
      await writeArtifact(t.prisma, tk.id, 'plan', { planMarkdown: 'v1' });
      await writeArtifact(t.prisma, tk.id, 'plan', { planMarkdown: 'v2' });
      await t.prisma.stageArtifact.updateMany({ where: { ticketId: tk.id, stage: 'plan', version: 2 }, data: { supersededAt: new Date() } });
      expect((await currentArtifact(t.prisma, tk.id, 'plan'))?.version).toBe(1);
      expect((await latestArtifact(t.prisma, tk.id, 'plan'))?.version).toBe(2);
      await t.prisma.stageArtifact.updateMany({ where: { ticketId: tk.id }, data: { supersededAt: new Date() } });
      expect(await currentArtifact(t.prisma, tk.id, 'plan')).toBeNull();
    });

    it('two writers at once end up with different versions', async () => {
      const tk = await ticket();
      const results = await Promise.all([1, 2, 3, 4].map((i) => writeArtifact(t.prisma, tk.id, 'review', { round: i })));
      expect(results.map((r) => r.version).sort()).toEqual([1, 2, 3, 4]);
    });

    it('the plan stage stores each plan it writes as a version, with the run that made it', async () => {
      const tk = await ticket('PLANNING');
      await handler.run(tk);
      answer = { status: 'done', summary: 'plan', data: { planMarkdown: '## Goal\nSecond plan', risks: [], openQuestions: [] } } as never;
      await handler.run(tk);
      const versions = await t.prisma.stageArtifact.findMany({ where: { ticketId: tk.id, stage: 'plan' }, orderBy: { version: 'asc' } });
      expect(versions.map((v) => (v.data as { planMarkdown: string }).planMarkdown)).toEqual(['## Goal\nNew plan', '## Goal\nSecond plan']);
      expect(versions.every((v) => v.stageRunId !== null)).toBe(true);
    });

    it('a plan the person edits when approving is a new version with who edited it', async () => {
      const tk = await ticket('AWAITING_PLAN_APPROVAL' as never, { planMarkdown: '# original' });
      await t.agent.post(`/tickets/${tk.id}/plan/approve`).send({ planMarkdown: '# edited' }).expect(200);
      const last = await latestArtifact(t.prisma, tk.id, 'plan');
      expect(last).toMatchObject({ version: 1, data: { planMarkdown: '# edited', editedBy: 'user' }, stageRunId: null });
    });

    it('GET /tickets/:id/artifacts lists every version, stale ones marked', async () => {
      const tk = await ticket();
      await writeArtifact(t.prisma, tk.id, 'plan', { planMarkdown: 'v1' });
      await writeArtifact(t.prisma, tk.id, 'plan', { planMarkdown: 'v2' });
      await t.prisma.stageArtifact.updateMany({ where: { ticketId: tk.id, version: 1 }, data: { supersededAt: new Date() } });
      const res = (await t.agent.get(`/tickets/${tk.id}/artifacts`).expect(200)).body;
      expect(res.map((a: { version: number; stale: boolean }) => [a.version, a.stale])).toEqual([[1, true], [2, false]]);
      await t.anonymous.get(`/tickets/${tk.id}/artifacts`).expect(401);
      await t.agent.get('/tickets/00000000-0000-0000-0000-000000000000/artifacts').expect(404);
    });
  });

  describe('the stage sees the note and its previous output after a rerun', () => {
    it('the plan stage gets the previous plan and the rerun note, even from a rerun that started far later in the flow', async () => {
      const tk = await ticket('REVIEW', { planMarkdown: '## Goal\nThe old plan' });
      await t.agent.post(`/tickets/${tk.id}/rerun`).send({ stage: 'PLANNING', note: 'use the existing booking repository' }).expect(200);
      await handler.run(await t.prisma.ticket.findUniqueOrThrow({ where: { id: tk.id } }));
      expect(requests[0]?.inputs).toMatchObject({ previousPlan: '## Goal\nThe old plan', rejectionNote: 'use the existing booking repository' });
    });

    it('a rerun without a note still tells the stage it is a rerun', async () => {
      const tk = await ticket('REVIEW', { planMarkdown: '# old' });
      await t.agent.post(`/tickets/${tk.id}/rerun`).send({ stage: 'PLANNING' }).expect(200);
      await handler.run(await t.prisma.ticket.findUniqueOrThrow({ where: { id: tk.id } }));
      expect(requests[0]?.inputs.rejectionNote).toBe('The developer asked for the plan to be redone.');
    });

    it('a first run, or a resume, is not treated as a rerun', async () => {
      const tk = await ticket('PLANNING', { planMarkdown: '# old' });
      await handler.run(tk);
      expect(requests[0]?.inputs.rejectionNote).toBeUndefined();
      expect(requests[0]?.inputs.rerun).toBeUndefined();
    });

    it('the other stages get the note through the launcher, until the ticket moves on', async () => {
      const tk = await ticket('REVIEW');
      await t.agent.post(`/tickets/${tk.id}/rerun`).send({ stage: 'IN_PROGRESS', note: 'keep it small' }).expect(200);
      const ticketNow = await t.prisma.ticket.findUniqueOrThrow({ where: { id: tk.id } });
      await launcher.launch(ticketNow, 'implement', { ticket: { key: tk.key, title: 't', body: 'b' } }, { workspacePath: tmp });
      await launcher.launch(ticketNow, 'fix', { failureOutput: 'x' }, { workspacePath: tmp });
      expect(requests.map((r) => r.inputs.rerun)).toEqual([{ note: 'keep it small' }, { note: 'keep it small' }]);
      // Moved on, and then back by an ordinary move: no longer a rerun.
      await states.transition(tk.id, 'REVIEW', 'system', 'done');
      await states.transition(tk.id, 'KB_UPDATE', 'system', 'done');
      await launcher.launch(await t.prisma.ticket.findUniqueOrThrow({ where: { id: tk.id } }), 'kbUpdate', { diff: 'x' }, { workspacePath: tmp });
      expect(requests.at(-1)?.inputs.rerun).toBeUndefined();
    });

    it('does not add a second rerun section where the plan or breakdown stage already carries the note', async () => {
      const tk = await ticket('REVIEW', { planMarkdown: '# old' });
      await t.agent.post(`/tickets/${tk.id}/rerun`).send({ stage: 'PLANNING', note: 'again' }).expect(200);
      await launcher.launch(await t.prisma.ticket.findUniqueOrThrow({ where: { id: tk.id } }), 'plan', { ticket: { key: tk.key, title: 't', body: 'b' } }, { workspacePath: tmp });
      expect(requests[0]?.inputs.rerun).toBeUndefined();
    });
  });

  describe('legal moves', () => {
    it('GET /tickets/:id/moves lists what can be done, reruns included, from the history', async () => {
      const tk = await ticket('REVIEW');
      const moves = (await t.agent.get(`/tickets/${tk.id}/moves`).expect(200)).body as { kind: string; to: string }[];
      expect(moves.filter((m) => m.kind === 'rerun').map((m) => m.to)).toEqual(['KB', 'PLANNING', 'BREAKDOWN', 'IN_PROGRESS']);
      expect(moves.map((m) => `${m.kind}:${m.to}`)).toContain('advance:KB_UPDATE');
      await t.anonymous.get(`/tickets/${tk.id}/moves`).expect(401);
    });

    it('after a rerun only the stages that are complete again are offered', async () => {
      const tk = await ticket('REVIEW');
      await t.agent.post(`/tickets/${tk.id}/rerun`).send({ stage: 'BREAKDOWN' }).expect(200);
      const moves = (await t.agent.get(`/tickets/${tk.id}/moves`).expect(200)).body as { kind: string; to: string }[];
      expect(moves.filter((m) => m.kind === 'rerun').map((m) => m.to)).toEqual(['KB', 'PLANNING']);
    });
  });
});
