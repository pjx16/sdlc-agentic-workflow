import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type TestApp, createTestApp } from '../testing/test-app';
import { type TestDatabase, createTestDatabase } from '../testing/test-db';
import { SystemSettingsModule } from './system-settings.module';
import { workerState } from './system-settings.service';

describe('System and global settings API', () => {
  let db: TestDatabase;
  let t: TestApp;

  beforeAll(async () => {
    db = await createTestDatabase();
    t = await createTestApp(db.url, [SystemSettingsModule]);
  }, 180_000);
  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });
  beforeEach(async () => {
    await t.prisma.globalSettings.deleteMany();
    await t.prisma.stageRun.deleteMany();
    await t.prisma.usageSnapshot.deleteMany();
    await t.prisma.project.deleteMany();
  });

  it('requires a session', async () => {
    await t.anonymous.get('/system').expect(401);
    await t.anonymous.patch('/system/settings').send({}).expect(401);
    await t.anonymous.post('/system/pause').expect(401);
  });

  it('GET /system returns the defaults, no running stage and no usage', async () => {
    const res = await t.agent.get('/system').expect(200);
    expect(res.body.runningStage).toBeNull();
    expect(res.body.usage).toBeNull();
    expect(res.body.settings).toMatchObject({
      usageThresholdPct: 50, usageThresholdWeeklyPct: 80, calibratedWindowTokens: null, pollIntervalSec: 120, stageTimeoutMin: 20,
      verifyTimeoutSec: 600, workspaceRetentionDays: 7, logRetentionDays: 30, pipelinePaused: false, pausedReason: null, intakePaused: false,
      modelAliases: { haiku: 'haiku', sonnet: 'sonnet', opus: 'opus' },
    });
    expect(res.body.settings.jiraMcp.readTools).toContain('getJiraIssue');
  });

  it('GET /system reports the worker: none before it has run, online with a fresh heartbeat, offline with an old one, plus recent events', async () => {
    await t.prisma.workerStatus.deleteMany();
    expect((await t.agent.get('/system').expect(200)).body.worker).toBeNull();

    await t.prisma.workerStatus.create({ data: { heartbeatAt: new Date(), tickOutcome: 'not_configured', tickDetail: 'claude_token' } });
    await t.prisma.workerStatus.create({ data: { id: 'intake-rest', heartbeatAt: new Date(), tickOutcome: 'intake', intakeMode: 'rest', intakeAt: new Date(), intakeProjects: 1, intakeError: 'boom' } });
    await t.prisma.event.create({ data: { type: 'jira', message: 'Jira (MCP) intake: 1 new ticket' } });
    const online = (await t.agent.get('/system').expect(200)).body;
    expect(online.worker).toMatchObject({ online: true, tickOutcome: 'not_configured', tickDetail: 'claude_token', intake: [{ mode: 'rest', projects: 1, error: 'boom', created: 0 }] });
    expect(online.recentEvents[0]).toMatchObject({ type: 'jira', message: 'Jira (MCP) intake: 1 new ticket', ticketKey: null });

    await t.prisma.workerStatus.update({ where: { id: 'worker' }, data: { heartbeatAt: new Date(Date.now() - 5 * 60_000) } });
    expect((await t.agent.get('/system').expect(200)).body.worker.online).toBe(false);
    await t.prisma.workerStatus.deleteMany();
    await t.prisma.event.deleteMany();
  });

  it('GET /system includes the running stage and the latest usage snapshot', async () => {
    const project = await t.prisma.project.create({
      data: { name: 'p', repoUrl: 'https://x/y', stack: 'ts_node', testCmdTemplate: 'x {files}', localKeyPrefix: 'P' },
    });
    await t.prisma.stageRun.create({ data: { projectId: project.id, stage: 'plan', model: 'opus', status: 'running', startedAt: new Date() } });
    await t.prisma.usageSnapshot.create({ data: { fiveHourPct: 0.42, sevenDayPct: 0.1, status: 'allowed', source: 'event' } });
    const res = await t.agent.get('/system').expect(200);
    expect(res.body.runningStage).toMatchObject({ stage: 'plan', model: 'opus', projectId: project.id });
    expect(res.body.usage).toMatchObject({ fiveHourPct: 0.42, sevenDayPct: 0.1, status: 'allowed', source: 'event' });
  });

  it('round-trips global settings, merging nested values', async () => {
    const patch = {
      usageThresholdPct: 40, usageThresholdWeeklyPct: 70, calibratedWindowTokens: 5_000_000, pollIntervalSec: 60, stageTimeoutMin: 30,
      verifyTimeoutSec: 300, workspaceRetentionDays: 3, logRetentionDays: 10,
      modelAliases: { opus: 'claude-opus-5-5' }, jiraMcp: { readTools: ['getJiraIssue'], writeTools: [] },
    };
    const res = await t.agent.patch('/system/settings').send(patch).expect(200);
    expect(res.body).toMatchObject({ ...patch, modelAliases: { haiku: 'haiku', sonnet: 'sonnet', opus: 'claude-opus-5-5' } });
    const again = (await t.agent.get('/system').expect(200)).body.settings;
    expect(again).toEqual(res.body);
    const row = await t.prisma.globalSettings.findUniqueOrThrow({ where: { id: 'global' } });
    expect(Number(row.calibratedWindowTokens)).toBe(5_000_000);
    const cleared = await t.agent.patch('/system/settings').send({ calibratedWindowTokens: null }).expect(200);
    expect(cleared.body.calibratedWindowTokens).toBeNull();
    expect(cleared.body.pollIntervalSec).toBe(60);
  });

  it('returns field-level errors and saves nothing', async () => {
    const res = await t.agent
      .patch('/system/settings')
      .send({ usageThresholdPct: 0, pollIntervalSec: 1, stageTimeoutMin: 'x', modelAliases: { haiku: '' }, jiraMcp: { readTools: [''] } })
      .expect(400);
    expect(res.body.error).toBe('validation_error');
    expect(Object.keys(res.body.fields).sort()).toEqual(['jiraMcp.readTools.0', 'modelAliases.haiku', 'pollIntervalSec', 'stageTimeoutMin', 'usageThresholdPct']);
    expect((await t.agent.get('/system')).body.settings.usageThresholdPct).toBe(50);
  });

  it('pauses and resumes the pipeline', async () => {
    const paused = (await t.agent.post('/system/pause').expect(200)).body;
    expect(paused).toMatchObject({ pipelinePaused: true, pausedReason: 'manual' });
    const resumed = (await t.agent.post('/system/resume').expect(200)).body;
    expect(resumed).toMatchObject({ pipelinePaused: false, pausedReason: null, resetsAt: null });
  });

  it('usage/ignore returns 409 unless paused, then ignores until the window reset', async () => {
    expect((await t.agent.post('/system/usage/ignore').send({}).expect(409)).body.error).toBe('conflict');
    const reset = new Date(Date.now() + 3_600_000);
    await t.agent.post('/system/pause').expect(200);
    await t.prisma.globalSettings.update({ where: { id: 'global' }, data: { pausedReason: 'usage', resetsAt: reset } });
    const res = (await t.agent.post('/system/usage/ignore').send({}).expect(200)).body;
    expect(res).toMatchObject({ pipelinePaused: false, pausedReason: null, resetsAt: null });
    expect(new Date(res.usageIgnoredUntil).getTime()).toBe(reset.getTime());
  });

  it('usage/ignore accepts an explicit until and rejects a bad date', async () => {
    await t.agent.post('/system/pause').expect(200);
    expect((await t.agent.post('/system/usage/ignore').send({ until: 'tomorrow-ish' }).expect(400)).body.fields.until).toBeTruthy();
    const until = '2030-01-01T00:00:00.000Z';
    expect((await t.agent.post('/system/usage/ignore').send({ until }).expect(200)).body.usageIgnoredUntil).toBe(until);
  });

  it('pauses and resumes intake independently of the pipeline', async () => {
    expect((await t.agent.post('/system/intake/pause').expect(200)).body).toMatchObject({ intakePaused: true, pipelinePaused: false });
    expect((await t.agent.post('/system/intake/resume').expect(200)).body.intakePaused).toBe(false);
  });

  it('writes audit events for changes', async () => {
    await t.agent.patch('/system/settings').send({ pollIntervalSec: 90 }).expect(200);
    await t.agent.post('/system/pause').expect(200);
    const events = await t.prisma.event.findMany({ where: { ticketId: null }, orderBy: { at: 'asc' } });
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['settings', 'state']));
  });
});

describe('workerState', () => {
  const now = Date.parse('2026-11-14T12:00:00Z');
  const row = (beatAgoS: number, phase: string, sinceAgoMin: number) => ({ heartbeatAt: new Date(now - beatAgoS * 1000), phase, phaseSince: new Date(now - sinceAgoMin * 60_000) });
  it('is offline when the heartbeat is older than 30 seconds', () => expect(workerState(row(31, 'stage', 1), now, 20)).toBe('offline'));
  it('is idle when idle, paused or not configured', () => {
    for (const p of ['idle', 'paused', 'not_configured']) expect(workerState(row(3, p, 500), now, 20)).toBe('idle');
  });
  it('is busy while a phase is within the stage limit plus 5 minutes', () => expect(workerState(row(3, 'stage', 24), now, 20)).toBe('busy'));
  it('is stalled when a phase outlasts the stage limit plus 5 minutes', () => expect(workerState(row(3, 'stage', 26), now, 20)).toBe('stalled'));
});
