import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../../prisma/prisma.service';
import { FakeJira, FakeJiraClients } from '../../testing/fake-jira';
import { type TestDatabase, createTestDatabase } from '../../testing/test-db';
import { IntakePoller } from './intake-poller';
import { McpIntake } from './mcp-intake';

const jt = (key: string) => ({ key, summary: `Summary ${key}`, description: `Body ${key}`, issuetype: 'Bug', labels: [], priority: null });

describe('MCP-mode intake (F3)', () => {
  let db: TestDatabase;
  let prisma: PrismaService;
  let jira: FakeJira;
  let mcp: McpIntake;
  let clock = 1_000_000;
  let n = 0;

  const project = (over: Record<string, unknown> = {}) =>
    prisma.project.create({ data: { name: `p${++n}`, repoUrl: 'https://x/y', stack: 'ts_node', testCmdTemplate: 'x {files}', localKeyPrefix: `L${n}`, jiraMode: 'mcp', jiraProjectKey: 'ABC', jiraJql: 'project = ABC', mirrorStatus: 'ok', ...over } });

  beforeAll(async () => {
    db = await createTestDatabase();
    process.env.DATABASE_URL = db.url;
    prisma = new PrismaService();
    await prisma.onModuleInit();
    const clients = new FakeJiraClients();
    jira = clients.jira;
    mcp = new McpIntake(prisma, new IntakePoller(prisma, clients, () => clock), () => clock);
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
    jira.tickets = [jt('ABC-1')];
    jira.calls = [];
    jira.searches = [];
    clock += 24 * 3600_000;
  });

  it('polls a project in MCP mode and stores new tickets once', async () => {
    const p = await project();
    await mcp.check();
    expect(await prisma.ticket.findMany({ where: { projectId: p.id } })).toMatchObject([{ key: 'ABC-1', externalKey: 'ABC-1', source: 'jira', status: 'NEW', type: 'bug' }]);
    clock += 901_000;
    await mcp.check();
    expect(await prisma.ticket.count()).toBe(1);
  });

  it('does not poll REST or off projects', async () => {
    await project({ jiraMode: 'rest' });
    await project({ jiraMode: 'off' });
    await mcp.check();
    expect(jira.calls).toEqual([]);
  });

  it('waits mcpPollIntervalSec (default 900) between polls of a project, each project on its own clock', async () => {
    await project();
    await project({ settings: { intake: { mcpPollIntervalSec: 3600 } } });
    await mcp.check();
    expect(jira.calls).toEqual(['search', 'search']);
    clock += 600_000;
    await mcp.check();
    expect(jira.calls).toHaveLength(2);
    clock += 400_000; // 1000 s: only the default-interval project is due
    await mcp.check();
    expect(jira.calls).toHaveLength(3);
    clock += 3_000_000;
    await mcp.check();
    expect(jira.calls).toHaveLength(5);
  });

  it('is skipped while the pipeline is paused, and while intake is paused', async () => {
    await project();
    await prisma.globalSettings.create({ data: { id: 'global', pipelinePaused: true } });
    await mcp.check();
    expect(jira.calls).toEqual([]);
    await prisma.globalSettings.update({ where: { id: 'global' }, data: { pipelinePaused: false, intakePaused: true } });
    await mcp.check();
    expect(jira.calls).toEqual([]);
    await prisma.globalSettings.update({ where: { id: 'global' }, data: { intakePaused: false } });
    await mcp.check();
    expect(jira.calls).toEqual(['search']);
  });

  it('an intake that fails does not stop the other projects or throw', async () => {
    await project();
    jira.failWith = new Error('malformed');
    await expect(mcp.check()).resolves.toBeUndefined();
    expect(await prisma.ticket.count()).toBe(0);
  });
});
