import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SubtasksService } from '../subtasks/subtasks.service';
import { PrismaService } from '../prisma/prisma.service';
import { StateMachine } from '../state/state-machine.service';
import { FakeJira, FakeJiraClients } from '../testing/fake-jira';
import { type TestDatabase, createTestDatabase } from '../testing/test-db';
import { ApprovalPoller } from './approval-poller';
import { JiraStatusNotFoundError, JiraUnavailableError } from './jira-client';
import { JiraNotConfiguredError } from './jira-clients';
import { JiraStatusSync } from './jira-status-sync';

describe('Jira status mapping (F15)', () => {
  let db: TestDatabase;
  let prisma: PrismaService;
  let jira: FakeJira;
  let sm: StateMachine;
  let poller: ApprovalPoller;
  let n = 0;

  const project = (over: Record<string, unknown> = {}, settings: Record<string, unknown> = {}) =>
    prisma.project.create({
      data: {
        name: `p${++n}`, repoUrl: 'https://x/y', stack: 'ts_node', testCmdTemplate: 'x {files}', localKeyPrefix: 'P', jiraMode: 'rest', jiraProjectKey: 'ABC', mirrorStatus: 'ok', ...over,
        settings: { jiraStatusMap: { KB: 'In Progress', PLANNING: 'In Progress', IN_HUMAN_REVIEW: 'In Review', DONE: 'Done' }, jiraApprovalStatuses: { plan: 'Plan Approved', breakdown: 'Ready for Dev' }, ...settings } as never,
      },
    });
  const ticket = (projectId: string, over: Record<string, unknown> = {}) =>
    prisma.ticket.create({ data: { projectId, key: `ABC-${++n}`, externalKey: `ABC-${n}`, source: 'jira', title: 't', ...over } });
  const lastTransition = async (ticketId: string) => (await prisma.stateTransition.findMany({ where: { ticketId }, orderBy: { at: 'desc' } }))[0]!;

  beforeAll(async () => {
    db = await createTestDatabase();
    process.env.DATABASE_URL = db.url;
    prisma = new PrismaService();
    await prisma.onModuleInit();
    const clients = new FakeJiraClients();
    jira = clients.jira;
    sm = new StateMachine(prisma, [new JiraStatusSync(prisma, clients)]);
    poller = new ApprovalPoller(prisma, clients, sm, new SubtasksService(prisma, clients));
  }, 180_000);
  afterAll(async () => {
    await prisma?.onModuleDestroy();
    await db?.drop();
  });
  beforeEach(async () => {
    await prisma.event.deleteMany();
    await prisma.stateTransition.deleteMany();
    await prisma.ticket.deleteMany();
    await prisma.project.deleteMany();
    jira.calls = [];
    jira.failWith = null;
    jira.statuses = {};
  });

  describe('outbound', () => {
    it('moves the Jira issue to the mapped status and records it on the transition', async () => {
      const t = await ticket((await project()).id);
      await sm.transition(t.id, 'KB', 'system');
      expect(jira.calls).toEqual([`transition ${t.externalKey} -> In Progress`]);
      expect(await lastTransition(t.id)).toMatchObject({ jiraSyncResult: 'applied', jiraStatusApplied: 'In Progress', jiraSyncError: null });
    });

    it('does nothing for a state with no mapping', async () => {
      const t = await ticket((await project()).id, { status: 'KB' });
      await sm.transition(t.id, 'PLANNING', 'system'); // mapped
      jira.calls = [];
      await sm.transition(t.id, 'AWAITING_PLAN_APPROVAL', 'system'); // not mapped
      expect(jira.calls).toEqual([]);
      expect(await lastTransition(t.id)).toMatchObject({ jiraSyncResult: 'none', jiraStatusApplied: null });
    });

    it('a failed Jira move is stored as a warning and never blocks the transition', async () => {
      const t = await ticket((await project()).id);
      jira.failWith = new Error('Jira 500: boom');
      const res = await sm.transition(t.id, 'KB', 'system');
      expect(res.ticket.status).toBe('KB'); // the pipeline moved on
      expect(await lastTransition(t.id)).toMatchObject({ jiraSyncResult: 'failed', jiraStatusApplied: 'In Progress', jiraSyncError: 'Jira 500: boom' });
      expect((await prisma.event.findMany({ where: { ticketId: t.id, type: 'jira' } }))[0]?.message).toContain('failed');
    });

    it('handles a mapped status that does not exist in Jira', async () => {
      const t = await ticket((await project({}, { jiraStatusMap: { KB: 'Shipped' } })).id);
      const res = await sm.transition(t.id, 'KB', 'system');
      expect(res.ticket.status).toBe('KB');
      const row = await lastTransition(t.id);
      expect(row.jiraSyncResult).toBe('failed');
      expect(row.jiraSyncError).toContain('no transition to "Shipped"');
      expect(new JiraStatusNotFoundError('A-1', 'x', []).message).toContain('no transition');
    });

    it('records "Jira unavailable" and "not configured" failures too', async () => {
      const t = await ticket((await project()).id);
      jira.failWith = new JiraUnavailableError('Jira is unavailable after 4 attempts (HTTP 503)', 4);
      await sm.transition(t.id, 'KB', 'system');
      expect((await lastTransition(t.id)).jiraSyncError).toContain('unavailable');
      const t2 = await ticket((await project()).id);
      jira.failWith = new JiraNotConfiguredError();
      await sm.transition(t2.id, 'KB', 'system');
      expect((await lastTransition(t2.id)).jiraSyncError).toContain('not configured');
    });

    it('MCP mode moves the issue through the MCP client where the worker has one, and leaves the transition unsynced where it has not', async () => {
      const p = await project({ jiraMode: 'mcp' });
      const t = await ticket(p.id);
      await sm.transition(t.id, 'KB', 'system');
      expect((await lastTransition(t.id)).jiraSyncResult).toBe('applied');
      expect(jira.calls).toHaveLength(1);

      jira.calls = [];
      class ApiOnlyClients extends FakeJiraClients {
        override hasMcp() {
          return false;
        }
      }
      const apiSm = new StateMachine(prisma, [new JiraStatusSync(prisma, new ApiOnlyClients(jira))]);
      const t2 = await ticket(p.id);
      await apiSm.transition(t2.id, 'KB', 'user');
      expect(jira.calls).toEqual([]);
      expect((await lastTransition(t2.id)).jiraSyncResult).toBe('none');
    });

    it('skips pasted tickets, projects with Jira off, and write-back turned off', async () => {
      const p = await project();
      const pasted = await prisma.ticket.create({ data: { projectId: p.id, key: 'P-1', source: 'paste', title: 't' } });
      await sm.transition(pasted.id, 'KB', 'system');
      const off = await ticket((await project({ jiraMode: 'off' })).id);
      await sm.transition(off.id, 'KB', 'system');
      const noWrite = await ticket((await project({}, { jiraWriteBack: { transitions: false } })).id);
      await sm.transition(noWrite.id, 'KB', 'system');
      expect(jira.calls).toEqual([]);
      for (const id of [pasted.id, off.id, noWrite.id]) expect((await lastTransition(id)).jiraSyncResult).toBe('none');
    });
  });

  describe('inbound approval (REST mode)', () => {
    it('approves a plan when the Jira status equals the configured approval status', async () => {
      const t = await ticket((await project()).id, { status: 'AWAITING_PLAN_APPROVAL' });
      jira.statuses[t.externalKey!] = 'plan approved';
      expect(await poller.check()).toBe(1);
      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('BREAKDOWN');
      expect(await lastTransition(t.id)).toMatchObject({ fromStatus: 'AWAITING_PLAN_APPROVAL', toStatus: 'BREAKDOWN', actor: 'jira' });
    });

    it('on plan approval, re-reads the issue so edits made in Jira reach the breakdown', async () => {
      const t = await ticket((await project()).id, { status: 'AWAITING_PLAN_APPROVAL', title: 'old title', body: 'old body' });
      jira.statuses[t.externalKey!] = 'Plan Approved';
      const original = jira.readStatus.bind(jira);
      jira.readStatus = async (key: string) => ({ ...(await original(key)), summary: 'Edited in Jira', description: 'New description from Jira' });
      expect(await poller.check()).toBe(1);
      expect(await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ status: 'BREAKDOWN', title: 'Edited in Jira', body: 'New description from Jira' });
      jira.readStatus = original;
    });

    it('on breakdown approval, creates the Subtask rows from the proposed list first', async () => {
      const draft = [{ seq: 1, title: 'first', description: 'd', acceptanceCriteria: ['c'], files: [], dependsOn: [] }, { seq: 2, title: 'second', description: 'd', acceptanceCriteria: ['c'], files: [], dependsOn: [1] }];
      const t = await ticket((await project()).id, { status: 'AWAITING_BREAKDOWN_APPROVAL', breakdownDraft: draft });
      jira.statuses[t.externalKey!] = 'Ready for Dev';
      expect(await poller.check()).toBe(1);
      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('IN_PROGRESS');
      expect((await prisma.subtask.findMany({ where: { ticketId: t.id }, orderBy: { seq: 'asc' } })).map((s) => s.title)).toEqual(['first', 'second']);
    });

    it('does not approve a breakdown from Jira when the proposed list is invalid', async () => {
      const t = await ticket((await project()).id, { status: 'AWAITING_BREAKDOWN_APPROVAL', breakdownDraft: [{ seq: 1, title: 'x', acceptanceCriteria: [], dependsOn: [] }] });
      jira.statuses[t.externalKey!] = 'Ready for Dev';
      expect(await poller.check()).toBe(0);
      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('AWAITING_BREAKDOWN_APPROVAL');
      expect(await prisma.subtask.count({ where: { ticketId: t.id } })).toBe(0);
    });

    it('approves a breakdown, and ignores any other Jira status', async () => {
      const p = await project();
      const a = await ticket(p.id, { status: 'AWAITING_BREAKDOWN_APPROVAL', breakdownDraft: [{ seq: 1, title: 'only', description: '', acceptanceCriteria: ['c'], files: [], dependsOn: [] }] });
      const b = await ticket(p.id, { status: 'AWAITING_PLAN_APPROVAL' });
      jira.statuses[a.externalKey!] = 'Ready for Dev';
      jira.statuses[b.externalKey!] = 'In Progress'; // a manual change that must be ignored
      expect(await poller.check()).toBe(1);
      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('IN_PROGRESS');
      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('AWAITING_PLAN_APPROVAL');
    });

    it('only looks at REST-mode Jira tickets that are awaiting approval', async () => {
      const rest = await project();
      await ticket(rest.id, { status: 'PLANNING' });
      await prisma.ticket.create({ data: { projectId: rest.id, key: 'P-9', source: 'paste', status: 'AWAITING_PLAN_APPROVAL', title: 'pasted' } });
      await ticket((await project({ jiraMode: 'mcp' })).id, { status: 'AWAITING_PLAN_APPROVAL' });
      await ticket((await project({ enabled: false })).id, { status: 'AWAITING_PLAN_APPROVAL' });
      await ticket((await project({}, { jiraApprovalStatuses: {} })).id, { status: 'AWAITING_PLAN_APPROVAL' });
      jira.calls = [];
      expect(await poller.check()).toBe(0);
      expect(jira.calls).toEqual([]);
    });

    it('one failing ticket does not stop the others, but Jira being down does', async () => {
      const p = await project();
      const bad = await ticket(p.id, { status: 'AWAITING_PLAN_APPROVAL' });
      const good = await ticket(p.id, { status: 'AWAITING_PLAN_APPROVAL' });
      jira.statuses[good.externalKey!] = 'Plan Approved';
      const original = jira.readStatus.bind(jira);
      jira.readStatus = async (key: string) => {
        if (key === bad.externalKey) throw new Error('Jira 404: issue does not exist');
        return original(key);
      };
      expect(await poller.check()).toBe(1);
      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: good.id } })).status).toBe('BREAKDOWN');
      jira.readStatus = async () => {
        throw new JiraUnavailableError('down', 4);
      };
      await ticket(p.id, { status: 'AWAITING_PLAN_APPROVAL' });
      await expect(poller.check()).rejects.toBeInstanceOf(JiraUnavailableError);
    });
  });
});
