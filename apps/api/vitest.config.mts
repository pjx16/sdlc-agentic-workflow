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
        test: { name: 'unit', environment: 'node', include: ['src/**/*.test.ts'], exclude: ['src/**/*.int.test.ts', 'src/**/*.live.test.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'int',
          environment: 'node',
          include: ['src/**/*.int.test.ts'],
          // The Docker tests share one proxy container and the agent network, so files run one at a time.
          fileParallelism: false,
          globalSetup: ['./src/testing/global-setup.ts'],
          testTimeout: 20_000,
        },
      },
      {
        // Needs Docker, the images, a network and a real Claude token: run with LIVE_CLAUDE=1 npm run test:live
        extends: true,
        test: { name: 'live', environment: 'node', include: ['src/**/*.live.test.ts'], globalSetup: ['./src/testing/live-setup.ts'], testTimeout: 300_000, hookTimeout: 240_000 },
      },
    ],
  },
});
