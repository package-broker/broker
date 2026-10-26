import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export function runBrowserTests(run = spawnSync) {
  const require = createRequire(import.meta.url);
  const result = run(
    process.execPath,
    [
      join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs'),
      'run',
      '--project',
      'ui',
      'test-support/',
      'review-interactions.test.ts',
      '.browser.test.ts',
    ],
    {
      cwd: fileURLToPath(new URL('../../..', import.meta.url)),
      env: { ...process.env, PB_UI_BROWSER_REQUIRED: '1' },
      stdio: 'inherit',
    },
  );
  if (result.error) console.error('UI browser gate could not start');
  return result.status ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = runBrowserTests();
