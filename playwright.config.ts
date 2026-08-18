import { defineConfig, devices } from '@playwright/test';

const DEV_PORT = 4321;
const PREVIEW_PORT = 4322;

// the app talks to live open-data services (IGN, BRouter, Terrarium), so e2e runs stay
// serial and generous on timeouts: a flaky third party must not look like a broken app
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  // one retry everywhere: a slow tile or routing answer must not read as a broken app
  retries: 1,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? 'github' : [['list']],
  use: {
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  projects: [
    {
      name: 'dev',
      testIgnore: /production\./,
      use: { baseURL: `http://localhost:${DEV_PORT}` },
    },
    {
      // the built site is the one users get, and bundling has its own failure modes
      name: 'production',
      testMatch: /production\./,
      use: { baseURL: `http://localhost:${PREVIEW_PORT}` },
    },
  ],
  webServer: [
    {
      command: `pnpm vite --port ${DEV_PORT} --strictPort`,
      url: `http://localhost:${DEV_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: `pnpm build && pnpm vite preview --port ${PREVIEW_PORT} --strictPort`,
      url: `http://localhost:${PREVIEW_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
});
