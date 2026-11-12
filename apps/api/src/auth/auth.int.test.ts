import 'reflect-metadata';
import { Controller, Get, type INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { configureApp } from '../setup';
import { type TestDatabase, createTestDatabase } from '../testing/test-db';
import { SystemModule } from '../system/system.module';
import { AuthModule } from './auth.module';
import { CLOCK } from './clock';
import { LOCK_MS } from './login-limiter';
import { SESSION_TTL_MS, hashToken } from './session.service';

const PASSWORD = 'correct horse battery staple';

@Controller('things')
class ProtectedController {
  @Get()
  list(): { things: string[] } {
    return { things: [] };
  }
}

@Module({ controllers: [ProtectedController] })
class ProtectedModule {}

let testDb: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let nowMs = Date.now();

async function buildApp(env: Record<string, string>): Promise<INestApplication> {
  Object.assign(process.env, { DATABASE_URL: testDb.url, DASHBOARD_PASSWORD: PASSWORD, SESSION_SECRET: 'x'.repeat(32), ...env });
  const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, AuthModule, SystemModule, ProtectedModule] })
    .overrideProvider(CLOCK)
    .useValue(() => nowMs)
    .compile();
  const instance = moduleRef.createNestApplication();
  configureApp(instance);
  await instance.init();
  return instance;
}

const login = (password: string, ip = '10.0.0.1') =>
  request(app.getHttpServer()).post('/auth/login').set('X-Forwarded-For', ip).send({ password });

function sessionCookie(res: request.Response): string {
  const raw = res.headers['set-cookie'] as unknown as string[];
  return raw.find((c) => c.startsWith('sdlc_session='))?.split(';')[0] ?? '';
}

describe('F1 authentication', () => {
  beforeAll(async () => {
    testDb = await createTestDatabase();
    app = await buildApp({ COOKIE_SECURE: 'false' });
    prisma = app.get(PrismaService);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await testDb?.drop();
  });

  beforeEach(async () => {
    nowMs = Date.now();
    await prisma.session.deleteMany();
  });

  it('returns 401 for every protected route without a session, and /health stays public', async () => {
    const res = await request(app.getHttpServer()).get('/things').expect(401);
    expect(res.body).toEqual({ error: 'unauthorized', message: 'Authentication required' });
    await request(app.getHttpServer()).post('/auth/logout').expect(401);
    // Unknown routes must not reveal themselves either.
    await request(app.getHttpServer()).get('/does-not-exist').expect(401);
    await request(app.getHttpServer()).post('/projects').send({}).expect(401);
    await request(app.getHttpServer()).get('/health/').expect(200);
    await request(app.getHttpServer()).get('/health').expect(200);
  });

  it('returns 404 for unknown routes once authenticated', async () => {
    const cookie = sessionCookie(await login(PASSWORD).expect(200));
    const res = await request(app.getHttpServer()).get('/does-not-exist').set('Cookie', cookie).expect(404);
    expect(res.body.error).toBe('not_found');
  });

  it('GET /auth/session reports whether the cookie is a valid session', async () => {
    await request(app.getHttpServer()).get('/auth/session').expect(401);
    const cookie = sessionCookie(await login(PASSWORD).expect(200));
    const res = await request(app.getHttpServer()).get('/auth/session').set('Cookie', cookie).expect(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('rejects a wrong password with 401 and sets no cookie', async () => {
    const res = await login('nope', '10.0.0.2').expect(401);
    expect(res.body.error).toBe('unauthorized');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('rejects a missing password with a validation error', async () => {
    const res = await request(app.getHttpServer()).post('/auth/login').send({}).expect(400);
    expect(res.body).toEqual({ error: 'validation_error', message: 'Invalid login request', fields: { password: 'required' } });
  });

  it('sets an httpOnly, sameSite=lax cookie valid for 7 days, and grants access', async () => {
    const res = await login(PASSWORD).expect(200);
    const header = (res.headers['set-cookie'] as unknown as string[])[0] as string;
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Lax/i);
    expect(header).toContain(`Max-Age=${SESSION_TTL_MS / 1000}`);
    expect(header).not.toMatch(/;\s*Secure/i);
    await request(app.getHttpServer()).get('/things').set('Cookie', sessionCookie(res)).expect(200);
  });

  it('stores only the SHA-256 of a 32-byte token', async () => {
    const res = await login(PASSWORD).expect(200);
    const token = sessionCookie(res).split('=')[1] as string;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const rows = await prisma.session.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).toBe(hashToken(token));
    expect(rows[0]?.tokenHash).not.toBe(token);
  });

  it('logout ends the session', async () => {
    const cookie = sessionCookie(await login(PASSWORD).expect(200));
    await request(app.getHttpServer()).post('/auth/logout').set('Cookie', cookie).expect(200);
    await request(app.getHttpServer()).get('/things').set('Cookie', cookie).expect(401);
    expect(await prisma.session.count()).toBe(0);
  });

  it('expires sessions after 7 days', async () => {
    const cookie = sessionCookie(await login(PASSWORD).expect(200));
    nowMs += SESSION_TTL_MS - 1000;
    await request(app.getHttpServer()).get('/things').set('Cookie', cookie).expect(200);
    nowMs += 2000;
    await request(app.getHttpServer()).get('/things').set('Cookie', cookie).expect(401);
  });

  it('locks an IP out after 5 failures for 15 minutes, even with the right password', async () => {
    const ip = '10.0.0.9';
    for (let i = 0; i < 5; i++) await login('wrong', ip).expect(401);
    const locked = await login(PASSWORD, ip).expect(429);
    expect(locked.body.error).toBe('too_many_requests');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    await login(PASSWORD, '10.0.0.10').expect(200); // another IP is unaffected
    nowMs += LOCK_MS + 1000;
    await login(PASSWORD, ip).expect(200);
  });

  it('does not lock out when failures are spread beyond the 15-minute window', async () => {
    const ip = '10.0.0.11';
    for (let i = 0; i < 4; i++) await login('wrong', ip).expect(401);
    nowMs += 16 * 60 * 1000;
    await login('wrong', ip).expect(401);
    await login(PASSWORD, ip).expect(200);
  });

  it('sets Secure when COOKIE_SECURE=true', async () => {
    const secureApp = await buildApp({ COOKIE_SECURE: 'true' });
    const res = await request(secureApp.getHttpServer()).post('/auth/login').send({ password: PASSWORD }).expect(200);
    expect((res.headers['set-cookie'] as unknown as string[])[0]).toMatch(/;\s*Secure/i);
    await secureApp.close();
    process.env.COOKIE_SECURE = 'false';
  });
});
