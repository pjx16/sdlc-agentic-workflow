import { describe, expect, it } from 'vitest';
import { failureRates, findStuck, integrationRates, stageLoad, type RunRow } from './operations-calc';

const now = new Date('2026-11-14T12:00:00Z');
const ago = (min: number) => new Date(now.getTime() - min * 60_000);

describe('findStuck', () => {
  const t = (key: string, status: never, min: number, hasActiveRun = false) => ({ id: key, key, status, updatedAt: ago(min), hasActiveRun });
  it('flags an actionable ticket after 30 minutes with nothing running', () => {
    const r = findStuck([t('A-1', 'IN_PROGRESS' as never, 45), t('A-2', 'IN_PROGRESS' as never, 10), t('A-3', 'IN_PROGRESS' as never, 90, true)], now);
    expect(r.map((x) => x.key)).toEqual(['A-1']);
    expect(r[0]?.why).toContain('nothing is running');
  });
  it('flags a ticket waiting for a person after 24 hours, not before', () => {
    const r = findStuck([t('B-1', 'AWAITING_PLAN_APPROVAL' as never, 25 * 60), t('B-2', 'AWAITING_PLAN_APPROVAL' as never, 5 * 60), t('B-3', 'ON_HOLD' as never, 30 * 60)], now);
    expect(r.map((x) => x.key)).toEqual(['B-3', 'B-1']);
    expect(r[1]?.why).toBe('Waiting for a person for 25 hours');
  });
  it('never flags finished tickets, and the thresholds can change', () => {
    expect(findStuck([t('C-1', 'DONE' as never, 9999), t('C-2', 'FAILED' as never, 9999)], now)).toEqual([]);
    expect(findStuck([t('D-1', 'KB' as never, 5)], now, { actionableMin: 3, awaitingHours: 24 })).toHaveLength(1);
  });
});

const run = (over: Partial<RunRow>): RunRow => ({ stage: 'plan', status: 'succeeded', attempt: 1, round: 0, errorCode: null, startedAt: ago(10), endedAt: ago(8), inputTokens: 100, outputTokens: 50, costUsd: 0.1, ...over });

describe('failureRates', () => {
  it('counts failures by stage and error code, worst stage first, and ignores killed runs', () => {
    const r = failureRates([run({}), run({ status: 'failed', errorCode: 'TIMEOUT' }), run({ stage: 'implement', status: 'failed', errorCode: 'CLAUDE_API_ERROR' }), run({ stage: 'implement', status: 'failed', errorCode: 'CLAUDE_API_ERROR' }), run({ stage: 'implement', status: 'killed' }), run({ stage: 'implement', status: 'failed' })]);
    expect(r.byStage[0]).toMatchObject({ stage: 'implement', runs: 4, failed: 3, rate: 0.75, byCode: { CLAUDE_API_ERROR: 2, UNCLASSIFIED: 1 } });
    expect(r.byStage[1]).toMatchObject({ stage: 'plan', runs: 2, failed: 1, rate: 0.5 });
    expect(r.byCode[0]).toEqual({ code: 'CLAUDE_API_ERROR', count: 2 });
  });
  it('is empty for no runs', () => expect(failureRates([])).toEqual({ byStage: [], byCode: [] }));
});

describe('stageLoad', () => {
  it('counts retries and fix rounds and averages duration, tokens and cost', () => {
    const r = stageLoad([run({ stage: 'fix', attempt: 2, round: 1 }), run({ stage: 'fix', round: 2, startedAt: ago(10), endedAt: ago(6), inputTokens: 300, outputTokens: 100, costUsd: 0.3 }), run({ stage: 'plan' })]);
    expect(r[0]).toEqual({ stage: 'fix', runs: 2, retries: 1, loops: 2, avgDurationSec: 180, avgTokens: 275, avgCostUsd: 0.2 });
    expect(r[1]).toMatchObject({ stage: 'plan', runs: 1, retries: 0, loops: 0 });
  });
});

describe('integrationRates', () => {
  it('uses stage runs for Claude and events for Jira, Confluence and GitHub', () => {
    const r = integrationRates({ total: 10, errors: 2 }, [{ source: 'jira', level: 'info' }, { source: 'jira', level: 'warn' }, { source: 'github', level: 'error' }, { source: 'agent', level: 'error' }]);
    expect(r).toEqual([
      { source: 'claude', total: 10, errors: 2, rate: 0.2 },
      { source: 'jira', total: 2, errors: 1, rate: 0.5 },
      { source: 'confluence', total: 0, errors: 0, rate: 0 },
      { source: 'github', total: 1, errors: 1, rate: 1 },
    ]);
  });
});
