import 'reflect-metadata';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../../prisma/prisma.service';
import { type TestDatabase, createTestDatabase } from '../../testing/test-db';
import { WorkerConfig } from '../worker-config';
import { CleanupService } from './cleanup.service';

const NOW = new Date('2026-11-12T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

describe('Housekeeping (F18)', () => {
  let db: TestDatabase;
  let prisma: PrismaService;
  let tmp: string;
  let config: WorkerConfig;
  let service: CleanupService;
  let projectId: string;
  let n = 0;

  const log = (name: string, ageDays: number) => {
    const file = path.join(tmp, 'logs', name);
    writeFileSync(file, 'x');
    utimesSync(file, daysAgo(ageDays), daysAgo(ageDays));
    return file;
  };
  const workspace = (key: string) => {
    const dir = config.workspacePath(projectId, key);
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'src/a.ts'), 'x');
    return dir;
  };
  /** A ticket in `status`, whose last transition to DONE (if any) was `doneDaysAgo` days ago. */
  const ticket = async (status: string, updatedDaysAgo: number, doneDaysAgo?: number) => {
    const t = await prisma.ticket.create({ data: { projectId, key: `K-${++n}`, source: 'paste', title: 't', status: status as never } });
    await prisma.$executeRaw`UPDATE "Ticket" SET "updatedAt" = ${daysAgo(updatedDaysAgo)} WHERE id = ${t.id}`;
    if (doneDaysAgo !== undefined) await prisma.stateTransition.create({ data: { ticketId: t.id, fromStatus: 'IN_HUMAN_REVIEW', toStatus: 'DONE', actor: 'system', at: daysAgo(doneDaysAgo) } });
    return t;
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    process.env.DATABASE_URL = db.url;
    prisma = new PrismaService();
    await prisma.onModuleInit();
    tmp = mkdtempSync(path.join(tmpdir(), 'sdlc-clean-'));
    config = new WorkerConfig({ DATA_DIR: tmp, DATABASE_URL: db.url } as NodeJS.ProcessEnv);
    service = new CleanupService(prisma, config, () => NOW);
    projectId = (await prisma.project.create({ data: { name: 'p', repoUrl: 'https://x/y', stack: 'ts_node', testCmdTemplate: 'x {files}', localKeyPrefix: 'P', mirrorStatus: 'ok' } })).id;
  }, 180_000);
  afterAll(async () => {
    await prisma?.onModuleDestroy();
    await db?.drop();
    rmSync(tmp, { recursive: true, force: true });
  });
  beforeEach(async () => {
    mkdirSync(path.join(tmp, 'logs'), { recursive: true });
    await prisma.globalSettings.deleteMany();
    await prisma.ticket.deleteMany();
    rmSync(path.join(tmp, 'workspaces'), { recursive: true, force: true });
  });

  it('is a daily housekeeping part', () => {
    expect(service.intervalMs).toBe(86_400_000);
  });

  it('deletes stage logs older than logRetentionDays (default 30) and keeps newer ones and other files', async () => {
    const old = log('old.log', 31);
    const fresh = log('fresh.log', 29);
    const other = log('notes.txt', 90);
    expect((await service.run()).logsDeleted).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });

  it('uses the configured log retention', async () => {
    await prisma.globalSettings.create({ data: { id: 'global', logRetentionDays: 3 } });
    const a = log('a.log', 4);
    const b = log('b.log', 2);
    await service.run();
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(true);
  });

  it('deletes the workspace of a ticket that has been DONE for more than workspaceRetentionDays (default 7)', async () => {
    const t = await ticket('DONE', 8, 8);
    const dir = workspace(t.key);
    expect((await service.run()).workspacesDeleted).toBe(1);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(path.dirname(dir))).toBe(true); // the project's workspaces folder stays
  });

  it('keeps a recently DONE ticket, and judges by when it became DONE, not by the last edit', async () => {
    const recent = await ticket('DONE', 2, 2);
    const touchedLater = await ticket('DONE', 1, 20); // became DONE long ago, but was edited yesterday
    const a = workspace(recent.key);
    const b = workspace(touchedLater.key);
    await service.run();
    expect(existsSync(a)).toBe(true);
    // Its last update is inside the retention, so it is kept for now.
    expect(existsSync(b)).toBe(true);
  });

  it('NEVER deletes the workspace of a ticket that is not DONE, however old', async () => {
    const dirs: string[] = [];
    for (const status of ['IN_PROGRESS', 'ON_HOLD', 'FAILED', 'IN_HUMAN_REVIEW', 'AWAITING_CI', 'NEW']) dirs.push(workspace((await ticket(status, 400)).key));
    expect((await service.run()).workspacesDeleted).toBe(0);
    for (const d of dirs) expect(existsSync(d)).toBe(true);
  });

  it('uses the configured workspace retention', async () => {
    await prisma.globalSettings.create({ data: { id: 'global', workspaceRetentionDays: 30 } });
    const t = await ticket('DONE', 20, 20);
    const dir = workspace(t.key);
    await service.run();
    expect(existsSync(dir)).toBe(true);
  });

  it('a DONE ticket whose workspace is already gone is not an error', async () => {
    await ticket('DONE', 40, 40);
    await expect(service.run()).resolves.toMatchObject({ workspacesDeleted: 0 });
  });

  it('check() records what it removed in the audit log', async () => {
    log('x.log', 60);
    await service.check();
    expect(await prisma.event.findMany({ where: { message: { startsWith: 'Cleanup removed 1 log' } } })).toHaveLength(1);
  });
});
