import { staticCredentials } from '../../testing/static-credentials';
import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../../prisma/prisma.service';
import { type TestDatabase, createTestDatabase } from '../../testing/test-db';
import { ContainerRunner } from '../agent-runner/container-runner';
import { FakeEngine } from '../agent-runner/fake-engine';
import { VerifyService } from '../verify/verify.service';
import { WorkerConfig } from '../worker-config';
import { GitRunner } from './git-runner';
import { MirrorService } from './mirror.service';
import { WorkspaceService } from './workspace.service';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

describe('WorkspaceService', () => {
  let db: TestDatabase;
  let prisma: PrismaService;
  let tmp: string;
  let config: WorkerConfig;
  let engine: FakeEngine;
  let service: WorkspaceService;
  let source: string;
  let projectId: string;
  let n = 0;

  const ticket = (over: Record<string, unknown> = {}) => prisma.ticket.create({ data: { projectId, key: `ABC-${++n}`, source: 'jira', externalKey: `ABC-${n}`, title: 'Add CSV export', type: 'story', ...over } });

  beforeAll(async () => {
    db = await createTestDatabase();
    process.env.DATABASE_URL = db.url;
    prisma = new PrismaService();
    await prisma.onModuleInit();
    tmp = mkdtempSync(path.join(tmpdir(), 'sdlc-wss-'));
    source = path.join(tmp, 'source');
    execFileSync('git', ['init', '-q', '-b', 'dev', source]);
    writeFileSync(path.join(source, 'package.json'), '{}');
    sh(source, 'add', '.');
    sh(source, 'commit', '-q', '-m', 'init');
    config = new WorkerConfig({ DATA_DIR: path.join(tmp, 'data'), DATABASE_URL: db.url, TEST_PUSH_URL_PREFIXES: 'file://' } as NodeJS.ProcessEnv);
    const project = await prisma.project.create({ data: { name: 'p', repoUrl: `file://${source}`, baseBranch: 'dev', stack: 'ts_node', installCmd: 'npm ci', testCmdTemplate: 'x {files}', localKeyPrefix: 'P', mirrorStatus: 'pending' } });
    projectId = project.id;
    await new MirrorService(prisma, config, staticCredentials()).clone(project); // a real mirror of the local repository
    engine = new FakeEngine({ lines: ['added 120 packages'] });
    service = new WorkspaceService(prisma, config, new GitRunner({ token: async () => '' }), new VerifyService(new ContainerRunner(engine), config), staticCredentials());
  }, 180_000);
  afterAll(async () => {
    await prisma?.onModuleDestroy();
    await db?.drop();
    rmSync(tmp, { recursive: true, force: true });
  });
  beforeEach(async () => {
    engine.created.length = 0;
    await prisma.event.deleteMany();
    await prisma.project.update({ where: { id: projectId }, data: { installCmd: 'npm ci', mirrorStatus: 'ok' } });
  });

  it('creates the workspace on the ticket branch, records the branch, and runs the install through run-cmd', async () => {
    const t = await ticket();
    const res = await service.prepare(t.id);
    expect(res).toMatchObject({ created: true, branch: `feature/${t.key}-add-csv-export`, install: { ok: true } });
    expect(res.path).toBe(path.join(tmp, 'data', 'workspaces', projectId, t.key));
    expect(sh(res.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(`feature/${t.key}-add-csv-export`);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).branch).toBe(res.branch);
    const created = engine.created[0];
    expect(created?.Cmd).toEqual(['run-cmd']);
    expect(created?.Env).toContain('CMD=npm ci');
    expect(created?.HostConfig?.Binds?.[0]).toBe(`${res.path}:/workspace:rw`);
    expect(created?.HostConfig?.Binds).toContain('sdlc_npm_cache:/npm-cache:rw');
    expect(created?.Env).toContain('npm_config_cache=/npm-cache');
  });

  it('uses the right branch prefix for bugs and tech tickets', async () => {
    expect((await service.prepare((await ticket({ type: 'bug', title: 'Fix crash' })).id)).branch).toMatch(/^bugfix\/ABC-\d+-fix-crash$/);
    expect((await service.prepare((await ticket({ type: 'tech', title: 'Upgrade Node' })).id)).branch).toMatch(/^tech\/ABC-\d+-upgrade-node$/);
  });

  it('reuses an existing workspace without installing again when dependencies are there', async () => {
    const t = await ticket();
    const first = await service.prepare(t.id);
    mkdirSync(path.join(first.path, 'node_modules'));
    engine.created.length = 0;
    const second = await service.prepare(t.id);
    expect(second).toMatchObject({ created: false, install: null, installSkipped: 'already_installed' });
    expect(engine.created).toHaveLength(0);
  });

  it('skips an empty install command with a recorded warning', async () => {
    await prisma.project.update({ where: { id: projectId }, data: { installCmd: '' } });
    const res = await service.prepare((await ticket()).id);
    expect(res).toMatchObject({ install: null, installSkipped: 'empty_command' });
    expect(engine.created).toHaveLength(0);
    expect((await prisma.event.findMany({ where: { type: 'git' } }))[0]?.message).toContain('install command is empty');
  });

  it('reports a failed install without throwing, so the caller can hold the ticket', async () => {
    const failing = new FakeEngine({ exitCode: 1, lines: ['npm ERR! 404 not found'] });
    const s = new WorkspaceService(prisma, config, new GitRunner({ token: async () => '' }), new VerifyService(new ContainerRunner(failing), config), staticCredentials());
    const res = await s.prepare((await ticket()).id);
    expect(res.install).toMatchObject({ ok: false, exitCode: 1, tail: 'npm ERR! 404 not found' });
  });

  it('refuses a project whose mirror is not ready, and unsafe ticket keys', async () => {
    await prisma.project.update({ where: { id: projectId }, data: { mirrorStatus: 'failed' } });
    await expect(service.prepare((await ticket()).id)).rejects.toThrow('mirror');
    await prisma.project.update({ where: { id: projectId }, data: { mirrorStatus: 'ok' } });
    await expect(service.prepare((await ticket({ key: '../escape' })).id)).rejects.toThrow('Unsafe ticket key');
  });
});
