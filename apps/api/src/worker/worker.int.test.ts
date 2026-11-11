import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalPoller } from '../jira/approval-poller';
import { PrismaModule } from '../prisma/prisma.module';
import { StateMachine } from '../state/state-machine.service';
import { FakeJiraClients } from '../testing/fake-jira';
import { IntakePoller } from './intake/intake-poller';
import { PrismaService } from '../prisma/prisma.service';
import { type TestDatabase, createTestDatabase } from '../testing/test-db';
import { MirrorService } from './git/mirror.service';
import { AdvisoryLock } from './loop/advisory-lock';
import { WorkerLoop } from './loop/worker-loop';
import { WorkerConfig } from './worker-config';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' });

describe('worker skeleton', () => {
  let db: TestDatabase;
  let tmp: string;
  let source: string;
  let prisma: PrismaService;
  let loop: WorkerLoop;
  let config: WorkerConfig;
  let close: () => Promise<void>;

  const newProject = (name: string, over: Record<string, unknown> = {}) =>
    prisma.project.create({
      data: { name, repoUrl: `file://${source}`, baseBranch: 'dev', stack: 'ts_node', testCmdTemplate: 'x {files}', localKeyPrefix: 'T', ...over },
    });

  beforeAll(async () => {
    db = await createTestDatabase();
    tmp = mkdtempSync(path.join(tmpdir(), 'sdlc-worker-'));
    source = path.join(tmp, 'source');
    execFileSync('git', ['init', '-q', '-b', 'dev', source]);
    writeFileSync(path.join(source, 'README.md'), 'hi');
    git(source, 'add', '.');
    git(source, 'commit', '-q', '-m', 'init');

    Object.assign(process.env, { DATABASE_URL: db.url, DATA_DIR: path.join(tmp, 'data'), GITHUB_TOKEN: '' });
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [
        { provide: WorkerConfig, useFactory: () => new WorkerConfig() },
        MirrorService,
        {
          provide: WorkerLoop,
          useFactory: (p: PrismaService, m: MirrorService) => {
            const jira = new FakeJiraClients();
            const states = new StateMachine(p);
            return new WorkerLoop(p, m, new IntakePoller(p, jira), new ApprovalPoller(p, jira, states), states, []);
          },
          inject: [PrismaService, MirrorService],
        },
      ],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    loop = moduleRef.get(WorkerLoop);
    config = moduleRef.get(WorkerConfig);
    close = () => moduleRef.close();
  }, 180_000);

  afterAll(async () => {
    await close?.();
    await db?.drop();
    rmSync(tmp, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await prisma.project.deleteMany();
  });

  it('clones the mirror of a pending project and marks it ok', async () => {
    const p = await newProject('good');
    await loop.tick();
    const row = await prisma.project.findUniqueOrThrow({ where: { id: p.id } });
    expect(row).toMatchObject({ mirrorStatus: 'ok', mirrorError: null });
    const mirror = config.mirrorPath(p.id);
    expect(existsSync(path.join(mirror, 'HEAD'))).toBe(true);
    expect(git(mirror, 'branch').toString()).toContain('dev');
  });

  it('fails with a clear error when the base branch is missing, and leaves no mirror behind', async () => {
    const p = await newProject('nobranch', { baseBranch: 'does-not-exist' });
    await loop.tick();
    const row = await prisma.project.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.mirrorStatus).toBe('failed');
    expect(row.mirrorError).toBe('Base branch "does-not-exist" was not found in the repository');
    expect(existsSync(config.mirrorPath(p.id))).toBe(false);
  });

  it('fails with the git error for a bad URL', async () => {
    const p = await newProject('badurl', { repoUrl: `file://${path.join(tmp, 'nope')}` });
    await loop.tick();
    const row = await prisma.project.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.mirrorStatus).toBe('failed');
    expect(row.mirrorError).toMatch(/does not appear to be a git repository|does not exist|Could not read/i);
  });

  it('does not touch disabled projects or projects that are not pending', async () => {
    const disabled = await newProject('disabled', { enabled: false });
    const done = await newProject('done', { mirrorStatus: 'ok' });
    await loop.tick();
    expect((await prisma.project.findUniqueOrThrow({ where: { id: disabled.id } })).mirrorStatus).toBe('pending');
    expect(existsSync(config.mirrorPath(done.id))).toBe(false);
  });

  it('retries a failed project after it is re-queued', async () => {
    const p = await newProject('retry', { baseBranch: 'later' });
    await loop.tick();
    expect((await prisma.project.findUniqueOrThrow({ where: { id: p.id } })).mirrorStatus).toBe('failed');
    git(source, 'branch', 'later');
    await prisma.project.update({ where: { id: p.id }, data: { mirrorStatus: 'pending', mirrorError: null } });
    await loop.tick();
    expect((await prisma.project.findUniqueOrThrow({ where: { id: p.id } })).mirrorStatus).toBe('ok');
  });

  it('does not record a stale result when the project was re-queued during the clone', async () => {
    const p = await newProject('stale');
    const service = new MirrorService(prisma, config);
    await prisma.project.update({ where: { id: p.id }, data: { baseBranch: 'dev2' } });
    await service.clone(p); // p still carries the old baseBranch
    expect((await prisma.project.findUniqueOrThrow({ where: { id: p.id } })).mirrorStatus).toBe('pending');
  });
});

describe('worker advisory lock (F4)', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  }, 180_000);
  afterAll(async () => db?.drop());

  it('lets only one worker hold the lock and frees it on release', async () => {
    const first = new AdvisoryLock(db.url);
    const second = new AdvisoryLock(db.url);
    expect(await first.acquire()).toBe(true);
    expect(await second.acquire()).toBe(false);
    await first.release();
    expect(await second.acquire()).toBe(true);
    await second.release();
  });
});
