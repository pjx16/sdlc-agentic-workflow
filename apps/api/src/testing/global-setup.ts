import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

/**
 * Starts one Postgres for the whole test run (BUILD_PLAN section 11, Testcontainers).
 * Set TEST_PG_URL to reuse an already running Postgres (for example the Compose one) and skip the container.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const existing = process.env.TEST_PG_URL;
  if (existing) {
    project.provide('pgAdminUrl', existing);
    return async () => undefined;
  }
  const container = await new PostgreSqlContainer('postgres:17').start();
  project.provide('pgAdminUrl', container.getConnectionUri());
  return async () => {
    await container.stop();
  };
}
