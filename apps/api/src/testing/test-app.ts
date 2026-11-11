import type { INestApplication, Type } from '@nestjs/common';
import { JiraClients } from '../jira/jira-clients';
import { FakeJiraClients } from './fake-jira';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { configureApp } from '../setup';
import { StateModule } from '../state/state.module';
import { SystemModule } from '../system/system.module';

export const TEST_PASSWORD = 'test-password';

export interface TestApp {
  app: INestApplication;
  prisma: PrismaService;
  /** supertest agent that is already logged in (keeps the session cookie). */
  agent: ReturnType<typeof request.agent>;
  /** supertest agent with no session. */
  anonymous: ReturnType<typeof request.agent>;
  /** The fake Jira every module under test talks to. */
  jira: FakeJiraClients;
  close(): Promise<void>;
}

/** Boots the API modules under test against a given database and logs an agent in. */
export async function createTestApp(databaseUrl: string, modules: Type[]): Promise<TestApp> {
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl,
    DASHBOARD_PASSWORD: TEST_PASSWORD,
    SESSION_SECRET: 'x'.repeat(32),
    COOKIE_SECURE: 'false',
  });
  const jira = new FakeJiraClients();
  const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, StateModule, AuthModule, SystemModule, ...modules] })
    .overrideProvider(JiraClients)
    .useValue(jira)
    .compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  const agent = request.agent(app.getHttpServer());
  await agent.post('/auth/login').send({ password: TEST_PASSWORD }).expect(200);
  return {
    app,
    prisma: app.get(PrismaService),
    agent,
    anonymous: request.agent(app.getHttpServer()),
    jira,
    close: () => app.close(),
  };
}
