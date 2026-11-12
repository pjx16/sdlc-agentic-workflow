import 'reflect-metadata';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkerConfig } from '../worker-config';
import { VerifyService, buildTestCommand, shellQuote } from '../verify/verify.service';
import { buildCreateOptions, parseMemory, type ContainerSpec } from './container-options';
import { ContainerRunner } from './container-runner';
import { FakeEngine } from './fake-engine';
import { LineSplitter } from './line-splitter';

const spec = (over: Partial<ContainerSpec> = {}): ContainerSpec => ({
  name: 'sdlc-run-abc',
  image: 'sdlc-agent/agent:latest',
  cmd: ['run-stage'],
  env: { CLAUDE_CODE_OAUTH_TOKEN: 't', HTTPS_PROXY: 'http://proxy:3128' },
  workspace: { path: '/data/workspaces/p/KEY-1', readOnly: false },
  contextDir: '/data/runs/abc',
  memory: '4g',
  cpus: 2,
  timeoutMs: 1000,
  ...over,
});

describe('buildCreateOptions (BUILD_PLAN 6.4, F5)', () => {
  it('applies the container hardening and limits', () => {
    const o = buildCreateOptions(spec());
    expect(o).toMatchObject({ name: 'sdlc-run-abc', Image: 'sdlc-agent/agent:latest', Cmd: ['run-stage'], User: '1000:1000', Labels: { 'sdlc.agent': 'true' } });
    expect(o.HostConfig).toMatchObject({
      CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], Memory: 4 * 1024 ** 3, NanoCpus: 2e9, PidsLimit: 512,
      NetworkMode: 'sdlc_agent_net', AutoRemove: false,
    });
  });

  it('mounts workspace, read-only context and the npm cache, and nothing else', () => {
    const binds = buildCreateOptions(spec()).HostConfig?.Binds;
    expect(binds).toEqual(['/data/workspaces/p/KEY-1:/workspace:rw', '/data/runs/abc:/context:ro', 'sdlc_npm_cache:/npm-cache:rw']);
    expect(binds?.join(' ')).not.toContain('docker.sock');
  });

  it('mounts the workspace read-only for read-only stages', () => {
    const binds = buildCreateOptions(spec({ workspace: { path: '/w', readOnly: true } })).HostConfig?.Binds;
    expect(binds).toContain('/w:/workspace:ro');
  });

  it('mounts .git read-only over a read-write workspace, but not for read-only specs or workspaces without .git', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ws-'));
    mkdirSync(path.join(dir, '.git'));
    const rw = buildCreateOptions(spec({ workspace: { path: dir, readOnly: false } })).HostConfig?.Binds ?? [];
    expect(rw.indexOf(`${dir}/.git:/workspace/.git:ro`)).toBeGreaterThan(rw.indexOf(`${dir}:/workspace:rw`));
    expect(buildCreateOptions(spec({ workspace: { path: dir, readOnly: true } })).HostConfig?.Binds?.join(' ')).not.toContain('/workspace/.git');
    expect(buildCreateOptions(spec()).HostConfig?.Binds?.join(' ')).not.toContain('/workspace/.git');
  });

  it('hides files with an empty read-only bind mount (CLAUDE.md mode ours)', () => {
    const binds = buildCreateOptions(spec({ workspace: { path: '/w', readOnly: false, hide: { emptyFile: '/data/empty', names: ['CLAUDE.md', 'CLAUDE.local.md'] } } })).HostConfig?.Binds;
    expect(binds).toContain('/data/empty:/workspace/CLAUDE.md:ro');
    expect(binds).toContain('/data/empty:/workspace/CLAUDE.local.md:ro');
  });

  it('has no workspace mount for Jira stages', () => {
    const binds = buildCreateOptions(spec({ workspace: undefined })).HostConfig?.Binds ?? [];
    expect(binds.some((b) => b.includes(':/workspace'))).toBe(false);
  });

  it('passes the environment as KEY=value and only what it was given', () => {
    expect(buildCreateOptions(spec()).Env).toEqual(['CLAUDE_CODE_OAUTH_TOKEN=t', 'HTTPS_PROXY=http://proxy:3128']);
  });
});

describe('parseMemory', () => {
  it('understands k, m and g', () => {
    expect(parseMemory('4g')).toBe(4 * 1024 ** 3);
    expect(parseMemory('512m')).toBe(512 * 1024 ** 2);
    expect(parseMemory('1.5G')).toBe(1.5 * 1024 ** 3);
    expect(parseMemory('1024')).toBe(1024);
  });
  it('rejects nonsense', () => {
    expect(() => parseMemory('lots')).toThrow(/Invalid memory/);
  });
});

describe('LineSplitter', () => {
  it('reassembles lines across chunks and flushes the rest', () => {
    const lines: string[] = [];
    const s = new LineSplitter((l) => lines.push(l));
    s.push('{"a":');
    s.push('1}\n{"b":2}\r\npar');
    s.push('tial');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    s.flush();
    expect(lines).toEqual(['{"a":1}', '{"b":2}', 'partial']);
  });
});

describe('ContainerRunner', () => {
  it('runs a container, forwards its output, reports the exit code and removes it', async () => {
    const engine = new FakeEngine({ lines: ['one', 'two'], exitCode: 0 });
    const lines: string[] = [];
    let started = '';
    const result = await new ContainerRunner(engine).run(spec(), { onLine: (l) => lines.push(l), onStarted: (id) => void (started = id) });
    expect(result).toMatchObject({ containerId: 'fake-1', exitCode: 0, timedOut: false, killed: false });
    expect(lines).toEqual(['one', 'two']);
    expect(started).toBe('fake-1');
    expect(engine.handles[0]).toMatchObject({ started: true, removed: true, killed: false });
  });

  it('passes a non-zero exit code through', async () => {
    const result = await new ContainerRunner(new FakeEngine({ exitCode: 2 })).run(spec());
    expect(result.exitCode).toBe(2);
  });

  it('kills a container that exceeds the stage timeout and reports it', async () => {
    const engine = new FakeEngine({ runMs: 5000 });
    const result = await new ContainerRunner(engine).run(spec({ timeoutMs: 50 }));
    expect(result).toMatchObject({ timedOut: true, killed: false, exitCode: 137 });
    expect(engine.handles[0]).toMatchObject({ killed: true, removed: true });
    expect(result.durationMs).toBeLessThan(2000);
  });

  it('kills the container when killRequested turns true, polling repeatedly', async () => {
    const engine = new FakeEngine({ runMs: 5000 });
    let polls = 0;
    const result = await new ContainerRunner(engine).run(spec({ timeoutMs: 10_000 }), {
      killPollMs: 10,
      shouldKill: async () => ++polls >= 3,
    });
    expect(result).toMatchObject({ killed: true, timedOut: false, exitCode: 137 });
    expect(polls).toBeGreaterThanOrEqual(3);
    expect(engine.handles[0]?.removed).toBe(true);
  });

  it('keeps running when the kill poll itself fails', async () => {
    const engine = new FakeEngine({ runMs: 80, exitCode: 0 });
    const result = await new ContainerRunner(engine).run(spec({ timeoutMs: 10_000 }), {
      killPollMs: 10,
      shouldKill: async () => {
        throw new Error('db down');
      },
    });
    expect(result).toMatchObject({ exitCode: 0, killed: false });
  });

  it('removes the container even when it cannot start', async () => {
    const engine = new FakeEngine({ failStart: true });
    await expect(new ContainerRunner(engine).run(spec())).rejects.toThrow('cannot start');
    expect(engine.handles[0]?.removed).toBe(true);
  });
});

describe('Verify.runCmd', () => {
  const config = new WorkerConfig({ DATA_DIR: '/data', DATABASE_URL: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'secret-token' } as NodeJS.ProcessEnv);

  it('quotes file paths and substitutes {files}', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(buildTestCommand('npx vitest run {files}', ['a.test.ts', 'dir/b c.test.ts'])).toBe("npx vitest run 'a.test.ts' 'dir/b c.test.ts'");
    expect(buildTestCommand('npx vitest run {files}', [])).toBe('npx vitest run ');
    expect(() => shellQuote('a\0b')).toThrow();
  });

  it('runs run-cmd without the Claude token, keeps the last 60 lines and flags success', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    const engine = new FakeEngine({ lines, exitCode: 0 });
    const res = await new VerifyService(new ContainerRunner(engine), config).runCmd({ name: 'sdlc-verify-1', workspace: '/w', cmd: 'npx tsc --noEmit', timeoutSec: 60 });
    expect(res).toMatchObject({ ok: true, exitCode: 0, timedOut: false });
    expect(res.tail.split('\n')).toHaveLength(60);
    expect(res.tail.startsWith('line 41')).toBe(true);
    expect(res.output.split('\n')).toHaveLength(100);
    const created = engine.created[0];
    expect(created?.Cmd).toEqual(['run-cmd']);
    expect(created?.Env).toContain('HUSKY=0');
    expect(created?.Env).toContain('CMD=npx tsc --noEmit');
    expect(created?.Env).toContain('VERIFY_TIMEOUT=60');
    expect(created?.Env?.join(' ')).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(created?.Env?.join(' ')).not.toContain('secret-token');
  });

  it('reports failures and timeouts (exit code 124)', async () => {
    const failed = await new VerifyService(new ContainerRunner(new FakeEngine({ exitCode: 1, lines: ['boom'] })), config).runCmd({ name: 'v', workspace: '/w', cmd: 'x', timeoutSec: 5 });
    expect(failed).toMatchObject({ ok: false, exitCode: 1, timedOut: false, tail: 'boom' });
    const timeout = await new VerifyService(new ContainerRunner(new FakeEngine({ exitCode: 124 })), config).runCmd({ name: 'v', workspace: '/w', cmd: 'x', timeoutSec: 5 });
    expect(timeout).toMatchObject({ ok: false, timedOut: true });
  });

  it('substitutes {files} when files are given', async () => {
    const engine = new FakeEngine({});
    await new VerifyService(new ContainerRunner(engine), config).runCmd({ name: 'v', workspace: '/w', cmd: 'npx jest {files}', files: ['src/a.test.ts'], timeoutSec: 5 });
    expect(engine.created[0]?.Env).toContain("CMD=npx jest 'src/a.test.ts'");
  });
});
