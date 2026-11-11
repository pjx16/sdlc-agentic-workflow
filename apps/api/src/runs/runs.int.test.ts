import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type TestApp, createTestApp } from '../testing/test-app';
import { type TestDatabase, createTestDatabase } from '../testing/test-db';
import { RunsModule } from './runs.module';

describe('Runs API (F5, BUILD_PLAN 8)', () => {
  let db: TestDatabase;
  let t: TestApp;
  let dataDir: string;
  let projectId: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    dataDir = mkdtempSync(path.join(tmpdir(), 'sdlc-runs-'));
    mkdirSync(path.join(dataDir, 'logs'));
    process.env.DATA_DIR = dataDir;
    t = await createTestApp(db.url, [RunsModule]);
  }, 180_000);
  afterAll(async () => {
    await t?.close();
    await db?.drop();
    rmSync(dataDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await t.prisma.stageRun.deleteMany();
    await t.prisma.project.deleteMany();
    projectId = (await t.prisma.project.create({ data: { name: 'p', repoUrl: 'https://x/y', stack: 'ts_node', testCmdTemplate: 'x {files}', localKeyPrefix: 'P' } })).id;
  });

  const makeRun = (status: 'queued' | 'running' | 'succeeded' | 'failed') => t.prisma.stageRun.create({ data: { projectId, stage: 'plan', model: 'opus', status } });

  it('requires a session', async () => {
    await t.anonymous.get('/runs/abc/log').expect(401);
    await t.anonymous.post('/runs/abc/kill').expect(401);
  });

  it('streams a finished run as server-sent events and ends with an end event', async () => {
    const run = await makeRun('succeeded');
    writeFileSync(path.join(dataDir, 'logs', `${run.id}.log`), '{"type":"system"}\nsecond line\n');
    const res = await t.agent.get(`/runs/${run.id}/log`).buffer(true).parse((r, cb) => {
      let body = '';
      r.on('data', (c: Buffer) => (body += c.toString()));
      r.on('end', () => cb(null, body));
    }).expect(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toBe('data: {"type":"system"}\n\ndata: second line\n\nevent: end\ndata: succeeded\n\n');
  });

  it('returns 404 for an unknown run, and never reads outside the logs directory', async () => {
    await t.agent.get('/runs/00000000-0000-4000-8000-000000000000/log').expect(404);
    await t.agent.get('/runs/..%2F..%2Fetc%2Fpasswd/log').expect(404);
    await t.agent.post('/runs/nope/kill').expect(404);
  });

  it('kills only a running stage by setting killRequested', async () => {
    const queued = await makeRun('queued');
    expect((await t.agent.post(`/runs/${queued.id}/kill`).expect(409)).body.error).toBe('conflict');
    const running = await makeRun('running');
    expect((await t.agent.post(`/runs/${running.id}/kill`).expect(200)).body).toEqual({ id: running.id, status: 'running', killRequested: true });
    expect((await t.prisma.stageRun.findUniqueOrThrow({ where: { id: running.id } })).killRequested).toBe(true);
  });
});
