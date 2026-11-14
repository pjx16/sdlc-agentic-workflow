import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestApp, createTestApp } from '../testing/test-app';
import { type TestDatabase, createTestDatabase } from '../testing/test-db';
import { TicketsModule } from './tickets.module';

describe('GET /tickets/:id/decisions and the stage-key migration', () => {
  let db: TestDatabase;
  let t: TestApp;
  let projectId: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    t = await createTestApp(db.url, [TicketsModule]);
    projectId = (await t.prisma.project.create({ data: { name: 'p', repoUrl: 'https://x/y', stack: 'nestjs', testCmdTemplate: 'x {files}', localKeyPrefix: 'P', mirrorStatus: 'ok' } })).id;
  }, 180_000);
  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });

  it('lists what the orchestrator was asked, its options, choice and reason, oldest first', async () => {
    const tk = await t.prisma.ticket.create({ data: { projectId, key: 'D-1', source: 'paste', title: 'x', status: 'REVIEW' } });
    await t.prisma.orchestratorDecision.create({ data: { ticketId: tk.id, point: 'review_findings', legalMoves: [{ kind: 'fix', to: 'fix', label: 'Send the findings to the fixer' }, { kind: 'support', to: 'support', label: 'Raise a support ticket' }], chosen: 'support support', reason: 'Contradicts the plan', fallbackUsed: false, model: 'haiku', costUsd: 0.0021 } });
    const body = (await t.agent.get(`/tickets/${tk.id}/decisions`).expect(200)).body as { point: string; question: string; options: { label: string }[]; chosen: string; reason: string; costUsd: number }[];
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ point: 'review_findings', chosen: 'support support', reason: 'Contradicts the plan', costUsd: 0.0021 });
    expect(body[0]?.question).toContain('Blocking review findings');
    expect(body[0]?.options.map((o) => o.label)).toEqual(['Send the findings to the fixer', 'Raise a support ticket']);
    await t.agent.get('/tickets/00000000-0000-0000-0000-000000000000/decisions').expect(404);
  });

  it('the migration carries settings saved under the old stage keys over to the new ones, and leaves the rest alone', async () => {
    const sql = readFileSync(path.join(process.cwd(), 'prisma/migrations/20261115100000_rename_old_stage_keys/migration.sql'), 'utf8');
    const old = await t.prisma.project.create({ data: { name: 'old', repoUrl: 'https://x/y', stack: 'nestjs', testCmdTemplate: 'x {files}', localKeyPrefix: 'O', mirrorStatus: 'ok', settings: { stages: { plan: { enabled: true, model: 'haiku', maxTurns: 7 }, breakdown: { enabled: false }, review: { model: 'opus' }, implement: { model: 'sonnet' }, prReview: { model: 'sonnet' } }, gates: { plan: false } } as never } });
    const fresh = await t.prisma.project.create({ data: { name: 'new', repoUrl: 'https://x/y', stack: 'nestjs', testCmdTemplate: 'x {files}', localKeyPrefix: 'N', mirrorStatus: 'ok', settings: { stages: { solutionDesign: { model: 'opus' } } } as never } });
    await t.prisma.globalSettings.upsert({ where: { id: 'global' }, update: { stageDefaults: { plan: { model: 'haiku' }, tests: { model: 'sonnet' } } }, create: { id: 'global', stageDefaults: { plan: { model: 'haiku' }, tests: { model: 'sonnet' } } } } as never);

    const client = new Client({ connectionString: db.url });
    await client.connect();
    await client.query(sql);
    await client.query(sql); // running it again changes nothing
    await client.end();

    const stages = (await t.prisma.project.findUniqueOrThrow({ where: { id: old.id } })).settings as { stages: Record<string, unknown>; gates: unknown };
    expect(stages.stages).toEqual({ solutionDesign: { enabled: true, model: 'haiku', maxTurns: 7 }, technicalDesign: { enabled: false }, implement: { model: 'sonnet' }, prReview: { model: 'sonnet' } }); // a value already under the new key wins
    expect(stages.gates).toEqual({ plan: false });
    expect(((await t.prisma.project.findUniqueOrThrow({ where: { id: fresh.id } })).settings as { stages: unknown }).stages).toEqual({ solutionDesign: { model: 'opus' } });
    expect((await t.prisma.globalSettings.findFirstOrThrow()).stageDefaults).toEqual({ solutionDesign: { model: 'haiku' }, tests: { model: 'sonnet' } });
  });
});
