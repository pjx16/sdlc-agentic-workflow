import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JiraUnavailableError } from '../../jira/jira-client';
import { JiraNotConfiguredError } from '../../jira/jira-clients';
import { PrismaService } from '../../prisma/prisma.service';
import { FakeJira, FakeJiraClients } from '../../testing/fake-jira';
import { type TestDatabase, createTestDatabase } from '../../testing/test-db';
import { INTAKE_BACKOFF_MS, IntakePoller } from './intake-poller';

const jt = (key: string, over: Record<string, unknown> = {}) => ({ key, summary: `Summary ${key}`, description: `Body ${key}`, issuetype: 'Story', labels: ['x'], priority: 'High', ...over });

describe('Jira intake polling (F3)', () => {
  let db: TestDatabase;
  let prisma: PrismaService;
  let jira: FakeJira;
  let poller: IntakePoller;
  let clock = 1_000_000;
  let n = 0;

  const project = (over: Record<string, unknown> = {}) =>
    prisma.project.create({ data: { name: `p${++n}`, repoUrl: 'https://x/y', stack: 'ts_node', testCmdTemplate: 'x {files}', localKeyPrefix: `L${n}`, jiraMode: 'rest', jiraProjectKey: 'ABC', jiraJql: 'project = ABC', mirrorStatus: 'ok', ...over } });

  beforeAll(async () => {
    db = await createTestDatabase();
    process.env.DATABASE_URL = db.url;
    prisma = new PrismaService();
    await prisma.onModuleInit();
    const clients = new FakeJiraClients();
    jira = clients.jira;
    poller = new IntakePoller(prisma, clients, () => clock);
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
    await prisma.globalSettings.deleteMany();
    jira.tickets = [];
    jira.failWith = null;
    jira.searches = [];
    clock += INTAKE_BACKOFF_MS * 2; // clear any backoff left by an earlier test
  });

  it('stores polled tickets as NEW with the mapped type, text and labels', async () => {
    const p = await project();
    jira.tickets = [jt('ABC-1'), jt('ABC-2', { issuetype: 'Bug' }), jt('ABC-3', { issuetype: 'Epic', description: '' })];
    const res = await poller.poll();
    expect(res).toMatchObject({ projects: 1, created: 3, duplicates: 0, errors: [] });
    const rows = await prisma.ticket.findMany({ where: { projectId: p.id }, orderBy: { key: 'asc' } });
    expect(rows.map((r) => [r.key, r.externalKey, r.source, r.status, r.type])).toEqual([
      ['ABC-1', 'ABC-1', 'jira', 'NEW', 'story'], ['ABC-2', 'ABC-2', 'jira', 'NEW', 'bug'], ['ABC-3', 'ABC-3', 'jira', 'NEW', 'tech'],
    ]);
    expect(rows[0]).toMatchObject({ title: 'Summary ABC-1', body: 'Body ABC-1', labels: ['x'] });
    expect(jira.searches[0]).toMatchObject({ jiraJql: 'project = ABC' });
    expect(await prisma.event.count({ where: { type: 'intake' } })).toBe(3);
  });

  it('polling the same issues again creates no duplicates', async () => {
    const p = await project();
    jira.tickets = [jt('ABC-1'), jt('ABC-2')];
    await poller.poll();
    const again = await poller.poll();
    const third = await poller.poll();
    expect(again).toMatchObject({ created: 0, duplicates: 2 });
    expect(third).toMatchObject({ created: 0, duplicates: 2 });
    expect(await prisma.ticket.count({ where: { projectId: p.id } })).toBe(2);
    jira.tickets = [jt('ABC-1'), jt('ABC-2'), jt('ABC-3')];
    expect((await poller.poll()).created).toBe(1);
  });

  it('keeps one ticket when the same poll runs twice at the same moment', async () => {
    const p = await project();
    jira.tickets = [jt('ABC-1')];
    const [a, b] = await Promise.all([poller.poll(), poller.poll()]);
    expect(a.created + b.created).toBe(1);
    expect(await prisma.ticket.count({ where: { projectId: p.id } })).toBe(1);
  });

  it('never overwrites a ticket that has already progressed', async () => {
    const p = await project();
    jira.tickets = [jt('ABC-1')];
    await poller.poll();
    await prisma.ticket.updateMany({ where: { projectId: p.id }, data: { status: 'PLANNING', title: 'edited here' } });
    jira.tickets = [jt('ABC-1', { summary: 'changed in Jira' })];
    await poller.poll();
    expect(await prisma.ticket.findFirstOrThrow({ where: { projectId: p.id } })).toMatchObject({ status: 'PLANNING', title: 'edited here' });
  });

  it('handles an empty JQL result', async () => {
    await project();
    jira.tickets = [];
    expect(await poller.poll()).toEqual({ projects: 1, created: 0, duplicates: 0, errors: [] });
    expect(await prisma.ticket.count()).toBe(0);
  });

  it('stores the same Jira key separately for different projects', async () => {
    await project();
    await project();
    jira.tickets = [jt('ABC-1')];
    expect((await poller.poll()).created).toBe(2);
  });

  it('only polls enabled REST-mode projects whose mirror is ready', async () => {
    const ok = await project();
    await project({ enabled: false });
    await project({ jiraMode: 'off' });
    await project({ jiraMode: 'mcp' });
    await project({ mirrorStatus: 'pending' });
    await project({ mirrorStatus: 'failed' });
    jira.tickets = [jt('ABC-1')];
    const res = await poller.poll();
    expect(res).toMatchObject({ projects: 1, created: 1 });
    expect(await prisma.ticket.count({ where: { projectId: ok.id } })).toBe(1);
    expect(jira.searches).toHaveLength(1);
  });

  it('skips polling while intake is paused, but not while only the pipeline is paused', async () => {
    await project();
    jira.tickets = [jt('ABC-1')];
    await prisma.globalSettings.create({ data: { id: 'global', intakePaused: true } });
    expect(await poller.poll()).toMatchObject({ skipped: 'intake_paused', created: 0 });
    expect(jira.searches).toHaveLength(0);
    await prisma.globalSettings.update({ where: { id: 'global' }, data: { intakePaused: false, pipelinePaused: true } });
    expect((await poller.poll()).created).toBe(1); // separate switches
  });

  it('pauses intake for 10 minutes when Jira is unavailable, then resumes', async () => {
    await project();
    jira.tickets = [jt('ABC-1')];
    jira.failWith = new JiraUnavailableError('Jira is unavailable after 4 attempts (HTTP 503)', 4);
    const down = await poller.poll();
    expect(down.errors[0]?.message).toContain('unavailable');
    expect(poller.backoffRemainingMs()).toBe(INTAKE_BACKOFF_MS);
    expect((await prisma.event.findMany({ where: { type: 'jira' } }))[0]?.message).toContain('paused for 10 minutes');

    jira.failWith = null;
    jira.searches = [];
    clock += INTAKE_BACKOFF_MS - 1000;
    expect(await poller.poll()).toMatchObject({ skipped: 'backoff', created: 0 });
    expect(jira.searches).toHaveLength(0);
    clock += 2000;
    expect(await poller.poll()).toMatchObject({ created: 1 });
  });

  it('one failing project does not stop the others', async () => {
    const bad = await project({ name: 'bad', jiraJql: 'bad' });
    const good = await project({ name: 'good', jiraJql: 'good' });
    jira.searchTickets = async (ref) => {
      if (ref.jiraJql === 'bad') throw new Error('Jira 400: Unbounded JQL queries are not allowed here.');
      return [jt('ABC-1')];
    };
    const res = await poller.poll();
    expect(res.created).toBe(1);
    expect(res.errors).toEqual([{ project: 'bad', message: 'Jira 400: Unbounded JQL queries are not allowed here.' }]);
    expect(await prisma.ticket.count({ where: { projectId: good.id } })).toBe(1);
    expect(await prisma.ticket.count({ where: { projectId: bad.id } })).toBe(0);
    jira.searchTickets = FakeJira.prototype.searchTickets.bind(jira);
  });

  it('reports missing Jira credentials without crashing', async () => {
    await project();
    jira.failWith = new JiraNotConfiguredError();
    const res = await poller.poll();
    expect(res.errors[0]?.message).toContain('not configured');
    expect(poller.backoffRemainingMs()).toBe(0);
  });

  it('does not lose a Jira issue whose key collides with a pasted ticket', async () => {
    const p = await project({ localKeyPrefix: 'ABC' });
    await prisma.ticket.create({ data: { projectId: p.id, key: 'ABC-1', source: 'paste', title: 'pasted' } });
    jira.tickets = [jt('ABC-1'), jt('ABC-2')];
    const res = await poller.poll();
    expect(res.errors[0]?.message).toContain('collides with a pasted ticket');
    expect(await prisma.event.count({ where: { type: 'error' } })).toBe(1);
    expect(res.created).toBe(1); // ABC-2 is still stored
    expect(await prisma.ticket.count({ where: { projectId: p.id } })).toBe(2);
  });
});
