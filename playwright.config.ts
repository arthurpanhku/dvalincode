import { defineConfig } from 'playwright/test';
import { E2E_TOKEN } from './tests/e2e/token';

const executablePath = process.env.DVALINCODE_E2E_BROWSER;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.e2e.ts',
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:5921',
    trace: 'on-first-retry',
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  webServer: {
    command: 'node tests/e2e/start-server.mjs',
    env: { DVALINCODE_SERVER_TOKEN: E2E_TOKEN },
    url: 'http://127.0.0.1:5921',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
