import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { browserRequired, launchFixtureBrowser } from './browser-fixture.js';

it('requires Chromium when the browser gate enables required mode', async () => {
  const previous = process.env.PB_UI_BROWSER_REQUIRED;
  process.env.PB_UI_BROWSER_REQUIRED = '1';
  try {
    await expect(
      launchFixtureBrowser({
        required: browserRequired(),
        launch: async () => {
          throw new Error("Executable doesn't exist");
        },
        stop: async () => {},
      }),
    ).rejects.toThrow('UI browser launch failed');
  } finally {
    if (previous === undefined) delete process.env.PB_UI_BROWSER_REQUIRED;
    else process.env.PB_UI_BROWSER_REQUIRED = previous;
  }
});

it('connects the required browser launcher to pnpm check', async () => {
  const root = JSON.parse(
    await readFile(new URL('../../../package.json', import.meta.url), 'utf8'),
  );
  expect(root.scripts.check).toContain('pnpm check:ui-browser');
  expect(root.scripts.check).toContain(
    "pnpm test --exclude '**/test-support/**' --exclude '**/*.browser.test.ts'",
  );
  expect(root.scripts['check:ui-browser']).toBe(
    'node packages/ui/test-support/run-browser-tests.mjs',
  );
});

it('launches only UI browser test files in required mode and forwards failure status', async () => {
  const { runBrowserTests } = await import(
    new URL('./run-browser-tests.mjs', import.meta.url).href
  );
  const run = vi.fn(() => ({ status: 37 }));
  expect(runBrowserTests(run)).toBe(37);
  expect(run).toHaveBeenCalledWith(
    process.execPath,
    [
      expect.stringContaining('vitest.mjs'),
      'run',
      '--project',
      'ui',
      'test-support/',
      'review-interactions.test.ts',
      '.browser.test.ts',
    ],
    expect.objectContaining({
      cwd: fileURLToPath(new URL('../../..', import.meta.url)),
      env: expect.objectContaining({ PB_UI_BROWSER_REQUIRED: '1' }),
      stdio: 'inherit',
    }),
  );
});
