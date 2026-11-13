import { staticCredentials } from '../../testing/static-credentials';
import 'reflect-metadata';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorkerConfig } from '../worker-config';
import { AgentRunner, type StageRequest } from './agent-runner';
import { ContainerRunner } from './container-runner';
import { FakeEngine, type FakeBehaviour } from './fake-engine';
import { NullLogSink } from './log-sink';
import { MemoryStore } from '../../testing/memory-stage-run-store';

const planData = { planMarkdown: '# Plan', risks: [], openQuestions: [] };
const stream = (structured: unknown, extra: Record<string, unknown> = {}, rate?: unknown): string[] =>
  [
    { type: 'system', subtype: 'init', claude_code_version: '2.1.322' },
    ...(rate ? [rate] : []),
    { type: 'result', subtype: 'success', is_error: false, num_turns: 2, duration_ms: 50, total_cost_usd: 0.01, session_id: 's', usage: { input_tokens: 5, output_tokens: 6 }, structured_output: structured, result: '', ...extra },
  ].map((o) => JSON.stringify(o));
const good: FakeBehaviour = { lines: stream({ status: 'done', summary: 'ok', data: planData }) };
const badOutput: FakeBehaviour = { lines: stream({ status: 'done', summary: 'ok', data: { planMarkdown: '' } }) };

let tmp: string;
let config: WorkerConfig;
beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'sdlc-runner-'));
  mkdirSync(path.join(tmp, 'ws'), { recursive: true });
  config = new WorkerConfig({ DATA_DIR: tmp, DATABASE_URL: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'tok', GUIDELINES_DIR: path.join(tmp, 'guidelines') } as NodeJS.ProcessEnv);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const request = (over: Partial<StageRequest> = {}): StageRequest => ({
  projectId: 'p1', ticketId: 't1', stage: 'plan', stack: 'nestjs', claudeMdMode: 'both', modelAlias: 'opus',
  modelAliases: { haiku: 'haiku', sonnet: 'sonnet', opus: 'opus' }, maxTurns: 15, stageTimeoutMin: 20, inputs: { ticket: { key: 'A-1', title: 't', body: 'b' } },
  workspacePath: path.join(tmp, 'ws'), ...over,
});

const setup = (behaviour: FakeBehaviour | FakeBehaviour[]) => {
  const engine = new FakeEngine(behaviour);
  const store = new MemoryStore();
  return { engine, store, runner: new AgentRunner(new ContainerRunner(engine), config, staticCredentials({ claude_token: 'tok' }), store, new NullLogSink()) };
};

describe('AgentRunner (BUILD_PLAN 6.4, 6.8)', () => {
  it('runs a stage and records tokens, cost, turns, session and CLI version', async () => {
    const { runner, store, engine } = setup(good);
    const res = await runner.run(request());
    expect(res).toMatchObject({ kind: 'done', attempts: 1, envelope: { status: 'done', data: planData } });
    const run = store.runs.get('run-1');
    expect(run).toMatchObject({ stage: 'plan', model: 'opus', attempt: 1, status: 'succeeded' });
    expect(run?.finished?.usage).toMatchObject({ inputTokens: 5, outputTokens: 6, costUsd: 0.01, numTurns: 2, sessionId: 's', cliVersion: '2.1.322' });
    expect(run?.containerId).toBe('fake-1');
    expect(engine.created[0]?.name).toBe('sdlc-run-run-1');
    expect(engine.created[0]?.Env).toContain('CLAUDE_CODE_OAUTH_TOKEN=tok');
    expect(engine.created[0]?.Env).toContain('HTTPS_PROXY=http://proxy:3128');
    expect(engine.created[0]?.HostConfig?.Binds?.[0]).toBe(`${path.join(tmp, 'ws')}:/workspace:ro`); // plan is read-only
  });

  it('keeps the latest rate_limit_event', async () => {
    const rate = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.5 }, seven_day: { utilization: 0.2 } } } };
    const { runner, store } = setup({ lines: stream({ status: 'done', summary: 'ok', data: planData }, {}, rate) });
    await runner.run(request());
    expect(store.rateLimits).toEqual([expect.objectContaining({ fiveHourPct: 50, sevenDayPct: 20 })]);
  });

  it('retries a schema failure once with a fresh run, then succeeds', async () => {
    const { runner, store, engine } = setup([badOutput, good]);
    const res = await runner.run(request());
    expect(res).toMatchObject({ kind: 'done', attempts: 2 });
    expect([...store.runs.values()].map((r) => [r.attempt, r.status])).toEqual([[1, 'failed'], [2, 'succeeded']]);
    expect(store.runs.get('run-1')?.finished?.error).toContain('data.planMarkdown');
    expect(engine.created).toHaveLength(2);
  });

  it('fails after a second schema failure (the ticket goes on hold)', async () => {
    const { runner, store } = setup(badOutput);
    const res = await runner.run(request());
    expect(res).toMatchObject({ kind: 'failed', attempts: 2 });
    expect((res as { reason: string }).reason).toContain('failed validation');
    expect([...store.runs.values()].every((r) => r.status === 'failed')).toBe(true);
  });

  it('retries a non-zero exit and a timeout', async () => {
    expect(await setup([{ exitCode: 2, lines: [] }, good]).runner.run(request())).toMatchObject({ kind: 'done', attempts: 2 });
    const timeout = await setup([{ runMs: 5000 }, good]).runner.run(request({ stageTimeoutMin: 0.0005 }));
    expect(timeout).toMatchObject({ kind: 'done', attempts: 2 });
    const twice = await setup({ runMs: 5000 }).runner.run(request({ stageTimeoutMin: 0.0005 }));
    expect(twice).toMatchObject({ kind: 'failed', attempts: 2 });
    expect((twice as { reason: string; errorCode: string }).reason).toContain('took longer than');
    expect(twice).toMatchObject({ errorCode: 'TIMEOUT' });
  });

  it('treats blocked and orchestrator-validation failures as failed attempts', async () => {
    const blocked = { lines: stream({ status: 'blocked', summary: 'cannot' }) };
    // BLOCKED is not retried: the policy holds the ticket with the reason.
    expect(await setup(blocked).runner.run(request())).toMatchObject({ kind: 'failed', errorCode: 'BLOCKED', attempts: 1 });
    const res = await setup(good).runner.run(request({ validate: () => 'featureKey is not in the index' }));
    expect(res).toMatchObject({ kind: 'failed', errorCode: 'INVALID_OUTPUT', attempts: 2 });
    expect((res as { reason: string }).reason).toContain('featureKey is not in the index');
  });

  it('retries once at the turn limit with 1.5x the turns, then gives up', async () => {
    const turnLimit: FakeBehaviour = { exitCode: 1, lines: [JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 16, terminal_reason: 'max_turns', result: null, errors: ['Reached maximum number of turns (15)'] })] };
    const { runner, engine, store } = setup(turnLimit);
    expect(await runner.run(request({ maxTurns: 10 }))).toMatchObject({ kind: 'turn_limit', errorCode: 'TURN_LIMIT', attempts: 2 });
    expect(engine.created).toHaveLength(2);
    expect(store.runs.get('run-1')?.finished).toMatchObject({ error: 'Reached the turn limit', errorCode: 'TURN_LIMIT' });
  });

  describe('Claude-side errors (BUILD_PLAN v1 6.3)', () => {
    const errorLines = (text: string, extra: Record<string, unknown> = {}) => [JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [text], ...extra })];

    it('CLAUDE_AUTH: no retry, no failure of the ticket; the run is marked with the code', async () => {
      const { runner, engine, store } = setup({ exitCode: 1, lines: errorLines('authentication_error: invalid bearer token') });
      expect(await runner.run(request())).toMatchObject({ kind: 'claude_auth', attempts: 1 });
      expect(engine.created).toHaveLength(1);
      expect(store.runs.get('run-1')?.finished).toMatchObject({ errorCode: 'CLAUDE_AUTH' });
    });

    it('CLAUDE_USAGE_LIMIT and CLAUDE_RATE_LIMIT: pause-and-requeue results with their own code', async () => {
      const usage = await setup({ exitCode: 1, lines: errorLines('Claude usage limit reached') }).runner.run(request());
      expect(usage).toMatchObject({ kind: 'rate_limited', errorCode: 'CLAUDE_USAGE_LIMIT' });
      const rate = await setup({ exitCode: 1, lines: errorLines('too many requests', { api_error_status: 429 }) }).runner.run(request());
      expect(rate).toMatchObject({ kind: 'rate_limited', errorCode: 'CLAUDE_RATE_LIMIT' });
    });

    it('CLAUDE_API_ERROR: retries three times with 1, 4 and 10 minute waits, then gives up', async () => {
      const { runner, engine, store } = setup({ exitCode: 1, lines: errorLines('API Error: 529 overloaded_error') });
      const waits: number[] = [];
      runner.sleep = async (ms) => void waits.push(ms);
      expect(await runner.run(request())).toMatchObject({ kind: 'failed', errorCode: 'CLAUDE_API_ERROR', attempts: 4 });
      expect(engine.created).toHaveLength(4);
      expect(waits).toEqual([60_000, 240_000, 600_000]);
      expect(store.retryAt.size).toBe(3); // the next attempt's time is stored on the failed run
    });

    it('CLAUDE_API_ERROR then success: recovers without failing', async () => {
      const { runner } = setup([{ exitCode: 1, lines: errorLines('overloaded') }, good]);
      runner.sleep = async () => undefined;
      expect(await runner.run(request())).toMatchObject({ kind: 'done', attempts: 2 });
    });

    it('CLAUDE_CONTEXT_TOO_LONG: no retry', async () => {
      const { runner, engine } = setup({ exitCode: 1, lines: errorLines('Prompt is too long') });
      expect(await runner.run(request())).toMatchObject({ kind: 'failed', errorCode: 'CLAUDE_CONTEXT_TOO_LONG', attempts: 1 });
      expect(engine.created).toHaveLength(1);
    });
  });

  it('INVALID_OUTPUT: retries once with the validation errors in the prompt', async () => {
    const bad = { lines: [JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'no json here' })] };
    const { runner, engine } = setup([bad, good]);
    expect(await runner.run(request())).toMatchObject({ kind: 'done', attempts: 2 });
    expect(engine.created).toHaveLength(2);
  });

  it('CONTAINER_ERROR: a container that cannot start is retried once, then reported with its code', async () => {
    const res = await setup({ exitCode: 125, lines: [] }).runner.run(request());
    expect(res).toMatchObject({ kind: 'failed', errorCode: 'CONTAINER_ERROR', attempts: 2 });
  });

  it('reports a rate-limit rejection without retrying, so the caller can pause and re-queue', async () => {
    const rejected = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1794418200 } };
    const { runner, engine } = setup({ exitCode: 1, lines: [JSON.stringify(rejected), JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['usage limit'] })] });
    const res = await runner.run(request());
    expect(res).toMatchObject({ kind: 'rate_limited', attempts: 1 });
    expect((res as { resetsAt: Date }).resetsAt.getTime()).toBe(1794418200 * 1000);
    expect(engine.created).toHaveLength(1);
  });

  it('returns needs_input with the question', async () => {
    const { runner, store } = setup({ lines: stream({ status: 'needs_input', summary: 'q', question: 'Which database?' }) });
    expect(await runner.run(request())).toMatchObject({ kind: 'needs_input', question: 'Which database?' });
    expect(store.runs.get('run-1')?.status).toBe('needs_input');
  });

  it('kills a running stage when killRequested is set, and does not retry', async () => {
    const { runner, store, engine } = setup({ runMs: 5000 });
    setTimeout(() => store.killRequested.add('run-1'), 20);
    const res = await runner.run(request());
    expect(res).toMatchObject({ kind: 'killed', attempts: 1 });
    expect(store.runs.get('run-1')?.status).toBe('killed');
    expect(engine.handles[0]).toMatchObject({ killed: true, removed: true });
  }, 15_000);

  it('refuses a stage that needs a workspace but has none', async () => {
    await expect(setup(good).runner.run(request({ workspacePath: undefined }))).rejects.toThrow('needs a workspace');
  });

  it('hides the repository CLAUDE.md in mode ours, with an empty-file mount', async () => {
    const ws = path.join(tmp, 'ws-ours');
    mkdirSync(ws, { recursive: true });
    writeFileSync(path.join(ws, 'CLAUDE.md'), 'rules');
    const { runner, engine } = setup(good);
    await runner.run(request({ claudeMdMode: 'ours', workspacePath: ws, stage: 'implement', inputs: { ticket: { key: 'A-1', title: 't', body: 'b' } } }));
    expect(engine.created[0]?.HostConfig?.Binds).toContain(`${path.join(tmp, 'empty-file')}:/workspace/CLAUDE.md:ro`);
  });
});
