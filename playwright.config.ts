import { defineConfig, devices } from '@playwright/test';

// GitHub's Ubuntu runner already includes Google Chrome. Use it in CI so PRs do not download a
// second Chromium build; local runs stay on Playwright's pinned browser for a hermetic setup.
const browserChannel = process.env.CI ? 'chrome' : undefined;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['line'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    // The browser suite exercises scoring workflows, not the one-time device setup prompt.
    // Seed the acknowledgement so each isolated test context starts at the scoresheet entry point.
    storageState: {
      cookies: [],
      origins: [
        {
          origin: 'http://127.0.0.1:4173',
          localStorage: [{ name: 'qbsheet.operator-name-asked.v1', value: '1' }],
        },
      ],
    },
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        channel: browserChannel,
        viewport: { width: 1280, height: 800 },
      },
    },
  ],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
