import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthModule } from '../auth/auth.module';
import { CLOCK } from '../auth/clock';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { configureApp } from '../setup';
import { createTestDatabase, type TestDatabase } from '../testing/test-db';

const CODE = 'ABCD-EFGH-JKLM';
const PASSWORD = 'a brand new password';
let db: TestDatabase;
let prisma: PrismaService;
const saved = { ...process.env };

async function buildApp(env: Record<string, string | undefined>): Promise<INestApplication> {
  process.env = { ...saved, DATABASE_URL: db.url, SETUP_CODE: CODE, ...env };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, AuthModule] }).overrideProvider(CLOCK).useValue(() => Date.now()).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  return app;
}

const cookieOf = (res: request.Response) => ((res.headers['set-cookie'] as unknown as string[]) ?? []).find((c) => c.startsWith('sdlc_session='))?.split(';')[0] ?? '';

beforeAll(async () => {
  db = await createTestDatabase();
}, 180_000);
afterAll(async () => {
  process.env = saved;
  await db.drop();
});

describe('first-run setup', () => {
  let app: INestApplication;
  beforeEach(async () => {
    await app?.close();
    process.env.DATABASE_URL = db.url;
    const cleaner = new PrismaService(); // reset before the app starts, because the setup code is decided at start-up
    await cleaner.adminAccount.deleteMany();
    await cleaner.session.deleteMany();
    await cleaner.onModuleDestroy();
    app = await buildApp({ DASHBOARD_PASSWORD: undefined });
    prisma = app.get(PrismaService);
  });

  const create = (setupCode: string, password = PASSWORD, ip = '10.1.0.1') => request(app.getHttpServer()).post('/setup/admin').set('X-Forwarded-For', ip).send({ setupCode, password });

  it('reveals only adminCreated without a session', async () => {
    const res = await request(app.getHttpServer()).get('/setup/status').expect(200);
    expect(res.body).toEqual({ adminCreated: false });
  });

  it('rejects a wrong code with 401 and locks the IP after 5 failures', async () => {
    for (let i = 0; i < 5; i++) await create('WRONG-CODE-0000', PASSWORD, '10.1.0.2').expect(401);
    await create(CODE, PASSWORD, '10.1.0.2').expect(429);
    expect(await prisma.adminAccount.count()).toBe(0);
  });

  it('rejects a short password', async () => {
    await create(CODE, 'short', '10.1.0.3').expect(400);
  });

  it('creates the admin with the right code (any case, no dashes), sets the cookie and grants access', async () => {
    const res = await create('abcdefghjklm').expect(200);
    const cookie = cookieOf(res);
    expect(cookie).toContain('sdlc_session=');
    const status = await request(app.getHttpServer()).get('/setup/status').set('Cookie', cookie).expect(200);
    expect(status.body).toMatchObject({ adminCreated: true, ready: false, encryptionKeyOk: false });
    expect(status.body.missing).toContain('github_token');
    await request(app.getHttpServer()).get('/setup/status').expect(200).expect({ adminCreated: true });
  });

  it('refuses a second admin, and login works with the new password', async () => {
    await create(CODE).expect(200);
    await create(CODE, 'another password!!', '10.1.0.9').expect(409);
    await request(app.getHttpServer()).post('/auth/login').set('X-Forwarded-For', '10.1.0.4').send({ password: PASSWORD }).expect(200);
    await request(app.getHttpServer()).post('/auth/login').set('X-Forwarded-For', '10.1.0.4').send({ password: 'nope nope nope' }).expect(401);
  });

  it('logs out the other sessions on a password change', async () => {
    const first = cookieOf(await create(CODE).expect(200));
    const second = cookieOf(await request(app.getHttpServer()).post('/auth/login').set('X-Forwarded-For', '10.1.0.5').send({ password: PASSWORD }).expect(200));
    await request(app.getHttpServer()).post('/auth/password').set('Cookie', first).send({ current: 'wrong password!', next: 'the next password!' }).expect(401);
    await request(app.getHttpServer()).post('/auth/password').set('Cookie', first).send({ current: PASSWORD, next: 'the next password!' }).expect(200);
    await request(app.getHttpServer()).get('/auth/session').set('Cookie', first).expect(200);
    await request(app.getHttpServer()).get('/auth/session').set('Cookie', second).expect(401);
    await request(app.getHttpServer()).post('/auth/login').set('X-Forwarded-For', '10.1.0.6').send({ password: 'the next password!' }).expect(200);
  });
});

describe('with DASHBOARD_PASSWORD set', () => {
  it('refuses /setup/admin and password change, and login uses the env password', async () => {
    const app = await buildApp({ DASHBOARD_PASSWORD: 'env password 12345' });
    try {
      await request(app.getHttpServer()).post('/setup/admin').send({ setupCode: CODE, password: PASSWORD }).expect(409);
      await request(app.getHttpServer()).get('/setup/status').expect(200).expect({ adminCreated: true });
      const login = await request(app.getHttpServer()).post('/auth/login').set('X-Forwarded-For', '10.2.0.1').send({ password: 'env password 12345' }).expect(200);
      await request(app.getHttpServer()).post('/auth/password').set('Cookie', cookieOf(login)).send({ current: 'env password 12345', next: 'something else 1234' }).expect(409);
    } finally {
      await app.close();
    }
  });
});
