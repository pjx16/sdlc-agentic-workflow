import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestApp, createTestApp } from '../testing/test-app';
import { type TestDatabase, createTestDatabase } from '../testing/test-db';
import { TicketsModule } from '../tickets/tickets.module';

const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const CLAUDE = 'sk-ant-oat01-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123';

describe('Secrets never reach the dashboard (BUILD_PLAN 13)', () => {
  let db: TestDatabase;
  let t: TestApp;

  beforeAll(async () => {
    db = await createTestDatabase();
    t = await createTestApp(db.url, [TicketsModule]);
  }, 180_000);
  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });

  it('events, run errors and sync errors stored with a token in them come out redacted', async () => {
    const project = await t.prisma.project.create({ data: { name: 'p', repoUrl: 'https://x/y', stack: 'ts_node', testCmdTemplate: 'x {files}', localKeyPrefix: 'P', mirrorStatus: 'ok' } });
    const ticket = await t.prisma.ticket.create({ data: { projectId: project.id, key: 'P-1', source: 'paste', title: 't' } });
    await t.prisma.event.create({ data: { ticketId: ticket.id, type: 'git', message: `Push rejected: https://x-access-token:${TOKEN}@github.com/a/b` } });
    await t.prisma.stageRun.create({ data: { projectId: project.id, ticketId: ticket.id, stage: 'plan', model: 'm', attempt: 1, status: 'failed', startedAt: new Date(), error: `CLI said ${CLAUDE}` } });
    await t.prisma.stateTransition.create({ data: { ticketId: ticket.id, fromStatus: 'NEW', toStatus: 'KB', actor: 'system', jiraSyncError: 'Authorization: Basic dXNlcjpzdXBlcnNlY3JldHBhc3N3b3Jk' } });

    const responses = [await t.agent.get(`/tickets/${ticket.id}`).expect(200), await t.agent.get(`/tickets/${ticket.id}/transitions`).expect(200), await t.agent.get(`/tickets/${ticket.id}/timeline`).expect(200)];
    const all = responses.map((r) => JSON.stringify(r.body)).join('\n');
    for (const leaked of [TOKEN, CLAUDE, 'dXNlcjpzdXBlcnNlY3JldHBhc3N3b3Jk']) expect(all).not.toContain(leaked);
    expect(all).toContain('[REDACTED]');
    // The detail response carries the run error.
    expect(JSON.stringify(responses[0]?.body)).toContain('CLI said [REDACTED]');
  });
});
