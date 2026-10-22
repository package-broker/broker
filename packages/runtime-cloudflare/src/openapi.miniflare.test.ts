import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { expect, it } from 'vitest';

it('serves the committed OpenAPI document from the assembled Worker in Miniflare', async () => {
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  const cliRequire = createRequire(join(root, 'packages/cli/package.json'));
  const script = execFileSync(
    cliRequire.resolve('esbuild/bin/esbuild'),
    [
      '--bundle',
      '--format=esm',
      '--platform=neutral',
      '--conditions=workerd,worker,browser',
      '--external:cloudflare:*',
      '--external:node:async_hooks',
      '--external:node:buffer',
      '--external:node:zlib',
      `--alias:@package-broker/core=${root}/packages/core/src`,
      `--alias:@package-broker/db-sqlite=${root}/packages/db-sqlite/src`,
    ],
    {
      cwd: root,
      input:
        "import { createWorker } from './packages/runtime-cloudflare/src/index.ts';\n" +
        'export default createWorker([]);\n',
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script,
      compatibilityDate: '2026-10-01',
      compatibilityFlags: ['nodejs_compat'],
    }),
  );
  try {
    const response = await mf.dispatchFetch('https://broker.invalid/_pb/openapi.json');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe(
      await readFile(new URL('../../ui/openapi.json', import.meta.url), 'utf8'),
    );
  } finally {
    await mf.dispose();
  }
});
