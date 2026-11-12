import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalPoller } from '../../jira/approval-poller';
import { JiraStatusSync } from '../../jira/jira-status-sync';
import { PrismaService } from '../../prisma/prisma.service';
import { StateMachine } from '../../state/state-machine.service';
import { SubtasksService } from '../../subtasks/subtasks.service';
import { FakeJira, FakeJiraClients } from '../../testing/fake-jira';
import { type TestDatabase, createTestDatabase } from '../../testing/test-db';
import { IntakePoller } from './intake-poller';
import { McpIntake } from './mcp-intake';

describe('MCP-mode approvals and write-back (F3, F15)', () => {
  let db: TestDatabase;
  let prisma: PrismaService;
  let jira: FakeJira;
  let mcp: McpIntake;
  let sm: StateMachine;
  let sync: JiraStatusSync;
  let clock = 1_000_000;
  let projectId: string;
  let n = 0;

  const ticket = (over: Record<string, unknown> = {}) => prisma.ticket.create({ data: { projectId, key: `ABC-${++n}`, externalKey: `ABC-${n}`, source: 'jira', title: 't', status: 'IN_PROGRESS', ...over } });

  beforeAll(async () => {
    db = await createTestDatabase();
    process.env.DATABASE_URL = db.url;
    prisma = new PrismaService();
    await prisma.onModuleInit();
    const clients = new FakeJiraClients();
    jira = clients.jira;
    sync = new JiraStatusSync(prisma, clients);
    sm = new StateMachine(prisma, [sync]);
    const subtasks = new SubtasksService(prisma, clients);
    mcp = new McpIntake(prisma, new IntakePoller(prisma, clients, () => clock), () => clock, new ApprovalPoller(prisma, clients, sm, subtasks), subtasks, sync);
  }, 180_000);
  afterAll(async () => {
    await prisma?.onModuleDestroy();
    await db?.drop();
  });
  beforeEach(async () => {
    await prisma.ticket.deleteMany();
    await prisma.project.deleteMany();
    projectId = (
      await prisma.project.create({
        data: {
          name: `p${++n}`, repoUrl: 'https://x/y', stack: 'ts_node', testCmdTemplate: 'x {files}', localKeyPrefix: `L${n}`, jiraMode: 'mcp', jiraProjectKey: 'ABC', jiraJql: 'project = ABC', mirrorStatus: 'ok',
          settings: { jiraStatusMap: { IN_PROGRESS: 'In Progress' }, jiraApprovalStatuses: { plan: 'Plan Approved' } },
        },
      })
    ).id;
    jira.tickets = [];
    jira.calls = [];
    jira.statuses = {};
    jira.failWith = null;
    clock += 24 * 3600_000;
  });

  it('reads the Jira status of tickets awaiting approval and approves them', async () => {
    const t = await ticket({ status: 'AWAITING_PLAN_APPROVAL', planMarkdown: '# plan' });
    jira.statuses[t.externalKey as string] = 'Plan Approved';
    await mcp.check();
    expect(jira.calls).toContain(`read ${t.externalKey}`);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('BREAKDOWN');
  });

  it('approvals follow the MCP poll interval: not read again before it has passed', async () => {
    const t = await ticket({ status: 'AWAITING_PLAN_APPROVAL', planMarkdown: '# plan' });
    jira.statuses[t.externalKey as string] = 'To Do';
    await mcp.check();
    clock += 60_000;
    await mcp.check();
    expect(jira.calls.filter((c) => c.startsWith('read'))).toHaveLength(1);
  });

  it('a transition made in the API (no Jira stage there) is applied by the worker sweep', async () => {
    const t = await ticket({ status: 'IN_PROGRESS' });
    // The API process cannot reach Jira in MCP mode: the transition is stored unsynced.
    await prisma.stateTransition.create({ data: { ticketId: t.id, fromStatus: 'AWAITING_BREAKDOWN_APPROVAL', toStatus: 'IN_PROGRESS', actor: 'user', reason: 'approved' } });
    await mcp.check();
    expect(jira.calls).toContain(`transition ${t.externalKey} -> In Progress`);
    expect((await prisma.stateTransition.findFirstOrThrow({ where: { ticketId: t.id } })).jiraSyncResult).toBe('applied');
    jira.calls = [];
    await mcp.check();
    expect(jira.calls.filter((c) => c.startsWith('transition'))).toEqual([]);
  });

  it('publishes the sub-tasks the API could not, and does not hammer a failing Jira', async () => {
    const t = await ticket({ status: 'IN_PROGRESS' });
    await prisma.subtask.create({ data: { ticketId: t.id, seq: 1, title: 'one' } });
    await prisma.subtask.create({ data: { ticketId: t.id, seq: 2, title: 'two' } });
    await mcp.check();
    expect(jira.calls.filter((c) => c.startsWith('subtask'))).toHaveLength(2);
    expect((await prisma.subtask.findMany({ where: { ticketId: t.id } })).every((s) => s.externalKey)).toBe(true);

    const u = await ticket({ status: 'IN_PROGRESS' });
    await prisma.subtask.create({ data: { ticketId: u.id, seq: 1, title: 'x' } });
    jira.failWith = new Error('jira down');
    jira.calls = [];
    await mcp.check();
    clock += 60_000;
    await mcp.check();
    expect(jira.calls.filter((c) => c.startsWith('subtask'))).toHaveLength(1);
    clock += 15 * 60_000;
    await mcp.check();
    expect(jira.calls.filter((c) => c.startsWith('subtask'))).toHaveLength(2);
  });

  it('does nothing while the pipeline is paused', async () => {
    const t = await ticket({ status: 'AWAITING_PLAN_APPROVAL', planMarkdown: '# plan' });
    jira.statuses[t.externalKey as string] = 'Plan Approved';
    await prisma.globalSettings.upsert({ where: { id: 'global' }, update: { pipelinePaused: true }, create: { id: 'global', pipelinePaused: true } });
    await mcp.check();
    expect(jira.calls).toEqual([]);
    await prisma.globalSettings.update({ where: { id: 'global' }, data: { pipelinePaused: false } });
  });
});
