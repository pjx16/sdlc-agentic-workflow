import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const AGENT_DIR = path.resolve(__dirname, '../../../../../docker/agent');
const RUN_STAGE = path.join(AGENT_DIR, 'run-stage');
const RUN_CMD = path.join(AGENT_DIR, 'run-cmd');

/** Records how it was called, so the test can check the exact CLI arguments run-stage builds. */
const RECORDING_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.RECORD_FILE, JSON.stringify({ args: process.argv.slice(2), stdin: fs.readFileSync(0, 'utf8'), cwd: process.cwd() }));
`;

/** GNU timeout is only in the agent image (macOS has none): a minimal stand-in with the same exit code (124). */
const TIMEOUT_SHIM = `#!/bin/bash
secs=$1; shift
"$@" & pid=$!
( sleep "$secs"; kill "$pid" 2>/dev/null ) >/dev/null 2>&1 & watcher=$!
wait "$pid"; rc=$?
kill "$watcher" 2>/dev/null
[ "$rc" -eq 143 ] && exit 124
exit "$rc"
`;

let tmp: string;
let bin: string;

function writeStage(dir: string, stage: Record<string, unknown>, files: Record<string, string> = {}) {
  mkdirSync(dir, { recursive: true });
  const all: Record<string, string> = {
    'stage.json': JSON.stringify(stage),
    'prompt.md': '<!-- stage: plan -->\nDo the thing.\n',
    'system.md': 'You are a careful engineer.\nSecond line.',
    'schema.json': '{"type":"object"}',
    ...files,
  };
  for (const [name, content] of Object.entries(all)) writeFileSync(path.join(dir, name), content);
}

function runStage(contextDir: string, workspaceDir: string, record: string) {
  const res = spawnSync('bash', [RUN_STAGE], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CONTEXT_DIR: contextDir, WORKSPACE_DIR: workspaceDir, RECORD_FILE: record },
    encoding: 'utf8',
  });
  return { ...res, call: res.status === 0 ? (JSON.parse(readFileSync(record, 'utf8')) as { args: string[]; stdin: string; cwd: string }) : null };
}

beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'sdlc-scripts-'));
  bin = path.join(tmp, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'claude'), RECORDING_CLAUDE);
  writeFileSync(path.join(bin, 'timeout'), TIMEOUT_SHIM);
  chmodSync(path.join(bin, 'claude'), 0o755);
  chmodSync(path.join(bin, 'timeout'), 0o755);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('run-stage umask', () => {
  it('sets umask 000 before it starts the agent, for the same reason as run-cmd', () => {
    expect(readFileSync(RUN_STAGE, 'utf8')).toMatch(/^umask 000$/m);
  });
});

describe('run-stage (BUILD_PLAN 6.4)', () => {
  it('builds the documented claude command from stage.json and feeds the prompt on stdin', () => {
    const ctx = path.join(tmp, 'ctx1');
    const ws = path.join(tmp, 'ws1');
    mkdirSync(ws);
    writeStage(ctx, { model: 'sonnet', maxTurns: 15, disallowedTools: ['WebFetch', 'WebSearch'] });
    const { status, call } = runStage(ctx, ws, path.join(tmp, 'rec1.json'));
    expect(status).toBe(0);
    expect(call?.args).toEqual([
      '-p', '--model', 'sonnet', '--max-turns', '15', '--output-format', 'stream-json', '--verbose',
      '--json-schema', '{"type":"object"}',
      '--append-system-prompt', 'You are a careful engineer.\nSecond line.',
      '--disallowedTools', 'WebFetch,WebSearch',
      '--dangerously-skip-permissions',
    ]);
    expect(call?.stdin).toBe('<!-- stage: plan -->\nDo the thing.\n');
    expect(call?.cwd.endsWith('ws1')).toBe(true);
  });

  it('joins extra disallowed tools for read-only stages', () => {
    const ctx = path.join(tmp, 'ctx2');
    writeStage(ctx, { model: 'opus', maxTurns: 5, disallowedTools: ['WebFetch', 'WebSearch', 'Edit', 'Write', 'NotebookEdit'] });
    const { call } = runStage(ctx, path.join(tmp, 'nows'), path.join(tmp, 'rec2.json'));
    expect(call?.args[call.args.indexOf('--disallowedTools') + 1]).toBe('WebFetch,WebSearch,Edit,Write,NotebookEdit');
  });

  it('adds the MCP flags and the allowed tools for Jira stages, and runs without a workspace', () => {
    const ctx = path.join(tmp, 'ctx3');
    writeStage(
      ctx,
      { model: 'haiku', maxTurns: 8, disallowedTools: ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'WebFetch', 'WebSearch'], allowedTools: ['mcp__atlassian__getJiraIssue', 'mcp__atlassian__searchJiraIssuesUsingJql'], mcpConfig: true },
      { 'mcp.json': '{"mcpServers":{}}' },
    );
    const { status, call } = runStage(ctx, path.join(tmp, 'does-not-exist'), path.join(tmp, 'rec3.json'));
    expect(status).toBe(0);
    expect(call?.args).toContain('--strict-mcp-config');
    expect(call?.args[call.args.indexOf('--mcp-config') + 1]).toBe(path.join(ctx, 'mcp.json'));
    expect(call?.args[call.args.indexOf('--allowedTools') + 1]).toBe('mcp__atlassian__getJiraIssue,mcp__atlassian__searchJiraIssuesUsingJql');
  });

  it('omits the MCP and allowed-tools flags when stage.json has none', () => {
    const ctx = path.join(tmp, 'ctx4');
    writeStage(ctx, { model: 'haiku', maxTurns: 3, disallowedTools: [] });
    const { call } = runStage(ctx, tmp, path.join(tmp, 'rec4.json'));
    expect(call?.args).not.toContain('--mcp-config');
    expect(call?.args).not.toContain('--allowedTools');
  });

  it('fails fast with exit 64 when a context file is missing', () => {
    const ctx = path.join(tmp, 'ctx5');
    writeStage(ctx, { model: 'haiku', maxTurns: 3, disallowedTools: [] });
    rmSync(path.join(ctx, 'schema.json'));
    const res = spawnSync('bash', [RUN_STAGE], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CONTEXT_DIR: ctx }, encoding: 'utf8' });
    expect(res.status).toBe(64);
    expect(res.stderr).toContain('missing');
  });
});

describe('run-cmd (BUILD_PLAN 6.4)', () => {
  const run = (cmd: string, env: Record<string, string> = {}) =>
    spawnSync('bash', [RUN_CMD], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, WORKSPACE_DIR: tmp, CMD: cmd, ...env }, encoding: 'utf8' });

  it('runs the command in the workspace and passes its output and exit code through', () => {
    writeFileSync(path.join(tmp, 'marker.txt'), 'here');
    const ok = run('cat marker.txt && echo done');
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe('heredone\n');
    expect(run('echo oops >&2; exit 3').status).toBe(3);
  });

  it('creates files and folders open to everyone (umask 000), so the worker, a different user, can still change and delete them', () => {
    const res = run('mkdir made-dir && touch made-file && mkdir made-dir/inner');
    expect(res.status).toBe(0);
    expect(statSync(path.join(tmp, 'made-file')).mode & 0o777).toBe(0o666);
    expect(statSync(path.join(tmp, 'made-dir')).mode & 0o777).toBe(0o777);
    expect(statSync(path.join(tmp, 'made-dir/inner')).mode & 0o777).toBe(0o777);
  });

  it('kills the command at the timeout with exit code 124', () => {
    const res = run('sleep 5', { VERIFY_TIMEOUT: '1' });
    expect(res.status).toBe(124);
  });

  it('requires CMD and a workspace', () => {
    expect(spawnSync('bash', [RUN_CMD], { env: { ...process.env, PATH: process.env.PATH }, encoding: 'utf8' }).status).not.toBe(0);
    expect(run('true', { WORKSPACE_DIR: path.join(tmp, 'missing') }).status).toBe(66);
  });
});
