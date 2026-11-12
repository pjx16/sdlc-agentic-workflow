import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { createTestDatabase, type TestDatabase } from '../testing/test-db';
import { CredentialsService, UNDECRYPTABLE } from './credentials.service';

const GH = 'ghp_abcdefghijklmnopqrstuvwx';
let db: TestDatabase;
let prisma: PrismaService;
let svc: CredentialsService;
const saved = { ...process.env };

beforeAll(async () => {
  db = await createTestDatabase();
  process.env.DATABASE_URL = db.url;
  prisma = new PrismaService();
  svc = new CredentialsService(prisma);
}, 180_000);
afterAll(async () => {
  await prisma.onModuleDestroy();
  await db.drop();
});
afterEach(async () => {
  process.env = { ...saved };
  await prisma.credential.deleteMany();
  svc.invalidate();
});

describe('CredentialsService', () => {
  it('stores secrets encrypted, plain values as plain text, and decrypts on resolve', async () => {
    process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
    delete process.env.GITHUB_TOKEN;
    await svc.set('github_token', GH);
    await svc.set('git_author_name', 'Dev Bot');
    const rows = Object.fromEntries((await prisma.credential.findMany()).map((r) => [r.key, r.value]));
    expect(rows.github_token).toMatch(/^v1\./);
    expect(rows.github_token).not.toContain(GH);
    expect(rows.git_author_name).toBe('Dev Bot');
    const resolved = await svc.resolve();
    expect(resolved.github_token).toBe(GH);
    expect(resolved.git_author_name).toBe('Dev Bot');
    expect(svc.secretsSnapshot()).toContain(GH);
  });

  it('lets an env var beat the database, shows it as env, and refuses to overwrite it', async () => {
    process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
    delete process.env.GITHUB_TOKEN;
    await svc.set('github_token', GH);
    process.env.GITHUB_TOKEN = 'ghp_fromenvfromenvfromenv1234';
    expect((await svc.resolve()).github_token).toBe('ghp_fromenvfromenvfromenv1234');
    expect((await svc.views()).find((v) => v.key === 'github_token')).toMatchObject({ source: 'env', hint: '1234' });
    await expect(svc.set('github_token', GH)).rejects.toMatchObject({ status: 409 });
  });

  it('refreshes the cache on set, never exposes a secret in views, and needs ENCRYPTION_KEY for secrets', async () => {
    delete process.env.ENCRYPTION_KEY;
    delete process.env.GITHUB_TOKEN;
    await expect(svc.set('github_token', GH)).rejects.toThrow('ENCRYPTION_KEY is not set');
    await expect(svc.set('github_token', 'nope')).rejects.toMatchObject({ status: 400 });
    process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
    expect((await svc.resolve()).github_token).toBe('');
    await svc.set('github_token', GH);
    expect((await svc.resolve()).github_token).toBe(GH);
    const views = JSON.stringify(await svc.views());
    expect(views).not.toContain(GH);
    expect(views).toContain('"hint":"uvwx"');
  });

  it('reports an undecryptable value instead of throwing', async () => {
    process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
    delete process.env.GITHUB_TOKEN;
    await svc.set('github_token', GH);
    process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64'); // a different key
    svc.invalidate();
    expect((await svc.resolve()).github_token).toBe('');
    expect((await svc.views()).find((v) => v.key === 'github_token')).toMatchObject({ source: 'db', verifyError: UNDECRYPTABLE });
  });

  it('reports what is missing', async () => {
    for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'GITHUB_TOKEN', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'DASHBOARD_PASSWORD']) delete process.env[k];
    const status = await svc.status();
    expect(status).toMatchObject({ adminCreated: false, ready: false, missing: ['claude_token', 'github_token', 'git_author_name', 'git_author_email'] });
  });
});
