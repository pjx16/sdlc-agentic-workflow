import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// swc emits decorator metadata, which NestJS dependency injection needs (esbuild does not).
// `unit` needs nothing running. `int` needs Docker: it starts one Postgres (Testcontainers) for the whole run.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    projects: [
      {
        extends: true,
        test: { name: 'unit', environment: 'node', include: ['src/**/*.test.ts'], exclude: ['src/**/*.int.test.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'int',
          environment: 'node',
          include: ['src/**/*.int.test.ts'],
          globalSetup: ['./src/testing/global-setup.ts'],
          testTimeout: 20_000,
        },
      },
    ],
  },
});
