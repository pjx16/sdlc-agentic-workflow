import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type TestApp, createTestApp } from '../testing/test-app';
import { type TestDatabase, createTestDatabase } from '../testing/test-db';
import { MetricsModule } from './metrics.module';
import { MetricsService } from './metrics.service';

const NOW = new Date('2026-11-12T12:00:00Z');
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3600_000);

describe('Metrics API (BUILD_PLAN 8, F17)', () => {
  let db: TestDatabase;
  let t: TestApp;
  let projectId: string;
  let n = 0;

  const ticket = (over: Record<string, unknown> = {}) => t.prisma.ticket.create({ data: { projectId, key: `K-${++n}`, source: 'paste', title: 't', ...over } });
  const run = (over: Record<string, unknown> = {}) =>
    t.prisma.stageRun.create({ data: { projectId, stage: 'plan', model: 'opus', attempt: 1, status: 'succeeded', startedAt: ago(1), endedAt: ago(0.5), inputTokens: 100, outputTokens: 50, cacheWriteTokens: 10, cacheReadTokens: 9999, ...over } as never });

  beforeAll(async () => {
    db = await createTestDatabase();
    t = await createTestApp(db.url, [MetricsModule]);
    t.app.get(MetricsService).now = () => NOW;
    projectId = (await t.prisma.project.create({ data: { name: 'p', repoUrl: 'https://x/y', stack: 'ts_node', testCmdTemplate: 'x {files}', localKeyPrefix: 'P', mirrorStatus: 'ok' } })).id;
  }, 180_000);
  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });
  beforeEach(async () => {
    await t.prisma.reviewFinding.deleteMany();
    await t.prisma.stageRun.deleteMany();
    await t.prisma.stateTransition.deleteMany();
    await t.prisma.subtask.deleteMany();
    await t.prisma.ticket.deleteMany();
    await t.prisma.usageSnapshot.deleteMany();
    await t.prisma.event.deleteMany();
  });

  it('merged: PRs and lines per day, from the merge time recorded on the ticket', async () => {
    await ticket({ status: 'DONE', mergedAt: ago(30), prAdditions: 100, prDeletions: 40 });
    await ticket({ status: 'DONE', mergedAt: ago(1), prAdditions: 10, prDeletions: 2 });
    await ticket({ status: 'DONE', mergedAt: ago(2) }); // merged before line counts were recorded
    await ticket({ status: 'IN_HUMAN_REVIEW' }); // not merged
    const body = (await t.agent.get('/metrics/merged?range=7d').expect(200)).body;
    expect(body.totals).toEqual({ merged: 3, additions: 110, deletions: 42, withoutLineData: 1 });
    expect(body.days.at(-1)).toEqual({ day: '2026-11-12', merged: 2, additions: 10, deletions: 2 });
    expect((await t.agent.get('/metrics/merged?range=24h').expect(200)).body.totals.merged).toBe(2);
  });

  it('requires a session', async () => {
    for (const p of ['summary', 'usage', 'tokens', 'merged', 'tickets-by-state', 'quality', 'durations']) await t.anonymous.get(`/metrics/${p}`).expect(401);
  });

  describe('with no data every endpoint answers with empty values, not errors', () => {
    it('summary, usage, tokens, quality, durations, tickets-by-state', async () => {
      expect((await t.agent.get('/metrics/summary').expect(200)).body).toEqual({ range: '7d', ticketsDone: 0, firstPassRate: null, tokensInWindow: 0, queueLength: 0 });
      expect((await t.agent.get('/metrics/usage').expect(200)).body).toMatchObject({ series: [], pauses: [], thresholdPct: 50, thresholdWeeklyPct: 80 });
      const tokens = (await t.agent.get('/metrics/tokens').expect(200)).body;
      expect(tokens).toMatchObject({ groupBy: 'stage', keys: [] });
      expect(tokens.days.every((d: { total: number }) => d.total === 0)).toBe(true);
      expect((await t.agent.get('/metrics/quality').expect(200)).body).toMatchObject({ firstPassRate: null, avgFixRounds: null, avgReviewRounds: null });
      expect((await t.agent.get('/metrics/durations').expect(200)).body).toEqual({ range: '7d', stages: [] });
      const states = (await t.agent.get('/metrics/tickets-by-state').expect(200)).body;
      expect(states.length).toBeGreaterThan(10);
      expect(states.every((s: { count: number }) => s.count === 0)).toBe(true);
    });
  });

  it('summary: tickets done in range, tokens in the 5-hour window, the queue, and the range switch', async () => {
    const done = await ticket({ status: 'DONE' });
    await t.prisma.stateTransition.create({ data: { ticketId: done.id, fromStatus: 'IN_HUMAN_REVIEW', toStatus: 'DONE', actor: 'system', at: ago(2) } });
    const old = await ticket({ status: 'DONE' });
    await t.prisma.stateTransition.create({ data: { ticketId: old.id, fromStatus: 'IN_HUMAN_REVIEW', toStatus: 'DONE', actor: 'system', at: ago(24 * 3) } });
    await ticket({ status: 'IN_PROGRESS' });
    await ticket({ status: 'NEW' });
    await ticket({ status: 'AWAITING_CI', ciFixPending: true });
    await ticket({ status: 'AWAITING_CI' });
    await ticket({ status: 'ON_HOLD', holdReason: 'manual', holdFromStatus: 'NEW' });
    await run({ startedAt: ago(1) });
    await run({ startedAt: ago(6), inputTokens: 5000 }); // outside the 5-hour window
    const week = (await t.agent.get('/metrics/summary').expect(200)).body;
    expect(week).toMatchObject({ range: '7d', ticketsDone: 2, tokensInWindow: 160, queueLength: 3 });
    expect((await t.agent.get('/metrics/summary?range=24h').expect(200)).body).toMatchObject({ range: '24h', ticketsDone: 1 });
    expect((await t.agent.get('/metrics/summary?range=bogus').expect(200)).body.range).toBe('7d');
  });

  it('first-pass rate: subtasks that became DONE in range without a tests fix run', async () => {
    const tk = await ticket();
    const mk = async (fixes: number, status = 'DONE', endedHoursAgo = 1) => {
      const s = await t.prisma.subtask.create({ data: { ticketId: tk.id, seq: ++n, title: 's', status: status as never } });
      await run({ ticketId: tk.id, subtaskId: s.id, stage: 'implement', endedAt: ago(endedHoursAgo) });
      for (let i = 0; i < fixes; i++) await run({ ticketId: tk.id, subtaskId: s.id, stage: 'fix', reason: 'tests', endedAt: ago(endedHoursAgo) });
      return s;
    };
    await mk(0);
    await mk(0);
    await mk(2);
    await mk(0, 'IMPLEMENT'); // not done: not counted
    await mk(0, 'DONE', 24 * 20); // finished long ago: outside 7d
    const s = await t.prisma.subtask.create({ data: { ticketId: tk.id, seq: ++n, title: 'ci', status: 'DONE' } });
    await run({ ticketId: tk.id, subtaskId: s.id, stage: 'fix', reason: 'review' }); // a review fix does not count against first pass
    expect((await t.agent.get('/metrics/summary').expect(200)).body.firstPassRate).toBe(0.75); // 4 done in range: two clean, one with 2 tests fixes, one with only a review fix
    expect((await t.agent.get('/metrics/quality').expect(200)).body.firstPassRate).toBe(0.75);
  });

  it('tokens: per day, grouped by stage or model, counting input + output + cache-write', async () => {
    await run({ stage: 'plan', model: 'opus', startedAt: ago(1) });
    await run({ stage: 'implement', model: 'haiku', startedAt: ago(1), inputTokens: 1000, outputTokens: 0, cacheWriteTokens: 0 });
    await run({ stage: 'plan', model: 'opus', startedAt: ago(24 * 20) }); // outside
    const byStage = (await t.agent.get('/metrics/tokens?range=7d&groupBy=stage').expect(200)).body;
    expect(byStage.keys).toEqual(['implement', 'plan']);
    const today = byStage.days.at(-1);
    expect(today).toMatchObject({ day: '2026-11-12', total: 1160, groups: { plan: 160, implement: 1000 } });
    const byModel = (await t.agent.get('/metrics/tokens?groupBy=model').expect(200)).body;
    expect(byModel).toMatchObject({ groupBy: 'model', keys: ['haiku', 'opus'] });
    expect((await t.agent.get('/metrics/tokens?groupBy=nonsense').expect(200)).body.groupBy).toBe('stage');
    expect((await t.agent.get('/metrics/tokens?range=24h').expect(200)).body.days.length).toBeLessThanOrEqual(2);
  });

  it('usage: the series, the thresholds and the pause events in range', async () => {
    await t.prisma.globalSettings.upsert({ where: { id: 'global' }, update: { usageThresholdPct: 40 }, create: { id: 'global', usageThresholdPct: 40 } });
    await t.prisma.usageSnapshot.create({ data: { at: ago(3), fiveHourPct: 20, sevenDayPct: 5, status: 'allowed', source: 'event' } });
    await t.prisma.usageSnapshot.create({ data: { at: ago(1), fiveHourPct: 45, sevenDayPct: 6, status: 'allowed', source: 'event' } });
    await t.prisma.usageSnapshot.create({ data: { at: ago(24 * 20), fiveHourPct: 99, source: 'event' } });
    await t.prisma.event.create({ data: { type: 'usage', message: 'Pipeline paused: 5-hour usage is at 45%', at: ago(1) } });
    await t.prisma.event.create({ data: { type: 'usage', message: 'Usage gate ignored until x', at: ago(1) } });
    const body = (await t.agent.get('/metrics/usage').expect(200)).body;
    expect(body.thresholdPct).toBe(40);
    expect(body.series.map((s: { fiveHourPct: number }) => s.fiveHourPct)).toEqual([20, 45]);
    expect(body.pauses).toHaveLength(1);
    expect(body.pauses[0].message).toContain('45%');
  });

  it('tickets by state: one count per internal state, including zeros', async () => {
    await ticket({ status: 'NEW' });
    await ticket({ status: 'NEW' });
    await ticket({ status: 'DONE' });
    const states = (await t.agent.get('/metrics/tickets-by-state').expect(200)).body;
    expect(states.find((s: { status: string }) => s.status === 'NEW').count).toBe(2);
    expect(states.find((s: { status: string }) => s.status === 'DONE').count).toBe(1);
    expect(states.find((s: { status: string }) => s.status === 'REVIEW').count).toBe(0);
  });

  it('quality: fix rounds and review rounds per ticket, and findings by severity', async () => {
    const a = await ticket({ reviewRound: 2 });
    const b = await ticket({ reviewRound: 1 });
    await ticket({ reviewRound: 0 });
    await run({ ticketId: a.id });
    await run({ ticketId: b.id });
    await run({ ticketId: a.id, stage: 'fix', reason: 'tests' });
    await run({ ticketId: a.id, stage: 'fix', reason: 'review' });
    const f = (severity: string) => ({ ticketId: a.id, round: 1, severity, file: 'x', issue: 'i', rule: 'r', fix: 'f', status: 'open' });
    await t.prisma.reviewFinding.createMany({ data: [f('high'), f('high'), f('low')] as never });
    const q = (await t.agent.get('/metrics/quality').expect(200)).body;
    expect(q.avgFixRounds).toBe(1); // 2 fix runs over 2 tickets that ran a stage
    expect(q.avgReviewRounds).toBe(1.5); // over tickets that were reviewed
    expect(q.findingsBySeverity).toEqual([{ severity: 'critical', count: 0 }, { severity: 'high', count: 2 }, { severity: 'medium', count: 0 }, { severity: 'low', count: 1 }]);
  });

  it('durations: the median per stage over succeeded runs, longest first', async () => {
    const at = (s: number) => ({ startedAt: ago(2), endedAt: new Date(ago(2).getTime() + s * 1000) });
    await run({ stage: 'plan', ...at(10) });
    await run({ stage: 'plan', ...at(30) });
    await run({ stage: 'plan', ...at(20) });
    await run({ stage: 'implement', ...at(100) });
    await run({ stage: 'implement', status: 'failed', ...at(9999) });
    const d = (await t.agent.get('/metrics/durations').expect(200)).body;
    expect(d.stages).toEqual([{ stage: 'implement', runs: 1, medianSeconds: 100 }, { stage: 'plan', runs: 3, medianSeconds: 20 }]);
  });
});
