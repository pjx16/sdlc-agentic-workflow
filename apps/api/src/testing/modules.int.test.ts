import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module';
import { ApprovalPoller } from '../jira/approval-poller';
import { StateMachine } from '../state/state-machine.service';
import { IntakePoller } from '../worker/intake/intake-poller';
import { RestartRecovery } from '../worker/loop/restart-recovery';
import { WorkerLoop } from '../worker/loop/worker-loop';
import { WorkerModule } from '../worker/worker.module';
import { WorkerRunner } from '../worker/worker-runner';
import { AgentRunner } from '../worker/agent-runner/agent-runner';
import { type TestDatabase, createTestDatabase } from './test-db';

/** The real modules, wired the way main.ts and worker.ts wire them: a dependency cycle or a missing provider fails here. */
describe('application wiring', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
    Object.assign(process.env, { DATABASE_URL: db.url, DASHBOARD_PASSWORD: 'x'.repeat(12), DATA_DIR: '/tmp/sdlc-wiring' });
  }, 180_000);
  afterAll(async () => db?.drop());

  it('the API module graph compiles and starts', async () => {
    const app = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await app.init();
    expect(app.get(StateMachine)).toBeDefined();
    await app.close();
  });

  it('the worker module graph compiles and provides everything the loop needs', async () => {
    const app = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    await app.init();
    for (const provider of [WorkerRunner, WorkerLoop, RestartRecovery, IntakePoller, ApprovalPoller, StateMachine, AgentRunner]) expect(app.get(provider), provider.name).toBeDefined();
    await app.close();
  });

  it('the worker loop is wired to the credentials, so it blocks until setup is complete', async () => {
    const saved = { ...process.env };
    for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'GITHUB_TOKEN', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'DASHBOARD_PASSWORD']) delete process.env[k];
    const app = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    try {
      await app.init();
      expect(await app.get(WorkerLoop).tick()).toBe('not_configured');
    } finally {
      await app.close();
      process.env = saved;
    }
  });
});
