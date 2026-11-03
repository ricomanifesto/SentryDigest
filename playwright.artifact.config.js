// Reader acceptance for a built static artifact, separate from the fixture-driven
// suite in playwright.config.js. Requires STATIC_ARTIFACT_STORE.
const { defineConfig, devices } = require('@playwright/test');

const port = process.env.STATIC_ARTIFACT_PORT || '4174';
const store = process.env.STATIC_ARTIFACT_STORE;

if (!store) {
  throw new Error('STATIC_ARTIFACT_STORE must name a store built by scripts/build-static-artifact.js');
}

module.exports = defineConfig({
  testDir: './tests/artifact-browser',
  outputDir: './test-results/artifact-playwright',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    locale: 'en-US',
    timezoneId: 'UTC',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `node scripts/serve-static-artifact.js --store ${JSON.stringify(store)} --port ${port}`,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
  },
});
