import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    swc.vite({
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: 'es2023',
      },
    }),
  ],
  test: {
    include: ['test/**/*.e2e-spec.ts'],
    setupFiles: ['dotenv/config'],
    env: {
      COLLABORATION_PORT: '41234',
      COLLABORATION_URL: 'ws://127.0.0.1:41234',
      COLLABORATION_DEBOUNCE_MS: '200',
      COLLABORATION_MAX_DEBOUNCE_MS: '800',
    },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
