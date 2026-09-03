/**
 * Playwright for the Director application, which is a different application from the website.
 *
 * # Why this is a second config and not a second project
 *
 * The two runs need different servers on different ports, and Playwright starts every entry in a
 * config's `webServer` list whichever project you asked for. One config with both would boot the
 * Director dev server for every scorer run and the scorer's for every Director run, in CI as well,
 * where the two are separate jobs precisely so that neither pays for the other. Two configs keep
 * each run to the one server it actually drives.
 *
 * The scorer's config ignores `e2e/director/` for the same reason; see `testIgnore` there.
 *
 * `apps/director` owns the port. `npm run director:dev` is `vite --host 127.0.0.1 --port 1420` with
 * `strictPort`, so a stale server on that port fails the run rather than silently serving something
 * else — which is the behaviour worth having when the thing under test is an application whose
 * whole point is being local.
 */
import { defineConfig, devices } from '@playwright/test';

// GitHub's Ubuntu runner already includes Google Chrome. Use it in CI so PRs do not download a
// second Chromium build; local runs stay on Playwright's pinned browser for a hermetic setup.
const browserChannel = process.env.CI ? 'chrome' : undefined;

export default defineConfig({
  testDir: './e2e/director',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['line'], ['html', { open: 'never', outputFolder: 'playwright-report-director' }]],
  outputDir: 'test-results-director',
  use: {
    baseURL: 'http://127.0.0.1:1420',
    // Director's UI is not a PWA and installs no worker. Blocking one keeps a stray registration
    // from a previous run on this profile out of the application under test.
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
        // The width the Director layout's panel and table contracts are written against, and the
        // one the spec narrows from when it checks the narrow-window behaviour.
        viewport: { width: 1280, height: 800 },
      },
    },
  ],
  webServer: {
    command: 'npm run director:dev',
    url: 'http://127.0.0.1:1420',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
