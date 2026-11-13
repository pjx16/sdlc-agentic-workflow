import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../../prisma/prisma.service';
import { FakeJira, FakeJiraClients } from '../../testing/fake-jira';
import { type TestDatabase, createTestDatabase } from '../../testing/test-db';
import { IntakePoller } from '../intake/intake-poller';
import { HeartbeatTimer, recordIntake, recordTick } from './worker-status';

let db: TestDatabase;
let prisma: PrismaService;
let jira: FakeJira;
let poller: IntakePoller;
let n = 0;
const project = (over: Record<string, unknown> = {}) =>
  prisma.project.create({ data: { name: `p${++n}`, repoUrl: 'https://x/y', stack: 'ts_node', testCmdTemplate: 'x {files}', localKeyPrefix: `S${n}`, jiraMode: 'rest', jiraProjectKey: 'ABC', jiraJql: 'project = ABC', mirrorStatus: 'ok', ...over } });
const status = () => prisma.workerStatus.findUniqueOrThrow({ where: { id: 'worker' } });
const intake = (mode: 'rest' | 'mcp' = 'rest') => prisma.workerStatus.findUniqueOrThrow({ where: { id: `intake-${mode}` } });

beforeAll(async () => {
  db = await createTestDatabase();
  process.env.DATABASE_URL = db.url;
  prisma = new PrismaService();
  await prisma.onModuleInit();
  const clients = new FakeJiraClients();
  jira = clients.jira;
  poller = new IntakePoller(prisma, clients, () => Date.now() + 10 * 60 * 1000 * ++n);
}, 180_000);
afterAll(async () => {
  await prisma?.onModuleDestroy();
  await db?.drop();
});
beforeEach(async () => {
  await prisma.event.deleteMany();
  await prisma.ticket.deleteMany();
  await prisma.project.deleteMany();
  await prisma.globalSettings.deleteMany();
  await prisma.workerStatus.deleteMany();
  jira.tickets = [];
  jira.failWith = null;
});

describe('worker status', () => {
  it('keeps a separate record per mode, so a REST poll with no projects does not hide an MCP poll', async () => {
    await recordIntake(prisma, { mode: 'mcp', projects: 1, waiting: 0, created: 2, seen: 2 });
    await recordIntake(prisma, { mode: 'rest', projects: 0, waiting: 0, created: 0, seen: 0 });
    expect(await intake('mcp')).toMatchObject({ intakeProjects: 1, intakeCreated: 2 });
    expect(await intake('rest')).toMatchObject({ intakeProjects: 0 });
  });

  it('records a heartbeat with the outcome and detail', async () => {
    await recordTick(prisma, 'not_configured', 'claude_token, github_token');
    const row = await status();
    expect(row).toMatchObject({ tickOutcome: 'not_configured', tickDetail: 'claude_token, github_token' });
    expect(Date.now() - row.heartbeatAt.getTime()).toBeLessThan(5000);
    await recordTick(prisma, 'idle');
    expect(await status()).toMatchObject({ tickOutcome: 'idle', tickDetail: null });
  });

  it('keeps the heartbeat fresh while a loop iteration is still running', async () => {
    const timer = new HeartbeatTimer(prisma, 50);
    await timer.start();
    const first = (await status()).heartbeatAt.getTime();
    // A long stage: the loop writes nothing for the whole time, the timer still beats.
    await new Promise((r) => setTimeout(r, 300));
    const later = (await status()).heartbeatAt.getTime();
    timer.stop();
    expect(later).toBeGreaterThan(first);
    // recordTick records the outcome only and leaves the heartbeat alone.
    await recordTick(prisma, 'stepped', 'SDA-1 (IN_PROGRESS)');
    expect((await status()).heartbeatAt.getTime()).toBe(later);
  });

  it('records an intake poll that found new tickets, and leaves an event', async () => {
    await project();
    jira.tickets = [{ key: 'ABC-1', summary: 's', description: 'd', issuetype: 'Story', labels: [], priority: 'High' }] as never;
    await poller.poll();
    expect(await intake()).toMatchObject({ intakeMode: 'rest', intakeProjects: 1, intakeCreated: 1, intakeSeen: 1, intakeError: null, intakeSkipped: null });
    expect((await prisma.event.findMany({ where: { type: 'jira' } })).map((e) => e.message)).toEqual(['Jira (REST) intake: 1 new ticket']);
  });

  it('records that no project uses Jira intake, and how many are waiting for their mirror', async () => {
    await poller.poll();
    expect(await intake()).toMatchObject({ intakeProjects: 0, intakeWaiting: 0 });
    await project({ mirrorStatus: 'failed' });
    await poller.poll();
    expect(await intake()).toMatchObject({ intakeProjects: 0, intakeWaiting: 1 });
  });

  it('records why a poll was skipped, and an error once (not on every repeat)', async () => {
    await project();
    await prisma.globalSettings.create({ data: { id: 'global', intakePaused: true } as never });
    await poller.poll();
    expect(await intake()).toMatchObject({ intakeSkipped: 'intake_paused' });
    await prisma.globalSettings.deleteMany();

    jira.failWith = new Error('Jira said 401');
    await poller.poll();
    expect(await intake()).toMatchObject({ intakeError: 'Jira said 401', intakeSkipped: null });
    await recordIntake(prisma, { mode: 'rest', projects: 1, waiting: 0, created: 0, seen: 0, error: 'Jira said 401' });
    expect(await prisma.event.count({ where: { message: { contains: 'intake failed: Jira said 401' } } })).toBe(1);
  });
});
