import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./src/test/global-setup.ts'],
    setupFiles: ['./src/test/setup.ts'],
    // Run test files sequentially — avoids races on shared DB state
    fileParallelism: false,
    testTimeout: 15000,
  },
});
