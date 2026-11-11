import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorkerConfig } from '../worker-config';
import { FileLogSink } from './file-log-sink';

const claude = 'sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
let tmp: string;
let sink: FileLogSink;

beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'sdlc-logs-'));
  sink = new FileLogSink(new WorkerConfig({ DATA_DIR: tmp, DATABASE_URL: 'x', CLAUDE_CODE_OAUTH_TOKEN: claude, GITHUB_TOKEN: 'gh-secret-token-123', JIRA_API_TOKEN: 'jira-secret-token-456' } as NodeJS.ProcessEnv));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('FileLogSink (F5)', () => {
  it('writes redacted lines to logs/<stageRunId>.log and returns the path', async () => {
    const log = sink.open('run-1');
    log.write('{"type":"system"}');
    log.write(`env dump: CLAUDE_CODE_OAUTH_TOKEN=${claude} GITHUB_TOKEN=gh-secret-token-123`);
    log.write('jira jira-secret-token-456 done');
    const file = await log.close();
    expect(file).toBe(path.join(tmp, 'logs', 'run-1.log'));
    const text = readFileSync(file as string, 'utf8');
    expect(text.split('\n')).toEqual(['{"type":"system"}', 'env dump: CLAUDE_CODE_OAUTH_TOKEN=[REDACTED] GITHUB_TOKEN=[REDACTED]', 'jira [REDACTED] done', '']);
    for (const secret of [claude, 'gh-secret-token-123', 'jira-secret-token-456']) expect(text).not.toContain(secret);
  });

  it('redacts per-run extra secrets', async () => {
    const log = sink.open('run-2', ['per-run-jira-basic-value']);
    log.write('header per-run-jira-basic-value sent');
    const text = readFileSync((await log.close()) as string, 'utf8');
    expect(text).toBe('header [REDACTED] sent\n');
  });

  it('appends when the same run is opened again (a retry keeps one file per StageRun)', async () => {
    const a = sink.open('run-3');
    a.write('one');
    await a.close();
    const b = sink.open('run-3');
    b.write('two');
    expect(readFileSync((await b.close()) as string, 'utf8')).toBe('one\ntwo\n');
  });
});
