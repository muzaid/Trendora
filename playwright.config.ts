import { defineConfig, devices } from '@playwright/test';

/**
 * E2E against the sandbox stack. CI starts a freshly seeded server; locally an
 * already running `pnpm dev` is reused.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 240_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000', trace: 'off', ...devices['Desktop Chrome'], launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {} },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : { command: 'pnpm db:seed --reset && pnpm dev', url: 'http://localhost:3000/v1/health', reuseExistingServer: true, timeout: 180_000 },
});
