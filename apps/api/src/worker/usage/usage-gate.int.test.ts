import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../../prisma/prisma.service';
import { type TestDatabase, createTestDatabase } from '../../testing/test-db';
import { SystemSettingsService } from '../../system/system-settings.service';
import { UsageGate } from './usage-gate';

const RESET = new Date('2026-11-12T13:00:00Z');
const limit = (over: Record<string, unknown> = {}) => ({ fiveHourPct: 10, sevenDayPct: 10, status: 'allowed', resetsAt: RESET, ...over }) as never;

describe('UsageGate (F14, BUILD_PLAN 6.7)', () => {
  let db: TestDatabase;
  let prisma: PrismaService;
  let gate: UsageGate;
  let system: SystemSettingsService;
  let now = new Date('2026-11-12T10:00:00Z');
  let projectId: string;

  const settings = () => prisma.globalSettings.findUniqueOrThrow({ where: { id: 'global' } });
  const reset = (data: Record<string, unknown> = {}) =>
    prisma.globalSettings.upsert({ where: { id: 'global' }, update: { usageThresholdPct: 50, usageThresholdWeeklyPct: 80, calibratedWindowTokens: null, usageIgnoredUntil: null, pipelinePaused: false, pausedReason: null, resetsAt: null, ...data } as never, create: { id: 'global' } });

  beforeAll(async () => {
    db = await createTestDatabase();
    process.env.DATABASE_URL = db.url;
    prisma = new PrismaService();
    await prisma.onModuleInit();
    gate = new UsageGate(prisma, () => now);
    system = new SystemSettingsService(prisma);
    projectId = (await prisma.project.create({ data: { name: 'p', repoUrl: 'https://x/y', stack: 'ts_node', testCmdTemplate: 'x {files}', localKeyPrefix: 'P', mirrorStatus: 'ok' } })).id;
  }, 180_000);
  afterAll(async () => {
    await prisma?.onModuleDestroy();
    await db?.drop();
  });
  beforeEach(async () => {
    await prisma.usageSnapshot.deleteMany();
    await prisma.stageRun.deleteMany();
    await prisma.event.deleteMany();
    await reset();
  });

  it('stores a snapshot and does not pause below the thresholds', async () => {
    await gate.afterStage({ limit: limit({ fiveHourPct: 20, sevenDayPct: 30 }) });
    expect(await prisma.usageSnapshot.findMany()).toMatchObject([{ fiveHourPct: 20, sevenDayPct: 30, status: 'allowed', source: 'event', resetsAt: RESET }]);
    expect((await settings()).pipelinePaused).toBe(false);
  });

  it('pauses at the 5-hour threshold with the reason and the reset time, and logs it', async () => {
    await gate.afterStage({ limit: limit({ fiveHourPct: 55 }) });
    expect(await settings()).toMatchObject({ pipelinePaused: true, resetsAt: RESET });
    expect((await settings()).pausedReason).toContain('5-hour usage is at 55%');
    expect(await prisma.event.findMany({ where: { type: 'usage' } })).toHaveLength(1);
  });

  it('pauses at the 7-day threshold', async () => {
    await gate.afterStage({ limit: limit({ sevenDayPct: 85 }) });
    expect((await settings()).pausedReason).toContain('7-day usage is at 85%');
  });

  it('uses the configured thresholds', async () => {
    await reset({ usageThresholdPct: 90 });
    await gate.afterStage({ limit: limit({ fiveHourPct: 60 }) });
    expect((await settings()).pipelinePaused).toBe(false);
    await gate.afterStage({ limit: limit({ fiveHourPct: 91 }) });
    expect((await settings()).pipelinePaused).toBe(true);
  });

  it('Resume clears the pause; the gate evaluates again after the next stage', async () => {
    await gate.afterStage({ limit: limit({ fiveHourPct: 60 }) });
    await system.resume();
    expect(await settings()).toMatchObject({ pipelinePaused: false, pausedReason: null });
    await gate.afterStage({ limit: limit({ fiveHourPct: 61 }) });
    expect((await settings()).pipelinePaused).toBe(true);
  });

  it('pause then Ignore: runs on until the window resets, then the gate re-arms', async () => {
    await gate.afterStage({ limit: limit({ fiveHourPct: 60 }) });
    await system.ignoreUsage({});
    expect((await settings()).usageIgnoredUntil).toEqual(RESET);
    expect((await settings()).pipelinePaused).toBe(false);
    await gate.afterStage({ limit: limit({ fiveHourPct: 90, sevenDayPct: 95, status: 'allowed_warning' }) });
    expect((await settings()).pipelinePaused).toBe(false);
    now = new Date(RESET.getTime() + 1000);
    await gate.afterStage({ limit: limit({ fiveHourPct: 5 }) });
    expect((await settings()).pipelinePaused).toBe(false);
    await gate.afterStage({ limit: limit({ fiveHourPct: 55 }) });
    expect((await settings()).pipelinePaused).toBe(true);
    now = new Date('2026-11-12T10:00:00Z');
  });

  it('rejected still pauses while usage is ignored, and so does a rate-limit error', async () => {
    await reset({ usageIgnoredUntil: new Date(now.getTime() + 3600_000) });
    await gate.afterStage({ limit: limit({ status: 'rejected' }) });
    expect((await settings()).pipelinePaused).toBe(true);
    await reset({ usageIgnoredUntil: new Date(now.getTime() + 3600_000) });
    await gate.afterStage({ limit: null, rateLimitError: true });
    expect((await settings()).pipelinePaused).toBe(true);
    expect((await prisma.usageSnapshot.findFirstOrThrow({ orderBy: { at: 'desc' } })).status).toBe('rejected');
  });

  it('a warning status pauses', async () => {
    await gate.afterStage({ limit: limit({ status: 'allowed_warning' }) });
    expect((await settings()).pipelinePaused).toBe(true);
  });

  it('without percentages it estimates from the tokens of the last 5 hours and the calibration', async () => {
    await reset({ calibratedWindowTokens: 1_000_000n });
    const run = (hoursAgo: number, input: number, output: number, cacheWrite: number) =>
      prisma.stageRun.create({ data: { projectId, stage: 'plan', model: 'm', attempt: 1, status: 'succeeded', startedAt: new Date(now.getTime() - hoursAgo * 3600_000), inputTokens: input, outputTokens: output, cacheWriteTokens: cacheWrite, cacheReadTokens: 999_999 } });
    await run(1, 100_000, 50_000, 50_000);
    await run(6, 900_000, 0, 0); // outside the window
    expect(await gate.windowTokens()).toBe(200_000);
    await gate.afterStage({ limit: limit({ fiveHourPct: null, sevenDayPct: null }), ownTokens: 100_000 });
    expect(await prisma.usageSnapshot.findFirstOrThrow()).toMatchObject({ source: 'estimate', fiveHourPct: 30, windowTokens: 300_000 });
    expect((await settings()).pipelinePaused).toBe(false);
    await gate.afterStage({ limit: null, ownTokens: 400_000 });
    expect((await settings()).pipelinePaused).toBe(true);
  });

  it('no event and no calibration: a snapshot with empty percentages is still recorded, and nothing is enforced', async () => {
    await gate.afterStage({ limit: null, ownTokens: 99_000_000 });
    expect(await prisma.usageSnapshot.findMany()).toMatchObject([{ fiveHourPct: null, sevenDayPct: null, source: 'estimate', stageRunId: null, model: null }]);
    expect((await settings()).pipelinePaused).toBe(false);
  });

  describe('one snapshot for every run that ends, linked to the run and its model', () => {
    const run = (status: 'succeeded' | 'failed' | 'killed') => prisma.stageRun.create({ data: { projectId, stage: 'plan', model: 'claude-opus-x', attempt: 1, status } });

    for (const status of ['succeeded', 'failed', 'killed'] as const) {
      it(`${status} run, with an event`, async () => {
        const r = await run(status);
        await gate.afterStage({ limit: limit({ fiveHourPct: 12 }), stageRunId: r.id });
        expect(await prisma.usageSnapshot.findMany()).toMatchObject([{ stageRunId: r.id, model: 'claude-opus-x', fiveHourPct: 12, source: 'event' }]);
      });
    }

    it('container-error run (no stream at all): estimate snapshot, percentages empty', async () => {
      const r = await run('failed');
      await gate.afterStage({ limit: null, stageRunId: r.id, ownTokens: 0 });
      expect(await prisma.usageSnapshot.findMany()).toMatchObject([{ stageRunId: r.id, model: 'claude-opus-x', fiveHourPct: null, source: 'estimate' }]);
    });

    it('a stream without an event but with a calibration gets an estimated percentage', async () => {
      await reset({ calibratedWindowTokens: 1_000_000n });
      const r = await run('succeeded');
      await gate.afterStage({ limit: null, stageRunId: r.id, ownTokens: 100_000 });
      expect(await prisma.usageSnapshot.findMany()).toMatchObject([{ fiveHourPct: 10, source: 'estimate' }]);
    });

    it('keeps every window the event carried', async () => {
      const windows = { five_hour: { utilization: 0.1 }, seven_day: { utilization: 0.2 }, seven_day_opus: { utilization: 0.4 } };
      await gate.afterStage({ limit: limit({ windows }) });
      expect((await prisma.usageSnapshot.findFirstOrThrow()).windows).toEqual(windows);
    });
  });

  it('an existing pause is not overwritten by a later one', async () => {
    await gate.afterStage({ limit: limit({ fiveHourPct: 60 }) });
    const first = (await settings()).pausedReason;
    await gate.afterStage({ limit: limit({ fiveHourPct: 70 }) });
    expect((await settings()).pausedReason).toBe(first);
    expect(await prisma.event.count({ where: { type: 'usage' } })).toBe(1);
  });
});
