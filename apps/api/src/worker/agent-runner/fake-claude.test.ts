import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { STAGE_NAMES, type StageName } from '@sdlc/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorkerConfig } from '../worker-config';
import { buildCreateOptions } from './container-options';
import { isRateLimited, parseStream } from './result-parser';

const ROOT = path.resolve(__dirname, '../../../../..');
const FAKE = path.join(ROOT, 'test/fake-claude/fake-claude.js');
const WRAPPER = path.join(ROOT, 'test/fake-claude/claude');
const SCENARIOS = path.join(ROOT, 'test/fake-claude/scenarios');

let tmp: string;
let n = 0;

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  lines: string[];
  ws: string;
  seconds: number;
}

function run(stage: StageName, scenario: string, opts: { attempt?: number; env?: Record<string, string>; scenariosDir?: string } = {}): Run {
  const ws = path.join(tmp, `ws-${++n}`);
  mkdirSync(ws);
  const started = Date.now();
  const res = spawnSync('node', [FAKE], {
    cwd: ws,
    input: `<!-- stage: ${stage} -->\nDo the thing.\n`,
    encoding: 'utf8',
    env: { ...process.env, FAKE_SCENARIO: scenario, FAKE_SCENARIOS_DIR: opts.scenariosDir ?? SCENARIOS, FAKE_ATTEMPT: String(opts.attempt ?? 1), ...opts.env },
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, lines: res.stdout.split('\n').filter(Boolean), ws, seconds: (Date.now() - started) / 1000 };
}

beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'sdlc-fake-'));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('fake-claude (BUILD_PLAN 11)', () => {
  it('prints valid stream-json that the real parser accepts: init, assistant, result with usage and cost', () => {
    const r = run('plan', 'ok');
    expect(r.status).toBe(0);
    const types = r.lines.map((l) => (JSON.parse(l) as { type: string }).type);
    expect(types).toEqual(['system', 'assistant', 'rate_limit_event', 'result']);
    const p = parseStream(r.lines, 'plan');
    expect(p.kind).toBe('ok');
    expect(p.envelope?.status).toBe('done');
    expect(p.usage).toMatchObject({ inputTokens: 100, outputTokens: 200, cliVersion: 'fake-claude' });
    expect(p.rateLimit).toMatchObject({ fiveHourPct: 25, sevenDayPct: 5, status: 'allowed' });
  });

  it('applies edits relative to the working directory and reports them', () => {
    const r = run('implement', 'ok');
    expect(r.status).toBe(0);
    expect(readFileSync(path.join(r.ws, 'src/feature.ts'), 'utf8')).toBe('export const feature = 1;\n');
    expect(parseStream(r.lines, 'implement').envelope?.data).toEqual({ filesChanged: ['src/feature.ts'] });
  });

  it('the sh wrapper that is mounted over the claude binary runs the stub', () => {
    const ws = path.join(tmp, 'ws-wrapper');
    mkdirSync(ws);
    const res = spawnSync('sh', [WRAPPER, '-p', '--model', 'x'], {
      cwd: ws, input: '<!-- stage: plan -->\n', encoding: 'utf8',
      env: { ...process.env, FAKE_CLAUDE_JS: FAKE, FAKE_SCENARIO: 'ok', FAKE_SCENARIOS_DIR: SCENARIOS, FAKE_ATTEMPT: '1' },
    });
    expect(res.status).toBe(0);
    expect(parseStream(res.stdout.split('\n').filter(Boolean), 'plan').kind).toBe('ok');
  });

  it('applies deletes', () => {
    const dir = path.join(tmp, 'sc-delete');
    mkdirSync(path.join(dir, 's'), { recursive: true });
    writeFileSync(path.join(dir, 's', 'implement.json'), JSON.stringify([{ edits: [{ path: 'a.txt', content: 'x' }], deletes: ['old.txt'], result: { status: 'done', summary: 's', data: { filesChanged: [] } } }]));
    const ws = path.join(tmp, 'ws-del');
    mkdirSync(ws);
    writeFileSync(path.join(ws, 'old.txt'), 'old');
    const res = spawnSync('node', [FAKE], { cwd: ws, input: '<!-- stage: implement -->\n', encoding: 'utf8', env: { ...process.env, FAKE_SCENARIO: 's', FAKE_SCENARIOS_DIR: dir, FAKE_ATTEMPT: '1' } });
    expect(res.status).toBe(0);
    expect(existsSync(path.join(ws, 'old.txt'))).toBe(false);
    expect(readdirSync(ws)).toEqual(['a.txt']);
  });

  it('refuses to write outside the workspace', () => {
    const dir = path.join(tmp, 'sc-escape');
    mkdirSync(path.join(dir, 's'), { recursive: true });
    writeFileSync(path.join(dir, 's', 'implement.json'), JSON.stringify([{ edits: [{ path: '../escaped.txt', content: 'x' }], result: { status: 'done', summary: 's', data: { filesChanged: [] } } }]));
    const r = run('implement', 's', { scenariosDir: dir });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('escapes the workspace');
    expect(existsSync(path.join(tmp, 'escaped.txt'))).toBe(false);
  });

  it('uses attempt n of the scenario and repeats the last entry', () => {
    expect(parseStream(run('plan', 'schema-retry', { attempt: 1 }).lines, 'plan').kind).toBe('invalid_output');
    expect(parseStream(run('plan', 'schema-retry', { attempt: 2 }).lines, 'plan').kind).toBe('ok');
    expect(parseStream(run('plan', 'schema-retry', { attempt: 5 }).lines, 'plan').kind).toBe('ok');
  });

  it('reads the attempt number from /context/stage.json when FAKE_ATTEMPT is not set', () => {
    const ctx = path.join(tmp, 'ctx');
    mkdirSync(ctx);
    writeFileSync(path.join(ctx, 'stage.json'), JSON.stringify({ attempt: 2 }));
    const r = run('plan', 'schema-retry', { env: { FAKE_ATTEMPT: '', CONTEXT_DIR: ctx } });
    expect(parseStream(r.lines, 'plan').kind).toBe('ok');
  });

  it('plays the other scenarios: schema failure, turn limit, needs_input, rate limit, fenced fallback', () => {
    expect(parseStream(run('plan', 'schema-fail').lines, 'plan').kind).toBe('invalid_output');

    const turn = run('plan', 'turn-limit');
    expect(turn.status).toBe(1);
    expect(parseStream(turn.lines, 'plan').kind).toBe('turn_limit');

    expect(parseStream(run('plan', 'needs-input').lines, 'plan').envelope).toMatchObject({ status: 'needs_input', question: 'Which database should be used?' });

    const limited = run('plan', 'rate-limit');
    expect(limited.status).toBe(1);
    expect(isRateLimited(parseStream(limited.lines, 'plan'))).toBe(true);

    const fenced = run('plan', 'fenced');
    expect(JSON.parse(fenced.lines.at(-1) as string).structured_output).toBeUndefined();
    expect(parseStream(fenced.lines, 'plan').kind).toBe('ok');
  });

  it('honours delayMs (for timeout and kill tests) and exitCode', () => {
    const dir = path.join(tmp, 'sc-delay');
    mkdirSync(path.join(dir, 's'), { recursive: true });
    writeFileSync(path.join(dir, 's', 'plan.json'), JSON.stringify([{ delayMs: 600, exitCode: 7, result: { status: 'blocked', summary: 'x' } }]));
    const r = run('plan', 's', { scenariosDir: dir });
    expect(r.seconds).toBeGreaterThanOrEqual(0.55);
    expect(r.status).toBe(7);
  });

  it('fails clearly on a missing scenario or a prompt without a stage marker', () => {
    const missing = run('plan', 'does-not-exist');
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('no scenario file');
    const noMarker = spawnSync('node', [FAKE], { input: 'hello', encoding: 'utf8' });
    expect(noMarker.status).toBe(2);
    expect(noMarker.stderr).toContain('<!-- stage:');
  });

  it('has an ok scenario for the stages the runner tests use, and a default', () => {
    for (const stage of ['plan', 'implement', 'review'] as StageName[]) {
      expect(existsSync(path.join(SCENARIOS, 'ok', `${stage}.json`)), stage).toBe(true);
      expect(existsSync(path.join(SCENARIOS, 'default', `${stage}.json`)), stage).toBe(true);
    }
    expect(STAGE_NAMES).toContain('plan');
  });
});

describe('test overlay wiring', () => {
  it('reads extra binds and env for agent containers from the environment', () => {
    const config = new WorkerConfig({
      DATA_DIR: '/data', DATABASE_URL: 'x',
      AGENT_EXTRA_BINDS: '/repo/test/fake-claude/claude:/usr/local/bin/claude:ro, /repo/s:/fake-claude/scenarios:ro',
      AGENT_EXTRA_ENV: 'FAKE_SCENARIO=ok,FAKE_SCENARIOS_DIR=/fake-claude/scenarios',
    } as NodeJS.ProcessEnv);
    expect(config.agentExtraBinds).toEqual(['/repo/test/fake-claude/claude:/usr/local/bin/claude:ro', '/repo/s:/fake-claude/scenarios:ro']);
    expect(config.agentExtraEnv).toEqual({ FAKE_SCENARIO: 'ok', FAKE_SCENARIOS_DIR: '/fake-claude/scenarios' });
    expect(new WorkerConfig({ DATA_DIR: '/data', DATABASE_URL: 'x' } as NodeJS.ProcessEnv).agentExtraBinds).toEqual([]);
  });

  it('mounts the extra binds into the container', () => {
    const binds = buildCreateOptions({ name: 'n', image: 'i', cmd: ['run-stage'], env: {}, memory: '1g', cpus: 1, timeoutMs: 1, extraBinds: ['/a:/usr/local/bin/claude:ro'] }).HostConfig?.Binds;
    expect(binds).toContain('/a:/usr/local/bin/claude:ro');
  });

  it('the compose overlay mounts the stub over the claude binary', () => {
    const overlay = readFileSync(path.join(ROOT, 'docker-compose.test.yml'), 'utf8');
    expect(overlay).toContain('test/fake-claude/claude:/usr/local/bin/claude:ro');
    expect(overlay).toContain('test/fake-claude:/fake-claude:ro');
    expect(overlay).toContain('AGENT_EXTRA_BINDS');
  });
});
