import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { configureApp } from '../setup';
import { createTestDatabase, type TestDatabase } from '../testing/test-db';
import { TESTER_OPTIONS } from './credential-tester';
import { CredentialsService } from './credentials.service';

const PASSWORD = 'a long enough password';
const GH = 'ghp_abcdefghijklmnopqrstuvwx';
const saved = { ...process.env };
let db: TestDatabase;
let app: INestApplication;
let cookie = '';
let ghStatus = 200;
let jiraStatus = 200;
const calls: { url: string; headers: Record<string, string> }[] = [];

const fakeFetch = (async (url: string, init: { headers: Record<string, string> }) => {
  calls.push({ url, headers: init.headers });
  if (url.includes('/user')) return new Response(JSON.stringify({ login: 'octo' }), { status: ghStatus });
  return new Response(JSON.stringify({ displayName: 'Jira Dev' }), { status: jiraStatus });
}) as unknown as typeof fetch;

beforeAll(async () => {
  db = await createTestDatabase();
  process.env = { ...saved, DATABASE_URL: db.url, DASHBOARD_PASSWORD: PASSWORD, ENCRYPTION_KEY: randomBytes(32).toString('base64') };
  for (const k of ['GITHUB_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL']) delete process.env[k];
  const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, AuthModule] })
    .overrideProvider(TESTER_OPTIONS)
    .useValue({ githubApiUrl: 'https://github.test', fetch: fakeFetch })
    .compile();
  app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  const login = await request(app.getHttpServer()).post('/auth/login').set('X-Forwarded-For', '10.3.0.1').send({ password: PASSWORD }).expect(200);
  cookie = ((login.headers['set-cookie'] as unknown as string[])[0] as string).split(';')[0] as string;
}, 180_000);
afterAll(async () => {
  await app?.close();
  process.env = saved;
  await db.drop();
});
beforeEach(() => {
  calls.length = 0;
  ghStatus = 200;
  jiraStatus = 200;
});

const api = () => ({
  get: (p: string) => request(app.getHttpServer()).get(p).set('Cookie', cookie),
  put: (p: string, value: string) => request(app.getHttpServer()).put(p).set('Cookie', cookie).send({ value }),
  del: (p: string) => request(app.getHttpServer()).delete(p).set('Cookie', cookie),
  post: (p: string) => request(app.getHttpServer()).post(p).set('Cookie', cookie),
});

describe('credentials API', () => {
  it('requires a session', async () => {
    await request(app.getHttpServer()).get('/credentials').expect(401);
  });

  it('never returns a secret value, only the last 4 characters', async () => {
    await api().put('/credentials/github_token', GH).expect(200);
    await api().put('/credentials/git_author_name', 'Dev Bot').expect(200);
    const res = await api().get('/credentials').expect(200);
    expect(res.text).not.toContain(GH);
    expect(res.text).not.toContain('abcdefghijklmnop');
    const byKey = Object.fromEntries((res.body as { key: string; hint: string; source: string }[]).map((v) => [v.key, v]));
    expect(byKey.github_token).toMatchObject({ source: 'db', hint: 'uvwx' });
    expect(byKey.git_author_name).toMatchObject({ source: 'db', hint: 'Dev Bot' });
    expect(byKey.claude_token).toMatchObject({ source: 'unset', hint: null });
  });

  it('validates values, 404s unknown keys, and refuses to overwrite a value set in .env', async () => {
    await api().put('/credentials/github_token', 'nope').expect(400);
    await api().put('/credentials/not_a_key', 'x').expect(404);
    await api().del('/credentials/not_a_key').expect(404);
    process.env.JIRA_EMAIL = 'env@example.com';
    try {
      await api().put('/credentials/jira_email', 'other@example.com').expect(409);
      expect((await api().get('/credentials')).body.find((v: { key: string }) => v.key === 'jira_email')).toMatchObject({ source: 'env' });
    } finally {
      delete process.env.JIRA_EMAIL;
    }
  });

  it('tests the GitHub token against GitHub: connected, then rejected', async () => {
    await api().put('/credentials/github_token', GH).expect(200);
    const ok = await api().post('/credentials/github_token/test').expect(200);
    expect(ok.body).toEqual({ ok: true, message: 'Connected as octo' });
    expect(calls[0]).toMatchObject({ url: 'https://github.test/user' });
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${GH}`);
    expect((await api().get('/credentials')).body.find((v: { key: string }) => v.key === 'github_token').verifiedAt).not.toBeNull();

    ghStatus = 401;
    const bad = await api().post('/credentials/github_token/test').expect(200);
    expect(bad.body).toEqual({ ok: false, message: 'GitHub rejected the token' });
    expect((await api().get('/credentials')).body.find((v: { key: string }) => v.key === 'github_token')).toMatchObject({ verifiedAt: null, verifyError: 'GitHub rejected the token' });
  });

  it('tests Jira with the three values, and says what is missing otherwise', async () => {
    expect((await api().post('/credentials/jira_api_token/test').expect(200)).body.ok).toBe(false);
    await api().put('/credentials/jira_base_url', 'https://acme.atlassian.net').expect(200);
    await api().put('/credentials/jira_email', 'me@example.com').expect(200);
    await api().put('/credentials/jira_api_token', 'j'.repeat(30)).expect(200);
    expect((await api().post('/credentials/jira_api_token/test').expect(200)).body).toEqual({ ok: true, message: 'Connected as Jira Dev' });
    expect(calls.at(-1)?.url).toBe('https://acme.atlassian.net/rest/api/3/myself');
    jiraStatus = 401;
    expect((await api().post('/credentials/jira_email/test').expect(200)).body).toEqual({ ok: false, message: 'Jira rejected the credentials' });
  });

  it('checks only the format of the Claude token and deletes credentials', async () => {
    await api().put('/credentials/claude_token', 'sk-ant-oat01-abcdefghij').expect(200);
    expect((await api().post('/credentials/claude_token/test').expect(200)).body.message).toContain('verified on the first stage run');
    await api().del('/credentials/claude_token').expect(204);
    expect((await api().post('/credentials/claude_token/test').expect(200)).body.ok).toBe(false);
    expect(await app.get(CredentialsService).resolve()).toMatchObject({ claude_token: '' });
  });
});
