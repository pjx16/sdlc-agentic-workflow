import { defineConfig } from '@playwright/test';

/**
 * End-to-end suite (BUILD_PLAN 11). `global-setup.ts` starts a Postgres container, applies the migrations, seeds a small world,
 * and starts the built API and the dashboard; the tests then drive a real browser against them. The worker is not started: every
 * state the pages show is seeded, and the pipeline itself is covered by the integration tests (with the fake-claude stand-in).
 */
export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:3100', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
