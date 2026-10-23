import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const entry = fileURLToPath(new URL('../scripts/ui-e2e.mjs', import.meta.url));

for (const ci of [undefined, 'false', '1']) {
  test(`UI entry skips browser imports and processes with CI=${String(ci)}`, () => {
    const hook = `import { registerHooks } from 'node:module';
      registerHooks({ resolve(specifier, context, next) {
        if (/playwright|child_process|browser\\/fixtures/.test(specifier)) {
          throw new Error('local entry imported browser machinery');
        }
        return next(specifier, context);
      }});`;
    const env: Record<string, string | undefined> = { ...process.env, CI: ci };
    if (ci === undefined) delete env.CI;
    const start = performance.now();
    const result = spawnSync(
      process.execPath,
      ['--import', `data:text/javascript;base64,${Buffer.from(hook).toString('base64')}`, entry],
      { env, encoding: 'utf8', timeout: 2_000 },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(
      'UI end-to-end tests run in CI only (D14)\n' +
        'Run after pnpm build and pnpm bundle, with Chromium installed: CI=true node packages/e2e/scripts/ui-e2e.mjs\n',
    );
    expect(performance.now() - start).toBeLessThan(2_000);
  });
}
