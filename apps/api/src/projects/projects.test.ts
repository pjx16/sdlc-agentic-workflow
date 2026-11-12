import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type TestApp, createTestApp } from '../testing/test-app';
import { type TestDatabase, createTestDatabase } from '../testing/test-db';
import { ProjectsModule } from './projects.module';

const valid = { name: 'Billing API', repoUrl: 'https://github.com/acme/billing', stack: 'nestjs', testCmdTemplate: 'npx jest {files}' };

describe('Projects API (F2)', () => {
  let db: TestDatabase;
  let t: TestApp;

  beforeAll(async () => {
    db = await createTestDatabase();
    t = await createTestApp(db.url, [ProjectsModule]);
  }, 180_000);
  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });
  beforeEach(async () => {
    await t.prisma.project.deleteMany();
  });

  it('requires a session', async () => {
    await t.anonymous.get('/projects').expect(401);
    await t.anonymous.post('/projects').send(valid).expect(401);
  });

  it('creates a project with defaults and mirrorStatus pending', async () => {
    const res = await t.agent.post('/projects').send(valid).expect(201);
    expect(res.body).toMatchObject({
      name: 'Billing API', baseBranch: 'dev', mirrorStatus: 'pending', mirrorError: null, enabled: true,
      localKeyPrefix: 'BILL', nextLocalNumber: 1, claudeMdMode: 'both', jiraMode: 'off', kbDir: 'docs/kb',
    });
    expect(res.body.settings.stages.plan).toEqual({ enabled: true, model: 'opus', maxTurns: 15 });
    expect((await t.agent.get('/projects').expect(200)).body).toHaveLength(1);
  });

  it('round-trips every setting through the API and the database', async () => {
    const full = {
      ...valid,
      baseBranch: 'main', installCmd: 'npm ci', typecheckCmd: 'npx tsc --noEmit', kbDir: 'kb/docs', claudeMdMode: 'ours',
      jiraMode: 'rest', jiraProjectKey: 'BILL', jiraJql: 'project = BILL AND status = "To Do"', localKeyPrefix: 'BLG', enabled: true,
      settings: {
        stages: { plan: { enabled: false, model: 'sonnet', maxTurns: 7 }, review: { enabled: false }, implement: { maxTurns: 55 } },
        gates: { plan: false, breakdown: true },
        intake: { paste: false, mcpPollIntervalSec: 300 },
        jiraWriteBack: { comments: false, transitions: true, createSubtasks: false },
        jiraSubtaskTypeName: 'Subtask',
        jiraStatusMap: { DONE: 'Closed', IN_PROGRESS: 'In Dev' },
        jiraApprovalStatuses: { plan: 'Plan OK' },
        pr: { earlyDraft: false, ciFixRound: false, ciTimeoutMin: 45 },
        limits: { maxSubtasks: 4, maxTestFixRounds: 1, maxReviewRounds: 3, kbDocMaxLines: 200, reviewMaxDiffLines: 2500 },
        verify: { redInvalidPatterns: ['Boom'] },
      },
    };
    const created = (await t.agent.post('/projects').send(full).expect(201)).body;
    const fetched = (await t.agent.get(`/projects/${created.id}`).expect(200)).body;
    expect(fetched).toEqual(created);
    expect(fetched).toMatchObject({ baseBranch: 'main', claudeMdMode: 'ours', jiraMode: 'rest', jiraProjectKey: 'BILL', localKeyPrefix: 'BLG' });
    expect(fetched.settings.stages.plan).toEqual({ enabled: false, model: 'sonnet', maxTurns: 7 });
    expect(fetched.settings.stages.implement.maxTurns).toBe(55);
    expect(fetched.settings.jiraStatusMap.DONE).toBe('Closed');
    expect(fetched.settings.jiraStatusMap.NEW).toBeNull();
    expect(fetched.settings.limits).toEqual(full.settings.limits);
    expect(fetched.settings.pr).toEqual(full.settings.pr);
    const row = await t.prisma.project.findUniqueOrThrow({ where: { id: created.id } });
    expect((row.settings as { stages: { plan: { maxTurns: number } } }).stages.plan.maxTurns).toBe(7);
  });

  it('returns field-level errors', async () => {
    const res = await t.agent
      .post('/projects')
      .send({ name: '', repoUrl: 'git@github.com:a/b.git', stack: 'rails', testCmdTemplate: 'npx jest', settings: { limits: { maxSubtasks: 0 }, stages: { implement: { enabled: false } } } })
      .expect(400);
    expect(res.body.error).toBe('validation_error');
    expect(Object.keys(res.body.fields).sort()).toEqual([
      'name', 'repoUrl', 'settings.limits.maxSubtasks', 'settings.stages.implement.enabled', 'stack', 'testCmdTemplate',
    ]);
    expect(res.body.fields.testCmdTemplate).toBe('must contain {files}');
    expect(await t.prisma.project.count()).toBe(0);
  });

  it('rejects a duplicate name as a field error', async () => {
    await t.agent.post('/projects').send(valid).expect(201);
    const res = await t.agent.post('/projects').send(valid).expect(400);
    expect(res.body.fields).toEqual({ name: 'a project with this name already exists' });
  });

  it('PATCH merges nested settings and validates the result', async () => {
    const { id } = (await t.agent.post('/projects').send(valid).expect(201)).body;
    const res = await t.agent.patch(`/projects/${id}`).send({ settings: { stages: { plan: { maxTurns: 9 } }, gates: { breakdown: false } }, installCmd: 'npm ci' }).expect(200);
    expect(res.body.settings.stages.plan).toEqual({ enabled: true, model: 'opus', maxTurns: 9 });
    expect(res.body.settings.gates).toEqual({ plan: true, breakdown: false });
    expect(res.body.installCmd).toBe('npm ci');
    expect(res.body.name).toBe('Billing API');
    const bad = await t.agent.patch(`/projects/${id}`).send({ testCmdTemplate: 'npx jest', settings: { limits: { maxSubtasks: 99 } } }).expect(400);
    expect(Object.keys(bad.body.fields).sort()).toEqual(['settings.limits.maxSubtasks', 'testCmdTemplate']);
    expect((await t.agent.get(`/projects/${id}`)).body.installCmd).toBe('npm ci');
  });

  it('changing the repository or base branch re-queues the mirror', async () => {
    const { id } = (await t.agent.post('/projects').send(valid).expect(201)).body;
    await t.prisma.project.update({ where: { id }, data: { mirrorStatus: 'ok' } });
    expect((await t.agent.patch(`/projects/${id}`).send({ installCmd: 'x' }).expect(200)).body.mirrorStatus).toBe('ok');
    expect((await t.agent.patch(`/projects/${id}`).send({ baseBranch: 'main' }).expect(200)).body.mirrorStatus).toBe('pending');
  });

  it('soft-disables on DELETE and keeps the project readable', async () => {
    const { id } = (await t.agent.post('/projects').send(valid).expect(201)).body;
    expect((await t.agent.delete(`/projects/${id}`).expect(200)).body.enabled).toBe(false);
    expect((await t.agent.get(`/projects/${id}`).expect(200)).body.enabled).toBe(false);
    expect(await t.prisma.project.count()).toBe(1);
    expect((await t.agent.patch(`/projects/${id}`).send({ enabled: true }).expect(200)).body.enabled).toBe(true);
  });

  it('retries a failed mirror and refuses otherwise', async () => {
    const { id } = (await t.agent.post('/projects').send(valid).expect(201)).body;
    const refused = await t.agent.post(`/projects/${id}/mirror/retry`).expect(409);
    expect(refused.body.error).toBe('conflict');
    await t.prisma.project.update({ where: { id }, data: { mirrorStatus: 'failed', mirrorError: 'boom' } });
    const res = await t.agent.post(`/projects/${id}/mirror/retry`).expect(200);
    expect(res.body).toMatchObject({ mirrorStatus: 'pending', mirrorError: null });
  });

  it('returns 404 for unknown projects', async () => {
    for (const call of [t.agent.get('/projects/nope'), t.agent.patch('/projects/nope').send({}), t.agent.delete('/projects/nope'), t.agent.post('/projects/nope/mirror/retry')]) {
      expect((await call.expect(404)).body.error).toBe('not_found');
    }
  });
});
