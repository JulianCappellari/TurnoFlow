import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    globalSetup: ['packages/db/test/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // DB suites share one database; each test uses its own tenant, so files can run in parallel.
  },
});
