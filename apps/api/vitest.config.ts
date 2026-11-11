import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// swc emits decorator metadata, which NestJS dependency injection needs (esbuild does not).
export default defineConfig({
  test: { globals: false, environment: 'node' },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
