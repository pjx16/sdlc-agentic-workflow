import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';

const MIGRATIONS = path.resolve(process.cwd(), 'prisma/migrations');
const THIS_ONE = '20261114080000_support_tickets';

/** BUILD_PLAN v1 3.1: the SupportQuery table becomes SupportTicket and the existing rows are kept. */
describe('migration: SupportQuery to SupportTicket', () => {
  let admin: Client;
  let db: Client;
  const name = `m_${randomBytes(6).toString('hex')}`;

  beforeAll(async () => {
    admin = new Client({ connectionString: inject('pgAdminUrl') });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(inject('pgAdminUrl'));
    url.pathname = `/${name}`;
    db = new Client({ connectionString: url.toString() });
    await db.connect();
    // The database as the previous release left it: every migration before this one.
    for (const dir of readdirSync(MIGRATIONS).filter((d) => /^\d/.test(d)).sort()) {
      if (dir >= THIS_ONE) break;
      await db.query(readFileSync(path.join(MIGRATIONS, dir, 'migration.sql'), 'utf8'));
    }
    await db.query(`INSERT INTO "Project" ("id","name","repoUrl","stack","testCmdTemplate","localKeyPrefix","updatedAt") VALUES ('p1','Billing','https://x/y','ts_node','x {files}','B', now())`);
    await db.query(`INSERT INTO "Ticket" ("id","projectId","key","source","title","status","updatedAt") VALUES ('t1','p1','B-1','paste','A ticket','ON_HOLD', now())`);
    await db.query(`INSERT INTO "StageRun" ("id","projectId","ticketId","stage","model","status") VALUES ('r1','p1','t1','plan','opus','failed')`);
    await db.query(`INSERT INTO "SupportQuery" ("id","ticketId","stageRunId","stage","question","status") VALUES ('q-open','t1','r1','plan','Which currency should the invoice use when the customer has two billing addresses?','open')`);
    await db.query(`INSERT INTO "SupportQuery" ("id","ticketId","stageRunId","stage","question","answer","status","answeredAt") VALUES ('q-done','t1','r1','plan','Rounding?','Half up','answered', now())`);
    await db.query(readFileSync(path.join(MIGRATIONS, THIS_ONE, 'migration.sql'), 'utf8'));
  }, 180_000);

  afterAll(async () => {
    await db?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin?.end();
  });

  it('keeps every row, as a blocking question ticket with its project, title and answer', async () => {
    const rows = (await db.query(`SELECT * FROM "SupportTicket" ORDER BY "id"`)).rows;
    expect(rows).toHaveLength(2);
    const open = rows.find((r) => r.id === 'q-open');
    expect(open).toMatchObject({ kind: 'question', priority: 'blocking', status: 'open', projectId: 'p1', ticketId: 't1', stageRunId: 'r1', stage: 'plan', response: null, resolvedBy: null });
    expect(open.body).toContain('Which currency should the invoice use');
    expect(open.title).toBe(open.body.slice(0, 120));
    const done = rows.find((r) => r.id === 'q-done');
    expect(done).toMatchObject({ kind: 'question', status: 'answered', response: 'Half up', resolvedBy: 'user', title: 'Rounding?' });
    expect(done.resolvedAt).not.toBeNull();
  });

  it('allows global tickets and the new statuses', async () => {
    await db.query(`INSERT INTO "SupportTicket" ("id","kind","title","body","priority","status","stage") VALUES ('c1','credential','Claude rejected the credential','b','blocking','resolved','')`);
    expect((await db.query(`SELECT "ticketId","stageRunId" FROM "SupportTicket" WHERE "id" = 'c1'`)).rows[0]).toEqual({ ticketId: null, stageRunId: null });
  });

  it('keeps at most one OPEN ticket per dedupe key, and allows the key again once it is closed', async () => {
    const ins = (id: string, status: string) => db.query(`INSERT INTO "SupportTicket" ("id","kind","title","body","status","stage","dedupeKey") VALUES ('${id}','hold','t','b','${status}','','same-key')`);
    await ins('d1', 'open');
    await expect(ins('d2', 'open')).rejects.toThrow(/duplicate key|unique/i);
    await db.query(`UPDATE "SupportTicket" SET "status" = 'resolved' WHERE "id" = 'd1'`);
    await expect(ins('d3', 'open')).resolves.toBeDefined();
  });
});
