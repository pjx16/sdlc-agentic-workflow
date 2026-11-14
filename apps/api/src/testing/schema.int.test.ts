import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDatabase, createTestDatabase } from './test-db';

const MODELS = [
  'Project', 'GlobalSettings', 'Ticket', 'StateTransition', 'Subtask', 'StageRun',
  'ReviewFinding', 'SupportTicket', 'UsageSnapshot', 'Event', 'Session', 'Credential', 'AdminAccount',
];

describe('data model (BUILD_PLAN section 7)', () => {
  let db: TestDatabase;
  let client: Client;

  beforeAll(async () => {
    db = await createTestDatabase();
    client = new Client({ connectionString: db.url });
    await client.connect();
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    await db?.drop();
  });

  it('a fresh database migrates and every model exists', async () => {
    const { rows } = await client.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public'",
    );
    const tables = rows.map((r) => r.table_name);
    for (const model of MODELS) expect(tables, model).toContain(model);
  });

  it('timestamps are timestamptz', async () => {
    const { rows } = await client.query<{ data_type: string }>(
      "select data_type from information_schema.columns where table_name = 'Ticket' and column_name in ('createdAt','updatedAt')",
    );
    expect(rows.map((r) => r.data_type)).toEqual(['timestamp with time zone', 'timestamp with time zone']);
  });

  it('enforces unique project names and ticket keys per project', async () => {
    await client.query(`insert into "Project" (id,name,"repoUrl",stack,"testCmdTemplate","localKeyPrefix","updatedAt") values ('p1','a','https://x/y','ts_node','t {files}','A',now())`);
    await expect(
      client.query(`insert into "Project" (id,name,"repoUrl",stack,"testCmdTemplate","localKeyPrefix","updatedAt") values ('p2','a','https://x/y','ts_node','t {files}','A',now())`),
    ).rejects.toThrow(/unique/i);
    const ins = `insert into "Ticket" (id,"projectId",key,source,title,"updatedAt") values ($1,'p1','K-1','paste','t',now())`;
    await client.query(ins, ['t1']);
    await expect(client.query(ins, ['t2'])).rejects.toThrow(/unique/i);
  });
});
