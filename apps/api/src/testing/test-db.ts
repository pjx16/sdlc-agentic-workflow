import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { inject } from 'vitest';

export interface TestDatabase {
  url: string;
  drop(): Promise<void>;
}

/** Creates a fresh, fully migrated database so test files never share state. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = inject('pgAdminUrl');
  const name = `t_${randomBytes(6).toString('hex')}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: url.toString() },
    stdio: 'pipe',
  });

  return {
    url: url.toString(),
    async drop() {
      const c = new Client({ connectionString: adminUrl });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}
