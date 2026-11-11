import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestApp, createTestApp } from '../testing/test-app';
import { type TestDatabase, createTestDatabase } from '../testing/test-db';
import { GuidelinesModule } from './guidelines.module';

describe('Guidelines API over HTTP (BUILD_PLAN 8)', () => {
  let db: TestDatabase;
  let t: TestApp;
  let tmp: string;
  let root: string;

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'sdlc-gl-http-'));
    root = path.join(tmp, 'guidelines');
    mkdirSync(path.join(root, 'stages'), { recursive: true });
    writeFileSync(path.join(root, 'default-CLAUDE.md'), '# Rules');
    writeFileSync(path.join(root, 'stages/plan.md'), '# Plan');
    writeFileSync(path.join(tmp, 'secret.md'), 'secret');
    process.env.GUIDELINES_DIR = root;
    db = await createTestDatabase();
    t = await createTestApp(db.url, [GuidelinesModule]);
  }, 180_000);
  afterAll(async () => {
    await t?.close();
    await db?.drop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('requires a session for every route', async () => {
    await t.anonymous.get('/guidelines').expect(401);
    await t.anonymous.get('/guidelines/default-CLAUDE.md').expect(401);
    await t.anonymous.put('/guidelines/default-CLAUDE.md').send({ content: 'x' }).expect(401);
  });

  it('returns the file tree', async () => {
    const res = (await t.agent.get('/guidelines').expect(200)).body;
    expect(res.map((n: { path: string }) => n.path)).toEqual(['stages', 'default-CLAUDE.md']);
    expect(res[0].children[0].path).toBe('stages/plan.md');
  });

  it('reads and edits a nested file through the wildcard route', async () => {
    expect((await t.agent.get('/guidelines/stages/plan.md').expect(200)).body).toEqual({ path: 'stages/plan.md', content: '# Plan' });
    await t.agent.put('/guidelines/stages/plan.md').send({ content: '# Plan v2' }).expect(200);
    expect(readFileSync(path.join(root, 'stages/plan.md'), 'utf8')).toBe('# Plan v2');
    expect((await t.agent.get('/guidelines/stages/plan.md').expect(200)).body.content).toBe('# Plan v2');
  });

  it('404s for a missing file', async () => {
    expect((await t.agent.get('/guidelines/stages/missing.md').expect(404)).body.error).toBe('not_found');
  });

  it('rejects traversal attempts, including encoded ones, and never touches files outside the directory', async () => {
    for (const attack of ['..%2Fsecret.md', '%2e%2e/secret.md', 'stages/..%2F..%2Fsecret.md', '..%5Csecret.md']) {
      const get = await t.agent.get(`/guidelines/${attack}`);
      expect([400, 404], `GET ${attack}`).toContain(get.status);
      const put = await t.agent.put(`/guidelines/${attack}`).send({ content: 'pwned' });
      expect([400, 404], `PUT ${attack}`).toContain(put.status);
    }
    expect(readFileSync(path.join(tmp, 'secret.md'), 'utf8')).toBe('secret');
  });

  it('only writes markdown and validates the body', async () => {
    expect((await t.agent.put('/guidelines/notes.txt').send({ content: 'x' }).expect(400)).body.error).toBe('validation_error');
    expect((await t.agent.put('/guidelines/default-CLAUDE.md').send({}).expect(400)).body.fields.content).toBe('required');
    expect((await t.agent.get('/guidelines/default-CLAUDE.md').expect(200)).body.content).toBe('# Rules');
  });
});
