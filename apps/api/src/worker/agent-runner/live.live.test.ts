import { staticCredentials } from '../../testing/static-credentials';
import 'reflect-metadata';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { docker, leftoverAgentContainers } from '../../testing/docker-fixture';
import { MemoryStore } from '../../testing/memory-stage-run-store';
import { WorkerConfig } from '../worker-config';
import { AgentRunner } from './agent-runner';
import { DockerodeEngine } from './container-engine';
import { ContainerRunner } from './container-runner';
import { FileLogSink } from './file-log-sink';

const live = Boolean(process.env.LIVE_CLAUDE && process.env.CLAUDE_CODE_OAUTH_TOKEN);
const ROOT = path.resolve(__dirname, '../../../../..');

/** One trivial real prompt through the whole path: container, proxy, real Claude Code, parser, redaction. Costs a few cents of usage. */
describe.skipIf(!live)('live smoke test (LIVE_CLAUDE=1)', () => {
  let dataDir: string;
  beforeAll(() => {
    dataDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'sdlc-live-')));
    chmodSync(dataDir, 0o777);
  });
  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

  it('runs a trivial prompt with the real Claude CLI and returns a valid, redacted result', async () => {
    const token = process.env.CLAUDE_CODE_OAUTH_TOKEN as string;
    const config = new WorkerConfig({ DATA_DIR: dataDir, DATABASE_URL: 'unused', CLAUDE_CODE_OAUTH_TOKEN: token, GUIDELINES_DIR: path.join(ROOT, 'guidelines') } as NodeJS.ProcessEnv);
    const store = new MemoryStore();
    const runner = new AgentRunner(new ContainerRunner(new DockerodeEngine(docker)), config, staticCredentials({ claude_token: 'fake-token' }), store, new FileLogSink(config, staticCredentials({ claude_token: 'fake-token' })));
    const workspace = path.join(dataDir, 'ws');
    mkdirSync(workspace);
    chmodSync(workspace, 0o777);

    const res = await runner.run({
      projectId: 'live', stage: 'plan', stack: 'ts_node', claudeMdMode: 'both', modelAlias: 'haiku', modelAliases: { haiku: 'haiku', sonnet: 'sonnet', opus: 'opus' },
      maxTurns: 5, stageTimeoutMin: 5, workspacePath: workspace,
      inputs: { ticket: { key: 'LIVE-1', title: 'Say hello', body: 'This is a smoke test. Do not use any tools. Reply with a plan whose planMarkdown is exactly "hello", with empty risks and openQuestions.' } },
    });

    expect(res.kind).toBe('done');
    const run = [...store.runs.values()][0];
    expect(run?.status).toBe('succeeded');
    expect(run?.finished?.usage?.inputTokens).toBeGreaterThanOrEqual(0);
    expect((run?.finished?.usage?.outputTokens ?? 0) + (run?.finished?.usage?.cacheWriteTokens ?? 0)).toBeGreaterThan(0);
    expect(run?.finished?.usage?.cliVersion).toMatch(/^2\.1\./);
    const log = readFileSync(run?.finished?.logPath as string, 'utf8');
    expect(log).toContain('"type":"result"');
    expect(log).not.toContain(token);
    expect(await leftoverAgentContainers()).toEqual([]);
  });
});
