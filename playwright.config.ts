import { defineConfig, devices } from '@playwright/test';

const WEB = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

export default defineConfig({
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  outputDir: 'test-results/playwright',
  projects: [
    { name: 'parity', testDir: 'tests/parity', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'e2e',
      testDir: 'tests/e2e',
      use: {
        ...devices['Desktop Chrome'],
        locale: 'en-GB',
        baseURL: WEB,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
});
