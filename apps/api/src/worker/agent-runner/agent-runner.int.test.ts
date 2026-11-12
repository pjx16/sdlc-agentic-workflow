import 'reflect-metadata';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../prisma/prisma.service';
import { AGENT_IMAGE, docker, leftoverAgentContainers, shellInAgent, startEgress, type EgressFixture } from '../../testing/docker-fixture';
import { type TestDatabase, createTestDatabase } from '../../testing/test-db';
import { VerifyService } from '../verify/verify.service';
import { WorkerConfig } from '../worker-config';
import { AgentRunner, type StageRequest } from './agent-runner';
import { DockerodeEngine } from './container-engine';
import { ContainerRunner } from './container-runner';
import { FileLogSink } from './file-log-sink';
import { PrismaStageRunStore } from './stage-run-store';

const ROOT = path.resolve(__dirname, '../../../../..');
const FAKE_TOKEN = 'sk-ant-oat01-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE01234567';

let db: TestDatabase;
let prisma: PrismaService;
let egress: EgressFixture;
let dataDir: string;
let projectId: string;
let n = 0;

/** A runner wired like the worker: real Docker, real database, real log files; only the model is the stub. */
function runnerFor(scenario: string, env: Record<string, string> = {}) {
  const config = new WorkerConfig({
    DATA_DIR: dataDir, DATABASE_URL: db.url, CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN, GUIDELINES_DIR: path.join(ROOT, 'guidelines'),
    AGENT_EXTRA_BINDS: `${ROOT}/test/fake-claude/claude:/usr/local/bin/claude:ro,${ROOT}/test/fake-claude:/fake-claude:ro`,
    AGENT_EXTRA_ENV: `FAKE_SCENARIO=${scenario},FAKE_SCENARIOS_DIR=/fake-claude/scenarios`, ...env,
  } as NodeJS.ProcessEnv);
  return new AgentRunner(new ContainerRunner(new DockerodeEngine(docker)), config, new PrismaStageRunStore(prisma), new FileLogSink(config));
}

function workspace(): string {
  const dir = path.join(dataDir, 'workspaces', projectId, `KEY-${++n}`);
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o777); // the agent runs as uid 1000; the worker chowns real workspaces (milestone 4)
  return dir;
}

const request = (over: Partial<StageRequest> = {}): StageRequest => ({
  projectId, stage: 'plan', stack: 'nestjs', claudeMdMode: 'both', modelAlias: 'sonnet', modelAliases: { haiku: 'haiku', sonnet: 'sonnet', opus: 'opus' },
  maxTurns: 10, stageTimeoutMin: 2, inputs: { ticket: { key: 'KEY-1', title: 'Add a thing', body: 'Please add a thing.' } }, workspacePath: workspace(), ...over,
});

beforeAll(async () => {
  db = await createTestDatabase();
  process.env.DATABASE_URL = db.url; // read by PrismaService when it is constructed
  prisma = new PrismaService();
  await prisma.onModuleInit();
  dataDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'sdlc-int-')));
  chmodSync(dataDir, 0o777);
  projectId = (await prisma.project.create({ data: { name: 'p', repoUrl: 'https://x/y', stack: 'nestjs', testCmdTemplate: 'x {files}', localKeyPrefix: 'P' } })).id;
  egress = await startEgress();
}, 240_000);

afterAll(async () => {
  await egress?.stop();
  await prisma?.onModuleDestroy();
  await db?.drop();
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(async () => {
  // The runner must always remove its containers (F5).
  expect(await leftoverAgentContainers()).toEqual([]);
});

describe('fake stage end to end, in a real container', () => {
  it('runs a read-write stage: edits reach the host workspace, and the StageRun records tokens, cost, turns and CLI version', async () => {
    const ws = workspace();
    const res = await runnerFor('ok').run(request({ stage: 'implement', workspacePath: ws }));
    expect(res).toMatchObject({ kind: 'done', attempts: 1 });
    expect(readFileSync(path.join(ws, 'src/feature.ts'), 'utf8')).toBe('export const feature = 1;\n');
    const run = await prisma.stageRun.findUniqueOrThrow({ where: { id: (res as { stageRunId: string }).stageRunId } });
    expect(run).toMatchObject({ stage: 'implement', status: 'succeeded', attempt: 1, inputTokens: 10, outputTokens: 20, numTurns: 2, cliVersion: 'fake-claude' });
    expect(Number(run.costUsd)).toBeCloseTo(0.001);
    expect(run.containerId).toBeTruthy();
    expect(run.startedAt && run.endedAt).toBeTruthy();
    expect(run.logPath).toBe(path.join(dataDir, 'logs', `${run.id}.log`));
    expect(readFileSync(run.logPath as string, 'utf8')).toContain('"type":"result"');
  }, 120_000);

  it('keeps the latest rate_limit_event as a usage snapshot', async () => {
    await prisma.usageSnapshot.deleteMany();
    await runnerFor('ok').run(request());
    const snapshot = await prisma.usageSnapshot.findFirstOrThrow();
    expect(snapshot).toMatchObject({ fiveHourPct: 25, sevenDayPct: 5, status: 'allowed', source: 'event' });
  }, 120_000);

  it('a read-only stage cannot change the workspace', async () => {
    const ws = workspace();
    const res = await runnerFor('ok').run(request({ stage: 'plan', workspacePath: ws }));
    expect(res.kind).toBe('done');
    // the plan stage mounts read-only: an edit attempt from the same container would fail
    const probe = await shellInAgent('touch /workspace/should-fail 2>&1; echo "exit=$?"', { workspace: { path: ws, readOnly: true } });
    expect(probe.lines.join(' ')).toMatch(/Read-only file system/);
    expect(existsSync(path.join(ws, 'should-fail'))).toBe(false);
  }, 120_000);

  it('a schema failure is retried once and then fails; both attempts are recorded', async () => {
    const res = await runnerFor('schema-fail').run(request());
    expect(res).toMatchObject({ kind: 'failed', attempts: 2 });
    expect((res as { reason: string }).reason).toContain('data.planMarkdown');
    const runs = await prisma.stageRun.findMany({ where: { id: (res as { stageRunId: string }).stageRunId } });
    expect(runs[0]).toMatchObject({ attempt: 2, status: 'failed' });
    const all = await prisma.stageRun.findMany({ where: { projectId, stage: 'plan', status: 'failed' }, orderBy: { attempt: 'asc' } });
    expect(all.slice(-2).map((r) => r.attempt)).toEqual([1, 2]);
  }, 180_000);

  it('a schema failure followed by a valid result on the retry succeeds on attempt 2', async () => {
    const res = await runnerFor('schema-retry').run(request());
    expect(res).toMatchObject({ kind: 'done', attempts: 2 });
  }, 180_000);

  it('accepts the fenced-JSON fallback when there is no structured_output', async () => {
    expect(await runnerFor('fenced').run(request())).toMatchObject({ kind: 'done', attempts: 1 });
  }, 120_000);

  it('kills a stage that exceeds the stage timeout, retries once, then fails', async () => {
    const started = Date.now();
    const res = await runnerFor('slow').run(request({ stageTimeoutMin: 0.05 })); // 3 seconds
    expect(res).toMatchObject({ kind: 'failed', attempts: 2 });
    expect((res as { reason: string }).reason).toContain('Timed out');
    expect(Date.now() - started).toBeLessThan(60_000);
  }, 120_000);

  it('kills a running stage when killRequested is set (the kill poll is 2 seconds)', async () => {
    const before = new Set((await prisma.stageRun.findMany({ select: { id: true } })).map((r) => r.id));
    const running = runnerFor('slow').run(request({ stageTimeoutMin: 5 }));
    let runId = '';
    for (let i = 0; i < 100 && !runId; i++) {
      const row = await prisma.stageRun.findFirst({ where: { status: 'running', id: { notIn: [...before] } } });
      if (row) runId = row.id;
      else await new Promise((r) => setTimeout(r, 200));
    }
    expect(runId).not.toBe('');
    const killedAt = Date.now();
    await prisma.stageRun.update({ where: { id: runId }, data: { killRequested: true } });
    const res = await running;
    expect(res).toMatchObject({ kind: 'killed', attempts: 1, stageRunId: runId });
    expect(Date.now() - killedAt).toBeLessThan(15_000);
    expect(await prisma.stageRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({ status: 'killed', killRequested: true });
  }, 120_000);

  it('holds at the turn limit without retrying, and reports needs_input and rate limits', async () => {
    expect(await runnerFor('turn-limit').run(request())).toMatchObject({ kind: 'turn_limit', attempts: 1 });
    expect(await runnerFor('needs-input').run(request())).toMatchObject({ kind: 'needs_input', question: 'Which database should be used?' });
    const limited = await runnerFor('rate-limit').run(request());
    expect(limited).toMatchObject({ kind: 'rate_limited', attempts: 1 });
    expect((limited as { resetsAt: Date }).resetsAt.getTime()).toBe(1794418200 * 1000);
  }, 180_000);

  it('redacts the Claude token from the log file even when the process prints it', async () => {
    const res = await runnerFor('leak').run(request());
    expect(res.kind).toBe('done');
    const run = await prisma.stageRun.findUniqueOrThrow({ where: { id: (res as { stageRunId: string }).stageRunId } });
    const log = readFileSync(run.logPath as string, 'utf8');
    expect(log).toContain('CLAUDE_CODE_OAUTH_TOKEN=[REDACTED]');
    expect(log).not.toContain(FAKE_TOKEN);
    expect(log).not.toContain('FAKEFAKEFAKE');
  }, 120_000);
});

describe('container hardening, as seen from inside the agent container', () => {
  it('runs as uid 1000 with no capabilities, no-new-privileges, the documented limits and no Docker socket', async () => {
    const ws = workspace();
    const { lines } = await shellInAgent(
      'id -u; grep -E "^(CapEff|NoNewPrivs):" /proc/self/status; cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/pids.max 2>/dev/null; ls /var/run/docker.sock 2>&1; ls /workspace >/dev/null && echo workspace-ok',
      { workspace: { path: ws, readOnly: true } },
    );
    const out = lines.join('\n');
    expect(lines[0]).toBe('1000');
    expect(out).toMatch(/CapEff:\s+0000000000000000/);
    expect(out).toMatch(/NoNewPrivs:\s+1/);
    expect(out).toContain('536870912'); // memory limit: shellInAgent uses 512m
    expect(out).toMatch(/\n512\n/);
    expect(out).toMatch(/No such file/);
    expect(out).toContain('workspace-ok');
  }, 90_000);

  it('hides the repository CLAUDE.md with an empty bind mount (mode ours)', async () => {
    const ws = workspace();
    writeFileSync(path.join(ws, 'CLAUDE.md'), 'REPO RULES THAT MUST BE HIDDEN');
    const empty = path.join(dataDir, 'empty-file');
    writeFileSync(empty, '');
    const { lines } = await shellInAgent('wc -c < /workspace/CLAUDE.md', { workspace: { path: ws, readOnly: false, hide: { emptyFile: empty, names: ['CLAUDE.md'] } } });
    expect(lines.join('').trim()).toBe('0');
    expect(readFileSync(path.join(ws, 'CLAUDE.md'), 'utf8')).toBe('REPO RULES THAT MUST BE HIDDEN'); // the host file is untouched
  }, 90_000);
});

describe('Verify.runCmd through run-cmd, in a real container', () => {
  const verify = () => {
    const config = new WorkerConfig({ DATA_DIR: dataDir, DATABASE_URL: db.url, CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN } as NodeJS.ProcessEnv);
    return new VerifyService(new ContainerRunner(new DockerodeEngine(docker)), config);
  };

  it('runs a command in the workspace, passes exit codes through, and never sees the Claude token', async () => {
    const ws = workspace();
    writeFileSync(path.join(ws, 'a.txt'), 'content');
    const ok = await verify().runCmd({ name: `sdlc-verify-${++n}`, workspace: ws, cmd: 'cat a.txt && echo "token=[${CLAUDE_CODE_OAUTH_TOKEN:-none}]"', timeoutSec: 60 });
    expect(ok).toMatchObject({ ok: true, exitCode: 0 });
    expect(ok.output).toContain('content');
    expect(ok.output).toContain('token=[none]');
    expect(await verify().runCmd({ name: `sdlc-verify-${++n}`, workspace: ws, cmd: 'echo failing >&2; exit 3', timeoutSec: 60 })).toMatchObject({ ok: false, exitCode: 3, tail: 'failing' });
  }, 120_000);

  it('enforces the verify timeout with GNU timeout (exit 124)', async () => {
    const res = await verify().runCmd({ name: `sdlc-verify-${++n}`, workspace: workspace(), cmd: 'sleep 30', timeoutSec: 2 });
    expect(res).toMatchObject({ ok: false, timedOut: true, exitCode: 124 });
  }, 120_000);

  it('substitutes and quotes {files} for test commands', async () => {
    const ws = workspace();
    const res = await verify().runCmd({ name: `sdlc-verify-${++n}`, workspace: ws, cmd: 'printf "[%s]" {files}', files: ['a b.test.ts', "it's.test.ts"], timeoutSec: 60 });
    expect(res.output).toBe("[a b.test.ts][it's.test.ts]");
  }, 90_000);
});

describe('the agent image', () => {
  it('has the pinned Claude Code, run-stage and run-cmd, and runs as the node user', async () => {
    const { lines } = await shellInAgent('claude --version; command -v run-stage; command -v run-cmd; id -un');
    expect(lines[0]).toMatch(/^2\.1\.322 /);
    expect(lines.join(' ')).toContain('/usr/local/bin/run-stage');
    expect(lines.join(' ')).toContain('/usr/local/bin/run-cmd');
    expect(lines.at(-1)).toBe('node');
    expect((await docker.getImage(AGENT_IMAGE).inspect()).Config.User).toBe('node');
  }, 90_000);
});
