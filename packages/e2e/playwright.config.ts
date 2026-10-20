import { defineConfig } from '@playwright/test';

// Playwright 1.63 also captures failure page snapshots when visual artifacts are off.
process.env['PLAYWRIGHT_NO_COPY_PROMPT'] = '1';

export default defineConfig({
  testDir: 'browser',
  testMatch: '**/*.spec.ts',
  timeout: 180_000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: { browserName: 'chromium', headless: true, trace: 'off', screenshot: 'off', video: 'off' },
});
