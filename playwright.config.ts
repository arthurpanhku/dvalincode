import { defineConfig } from 'playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.e2e.ts',
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:5921',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'node tests/e2e/start-server.mjs',
    url: 'http://127.0.0.1:5921',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
