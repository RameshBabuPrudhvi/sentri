import { defineConfig } from './utils/playwright.mjs';

const frontendBaseURL = process.env.E2E_FRONTEND_URL || 'http://127.0.0.1:4173';
const backendBaseURL = process.env.E2E_BACKEND_URL || 'http://127.0.0.1:3001';

export default defineConfig({
  testDir: './specs',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [
    ['list'],
    ['json', { outputFile: 'artifacts/results.json' }],
    ['html', { outputFolder: 'artifacts/html-report', open: 'never' }],
  ],
  fullyParallel: false,
  workers: 1,
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'api',
      use: {
        baseURL: backendBaseURL,
      },
      testMatch: /.*(api-auth|full-functional-api)\.spec\.mjs/,
    },
    {
      name: 'ui-chromium',
      use: {
        baseURL: frontendBaseURL,
        browserName: 'chromium',
        headless: true,
      },
      testMatch: /.*ui-smoke\.spec\.mjs/,
    },
  ],
});
