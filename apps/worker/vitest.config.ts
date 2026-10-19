import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', testTimeout: 300_000, hookTimeout: 300_000, fileParallelism: false },
});
