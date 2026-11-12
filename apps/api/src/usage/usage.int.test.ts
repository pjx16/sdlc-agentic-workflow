import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type TestApp, createTestApp } from '../testing/test-app';
import { type TestDatabase, createTestDatabase } from '../testing/test-db';
import { UsageModule } from './usage.module';

describe('Usage API (BUILD_PLAN 8)', () => {
  let db: TestDatabase;
  let t: TestApp;
  let projectId: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    t = await createTestApp(db.url, [UsageModule]);
    projectId = (await t.prisma.project.create({ data: { name: 'p', repoUrl: 'https://x/y', stack: 'ts_node', testCmdTemplate: 'x {files}', localKeyPrefix: 'P', mirrorStatus: 'ok' } })).id;
  }, 180_000);
  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });
  beforeEach(async () => {
    await t.prisma.usageSnapshot.deleteMany();
    await t.prisma.stageRun.deleteMany();
  });

  const snap = (at: string, over: Record<string, unknown> = {}) => t.prisma.usageSnapshot.create({ data: { at: new Date(at), source: 'event', ...over } });

  it('requires a session', async () => {
    await t.anonymous.get('/usage/snapshots').expect(401);
    await t.anonymous.get('/usage/summary').expect(401);
  });

  it('lists snapshots oldest first and filters by from and to', async () => {
    await snap('2026-11-10T10:00:00Z', { fiveHourPct: 10 });
    await snap('2026-11-11T10:00:00Z', { fiveHourPct: 20 });
    await snap('2026-11-12T10:00:00Z', { fiveHourPct: 30 });
    const all = await t.agent.get('/usage/snapshots').expect(200);
    expect(all.body.map((s: { fiveHourPct: number }) => s.fiveHourPct)).toEqual([10, 20, 30]);
    const some = await t.agent.get('/usage/snapshots?from=2026-11-11T00:00:00Z&to=2026-11-11T23:59:59Z').expect(200);
    expect(some.body.map((s: { fiveHourPct: number }) => s.fiveHourPct)).toEqual([20]);
    expect((await t.agent.get('/usage/snapshots?from=garbage').expect(200)).body).toHaveLength(3);
  });

  it('summarises tokens by stage and model, and suggests the calibration from the last rejected snapshot', async () => {
    const run = (stage: string, model: string, input: number, output: number, cacheWrite: number) =>
      t.prisma.stageRun.create({ data: { projectId, stage: stage as never, model, attempt: 1, status: 'succeeded', startedAt: new Date(), inputTokens: input, outputTokens: output, cacheWriteTokens: cacheWrite, cacheReadTokens: 5000 } });
    await run('plan', 'opus', 100, 50, 10);
    await run('plan', 'opus', 100, 50, 10);
    await run('implement', 'haiku', 1000, 500, 0);
    await snap('2026-11-11T10:00:00Z', { status: 'rejected', windowTokens: 700_000 });
    await snap('2026-11-12T10:00:00Z', { status: 'rejected', windowTokens: 900_000 });
    await snap('2026-11-12T11:00:00Z', { status: 'allowed', windowTokens: 100 });
    const res = await t.agent.get('/usage/summary').expect(200);
    expect(res.body.tokens).toEqual([{ stage: 'implement', model: 'haiku', tokens: 1500, runs: 1 }, { stage: 'plan', model: 'opus', tokens: 320, runs: 2 }]);
    expect(res.body.suggestedCalibration).toBe(900_000);
  });

  it('has no suggestion without a rejected snapshot', async () => {
    await snap('2026-11-12T11:00:00Z', { status: 'allowed', windowTokens: 100 });
    expect((await t.agent.get('/usage/summary').expect(200)).body).toEqual({ tokens: [], suggestedCalibration: null });
  });
});
