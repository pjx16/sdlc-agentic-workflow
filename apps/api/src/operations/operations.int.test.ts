import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type TestApp, createTestApp } from '../testing/test-app';
import { type TestDatabase, createTestDatabase } from '../testing/test-db';
import { OperationsModule } from './operations.module';

describe('Operations API (BUILD_PLAN v1 6.4)', () => {
  let db: TestDatabase;
  let t: TestApp;
  let projectId: string;
  let n = 0;
  const ago = (min: number) => new Date(Date.now() - min * 60_000);

  beforeAll(async () => {
    db = await createTestDatabase();
    t = await createTestApp(db.url, [OperationsModule]);
    projectId = (await t.prisma.project.create({ data: { name: 'p', repoUrl: 'https://x/y', stack: 'ts_node', testCmdTemplate: 'x {files}', localKeyPrefix: 'P', mirrorStatus: 'ok' } })).id;
  }, 180_000);
  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });
  beforeEach(async () => {
    await t.prisma.event.deleteMany();
    await t.prisma.stageRun.deleteMany();
    await t.prisma.ticket.deleteMany();
    await t.prisma.workerStatus.deleteMany();
  });

  const ticket = (status: string, updatedMinAgo: number) =>
    t.prisma.ticket.create({ data: { projectId, key: `P-${++n}`, source: 'paste', title: 't', status: status as never, updatedAt: ago(updatedMinAgo) } });
  const run = (stage: string, over: Record<string, unknown> = {}) =>
    t.prisma.stageRun.create({ data: { projectId, stage, model: 'sonnet', status: 'succeeded', startedAt: ago(30), endedAt: ago(28), inputTokens: 100, outputTokens: 50, costUsd: 0.1, ...over } as never });

  it('requires a session', async () => {
    await t.anonymous.get('/operations').expect(401);
  });

  it('reports the worker state, uptime, restarts and queue depth', async () => {
    await t.prisma.workerStatus.create({ data: { heartbeatAt: new Date(), tickOutcome: 'stepped', phase: 'stage', phaseDetail: 'implement on P-1', phaseSince: ago(2), startedAt: ago(90), pid: 1, version: '1.0.0' } });
    await t.prisma.event.createMany({ data: [{ type: 'worker', message: 'Worker started (version 1.0.0, pid 1)', at: ago(90) }, { type: 'worker', message: 'Worker started (version 1.0.0, pid 2)', at: ago(300) }] });
    await ticket('KB', 1);
    await ticket('IN_PROGRESS', 1);
    await ticket('AWAITING_PLAN_APPROVAL', 1);
    const body = (await t.agent.get('/operations').expect(200)).body;
    expect(body.worker).toMatchObject({ state: 'busy', phase: 'stage', phaseDetail: 'implement on P-1', restarts24h: 2, queueDepth: 2 });
    expect(body.worker.uptimeSec).toBeGreaterThan(89 * 60);
  });

  it('says the worker is unknown before it ever reported, and offline when its heartbeat is stale', async () => {
    expect((await t.agent.get('/operations').expect(200)).body.worker.state).toBe('unknown');
    await t.prisma.workerStatus.create({ data: { heartbeatAt: ago(10), tickOutcome: 'idle', phase: 'idle' } });
    const w = (await t.agent.get('/operations').expect(200)).body.worker;
    expect(w.state).toBe('offline');
    expect(w.uptimeSec).toBeNull();
  });

  it('lists stuck tickets: actionable after 30 minutes with no run, awaiting a person after 24 hours', async () => {
    const stuck = await ticket('IN_PROGRESS', 50);
    const running = await ticket('IN_PROGRESS', 50);
    await run('implement', { ticketId: running.id, status: 'running', endedAt: null });
    await ticket('IN_PROGRESS', 5);
    const old = await ticket('AWAITING_PLAN_APPROVAL', 26 * 60);
    await ticket('AWAITING_PLAN_APPROVAL', 60);
    await ticket('DONE', 99999);
    const body = (await t.agent.get('/operations').expect(200)).body;
    expect(body.stuck.map((s: { key: string }) => s.key).sort()).toEqual([old.key, stuck.key].sort());
  });

  it('computes failure rates by stage and code for 24 hours and 7 days, and load by stage', async () => {
    await run('implement', { status: 'failed', errorCode: 'CLAUDE_API_ERROR', errorSource: 'claude' });
    await run('implement', { status: 'failed', errorCode: 'TIMEOUT', errorSource: 'workspace', attempt: 2 });
    await run('implement');
    await run('plan', { startedAt: ago(3 * 24 * 60), endedAt: ago(3 * 24 * 60 - 2), status: 'failed', errorCode: 'INVALID_OUTPUT', errorSource: 'agent' });
    const body = (await t.agent.get('/operations').expect(200)).body;
    expect(body.failures.last24h.byStage).toHaveLength(1);
    expect(body.failures.last24h.byStage[0]).toMatchObject({ stage: 'implement', runs: 3, failed: 2 });
    expect(body.failures.last24h.byCode.map((c: { code: string }) => c.code).sort()).toEqual(['CLAUDE_API_ERROR', 'TIMEOUT']);
    expect(body.failures.last7d.byStage.map((s: { stage: string }) => s.stage).sort()).toEqual(['implement', 'plan']);
    expect(body.load.find((l: { stage: string }) => l.stage === 'implement')).toMatchObject({ runs: 3, retries: 1, avgDurationSec: 120, avgTokens: 150 });
  });

  it('computes error rates per outside system and lists the 20 newest errors with their tickets', async () => {
    const k = await ticket('KB', 1);
    await run('plan', { status: 'failed', errorCode: 'CLAUDE_AUTH', errorSource: 'claude' });
    await run('plan');
    await t.prisma.event.createMany({
      data: [
        { type: 'jira', source: 'jira', level: 'info', message: 'ok' },
        { type: 'jira', source: 'jira', level: 'warn', message: 'Jira failed: 503' },
        { type: 'error', source: 'github', level: 'error', message: 'GitHub failed', ticketId: k.id, errorCode: 'GITHUB_ERROR' },
        ...Array.from({ length: 25 }, (_, i) => ({ type: 'error', source: 'agent', level: 'error', message: `boom ${i}`, at: ago(i) })),
      ],
    });
    const body = (await t.agent.get('/operations').expect(200)).body;
    const by = Object.fromEntries(body.integrations.map((i: { source: string }) => [i.source, i]));
    expect(by.claude).toMatchObject({ total: 2, errors: 1, rate: 0.5 });
    expect(by.jira).toMatchObject({ total: 2, errors: 1 });
    expect(by.github).toMatchObject({ total: 1, errors: 1 });
    expect(body.orchestrator).toEqual({ decisions: 0, fallbacks: 0, fallbackRate: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 });
    expect(body.recentErrors).toHaveLength(20);
    expect(body.recentErrors.find((e: { errorCode: string }) => e.errorCode === 'GITHUB_ERROR')).toMatchObject({ ticketKey: k.key });
  });
});
