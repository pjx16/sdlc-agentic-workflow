import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfluenceVersionConflict } from '../../confluence/confluence-client';
import { ConfluenceHub } from '../../confluence/document-hub';
import { PrismaService } from '../../prisma/prisma.service';
import { FakeConfluence, FakeConfluenceClients } from '../../testing/fake-confluence';
import { FakeJira, FakeJiraClients } from '../../testing/fake-jira';
import { createTestDatabase, type TestDatabase } from '../../testing/test-db';
import { PlanPageSync } from './plan-page-sync';

describe('the plan page sync (BUILD_PLAN v1 6.10)', () => {
  let db: TestDatabase;
  let prisma: PrismaService;
  let fake: FakeConfluence;
  let jira: FakeJira;
  let sync: PlanPageSync;
  let projectId: string;
  let n = 0;

  const ticket = (over: Record<string, unknown> = {}) =>
    prisma.ticket.create({ data: { projectId, key: `PG-${++n}`, source: 'jira', externalKey: `SDA-${n}`, title: 'Export bookings', status: 'AWAITING_PLAN_APPROVAL', ...over } });
  const plan = (ticketId: string, version: number, text: string, over: Record<string, unknown> = {}) =>
    prisma.stageArtifact.create({ data: { ticketId, stage: 'plan', version, data: { planMarkdown: text }, ...over } });
  const configure = (confluence: unknown = { spaceKey: 'ENG', parentPageId: 'parent-1' }, jiraMode = 'rest') => prisma.project.update({ where: { id: projectId }, data: { jiraMode: jiraMode as never, settings: { confluence } as never } });
  const current = async (ticketId: string) => prisma.stageArtifact.findFirstOrThrow({ where: { ticketId, stage: 'plan', supersededAt: null }, orderBy: { version: 'desc' } });
  const links = (key: string) => (jira.commentBodies[key] ?? []).filter((c) => c.includes('is in Confluence'));

  beforeAll(async () => {
    db = await createTestDatabase();
    process.env.DATABASE_URL = db.url;
    prisma = new PrismaService();
    await prisma.onModuleInit();
    projectId = (await prisma.project.create({ data: { name: 'p', repoUrl: 'https://x/y', stack: 'nestjs', testCmdTemplate: 'x {files}', localKeyPrefix: 'P', mirrorStatus: 'ok' } })).id;
    const clients = new FakeConfluenceClients();
    fake = clients.confluence;
    const jiraClients = new FakeJiraClients();
    jira = jiraClients.jira;
    sync = new PlanPageSync(prisma, clients, jiraClients);
  }, 180_000);
  afterAll(async () => {
    await prisma?.onModuleDestroy();
    await db?.drop();
  });
  beforeEach(async () => {
    fake.pages = {};
    fake.calls = [];
    fake.failWith = null;
    fake.failWrites = null;
    jira.commentBodies = {};
    jira.failWith = null;
    await configure();
  });

  it('the hub applies an update on top of the latest version after a note, when someone edited the page', async () => {
    const hub = new ConfluenceHub(fake);
    const page = await hub.publish({ parentId: 'parent-1', doc: { title: 'T', markdown: '# Plan', status: 'Draft' } });
    fake.editOutside(page.id);
    const r = await hub.update(page.id, page.version, { title: 'T', markdown: '# Plan 2', status: 'Draft' });
    expect(r).toEqual({ version: 3, conflicted: true });
    expect(fake.pages[page.id]?.storage).toContain('Edited outside sdlc-agent');
    await expect(fake.updatePage({ id: page.id, title: 'T', storage: 'x', expectedVersion: 1 })).rejects.toBeInstanceOf(ConfluenceVersionConflict);
  });

  it('publishes the plan once, stores the page on the artifact, and links it on Jira once', async () => {
    const t = await ticket();
    await plan(t.id, 1, '## Goal\nExport CSV\n\nSee src/a.ts:3');
    await sync.syncTicket(t);
    const a = await current(t.id);
    expect(a).toMatchObject({ externalVersion: 1 });
    expect(a.externalUrl).toContain('/pages/');
    const page = fake.pages[a.externalId as string];
    expect(page?.title).toBe(`${t.key} — Export bookings`);
    expect(page?.parentId).toBe('parent-1');
    expect(page?.storage).toContain('Draft, waiting for approval');
    expect(page?.storage).toContain('<code>src/a.ts:3</code>');
    expect(links(t.externalKey as string)).toHaveLength(1);

    await sync.syncTicket(t); // nothing changed: nothing sent
    expect(fake.calls.filter((c) => c.startsWith('create') || c.startsWith('update'))).toHaveLength(1);
    expect(links(t.externalKey as string)).toHaveLength(1);
  });

  it('approval updates the status line, answered questions update the questions section', async () => {
    const t = await ticket();
    await plan(t.id, 1, '## Goal\nX');
    await sync.syncTicket(t);
    const id = (await current(t.id)).externalId as string;

    await prisma.supportTicket.create({ data: { kind: 'open_question', title: 'Which delimiter?', body: 'Which delimiter?', ticketId: t.id, projectId, stage: 'solutionDesign', status: 'answered', response: 'a semicolon' } });
    await sync.syncTicket(await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } }));
    expect(fake.pages[id]?.storage).toContain('a semicolon');
    expect(fake.pages[id]?.version).toBe(2);

    await prisma.ticket.update({ where: { id: t.id }, data: { status: 'BREAKDOWN' } });
    await sync.syncTicket(await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } }));
    expect(fake.pages[id]?.storage).toContain('Approved on');
    expect(fake.pages[id]?.version).toBe(3);
    expect((await current(t.id)).externalVersion).toBe(3);
  });

  it('a rerun updates the same page with the new plan', async () => {
    const t = await ticket();
    const v1 = await plan(t.id, 1, '## Goal\nfirst');
    await sync.syncTicket(t);
    const id = (await current(t.id)).externalId as string;
    await prisma.stageArtifact.update({ where: { id: v1.id }, data: { supersededAt: new Date() } });
    await plan(t.id, 2, '## Goal\nsecond');
    await sync.syncTicket(t);
    expect(Object.keys(fake.pages)).toEqual([id]);
    expect(fake.pages[id]?.storage).toContain('second');
    expect(fake.pages[id]?.version).toBe(2);
    expect((await current(t.id)).externalId).toBe(id);
  });

  it('an edit made by hand is kept in Confluence history, noted, and a warning is recorded', async () => {
    const t = await ticket();
    await plan(t.id, 1, 'one');
    await sync.syncTicket(t);
    const id = (await current(t.id)).externalId as string;
    fake.editOutside(id);
    await prisma.ticket.update({ where: { id: t.id }, data: { status: 'BREAKDOWN' } });
    await sync.syncTicket(await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } }));
    expect(fake.pages[id]?.storage).toContain('Edited outside sdlc-agent');
    expect(await prisma.event.count({ where: { ticketId: t.id, level: 'warn', message: { contains: 'edited outside' } } })).toBe(1);
  });

  it('Confluence failing 3 times posts the full plan to Jira instead, once, with a warning', async () => {
    const t = await ticket();
    await plan(t.id, 1, '## Goal\nfull text');
    fake.failWrites = new Error('Confluence 500');
    await sync.syncTicket(t);
    expect(fake.calls.filter((c) => c.startsWith('create'))).toHaveLength(3);
    expect((jira.commentBodies[t.externalKey as string] ?? []).some((c) => c.includes('full text'))).toBe(true);
    expect(await prisma.event.count({ where: { ticketId: t.id, errorCode: 'CONFLUENCE_ERROR' } })).toBe(1);
    await sync.syncTicket(t); // the same content is not tried again
    expect(fake.calls.filter((c) => c.startsWith('create'))).toHaveLength(3);
  });

  it('a project without Confluence is left alone', async () => {
    await configure(null);
    const t = await ticket();
    await plan(t.id, 1, 'x');
    await sync.syncTicket(t);
    expect(fake.calls).toEqual([]);
    expect(await prisma.stageArtifact.count({ where: { ticketId: t.id, externalId: { not: null } } })).toBe(0);
  });
});
