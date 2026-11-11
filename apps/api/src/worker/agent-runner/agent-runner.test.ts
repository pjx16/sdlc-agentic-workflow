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
import type { RateLimit } from './result-parser';
import type { FinishStageRun, NewStageRun, StageRunStore } from './stage-run-store';

class MemoryStore implements StageRunStore {
  runs = new Map<string, NewStageRun & { status: string; containerId?: string; finished?: FinishStageRun }>();
  rateLimits: RateLimit[] = [];
  killRequested = new Set<string>();
  async create(run: NewStageRun) {
    const id = `run-${this.runs.size + 1}`;
    this.runs.set(id, { ...run, status: 'queued' });
    return id;
  }
  async markRunning(id: string, containerId: string) {
    Object.assign(this.runs.get(id) as object, { status: 'running', containerId });
  }
  async isKillRequested(id: string) {
    return this.killRequested.has(id);
  }
  async finish(id: string, r: FinishStageRun) {
    Object.assign(this.runs.get(id) as object, { status: r.status, finished: r });
  }
  async saveRateLimit(l: RateLimit) {
    this.rateLimits.push(l);
  }
}

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
  return { engine, store, runner: new AgentRunner(new ContainerRunner(engine), config, store, new NullLogSink()) };
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
    expect((twice as { reason: string }).reason).toContain('Timed out');
  });

  it('treats blocked and orchestrator-validation failures as failed attempts', async () => {
    const blocked = { lines: stream({ status: 'blocked', summary: 'cannot' }) };
    expect(await setup(blocked).runner.run(request())).toMatchObject({ kind: 'failed', attempts: 2 });
    const res = await setup(good).runner.run(request({ validate: () => 'featureKey is not in the index' }));
    expect(res).toMatchObject({ kind: 'failed' });
    expect((res as { reason: string }).reason).toContain('featureKey is not in the index');
  });

  it('holds immediately at the turn limit, without a retry', async () => {
    const turnLimit: FakeBehaviour = { exitCode: 1, lines: [JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 16, terminal_reason: 'max_turns', result: null, errors: ['Reached maximum number of turns (15)'] })] };
    const { runner, engine, store } = setup(turnLimit);
    expect(await runner.run(request())).toMatchObject({ kind: 'turn_limit', attempts: 1 });
    expect(engine.created).toHaveLength(1);
    expect(store.runs.get('run-1')?.finished?.error).toBe('Reached the turn limit');
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

  it('gives Jira stages the MCP proxy port, the Jira env and no workspace', async () => {
    const { runner, engine } = setup({ lines: stream({ status: 'done', summary: 'ok', data: { tickets: [] } }) });
    const res = await runner.run(request({ stage: 'jiraIntake', workspacePath: undefined, modelAlias: 'haiku', jira: { tools: ['getJiraIssue'], mcpConfigJson: '{}', env: { JIRA_BASIC: 'abc' } } }));
    expect(res.kind).toBe('done');
    const created = engine.created[0];
    expect(created?.Env).toContain('HTTPS_PROXY=http://proxy:3129');
    expect(created?.Env).toContain('JIRA_BASIC=abc');
    expect((created?.HostConfig?.Binds ?? []).some((b) => b.includes(':/workspace'))).toBe(false);
  });

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
