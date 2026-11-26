import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['packages/**/src/**/*.test.ts', 'tests/unit/**/*.test.ts'], environment: 'node' } },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          globalSetup: ['tests/support/global-setup-integration.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          pool: 'forks',
          env: { LOG_LEVEL: 'silent', TRENDORA_TEMPLATE_DB: 'trendora_test_template_int' },
        },
      },
      {
        test: {
          name: 'rls',
          include: ['tests/rls/**/*.test.ts'],
          globalSetup: ['tests/support/global-setup-rls.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          env: { LOG_LEVEL: 'silent', TRENDORA_TEMPLATE_DB: 'trendora_test_template_rls' },
        },
      },
    ],
  },
});
