import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '../tests',
  testMatch: 'ui.spec.ts',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  outputDir: process.env.PB_UI_E2E_OUTPUT,
  preserveOutput: 'never',
  use: { trace: 'off', screenshot: 'off', video: 'off' },
});
