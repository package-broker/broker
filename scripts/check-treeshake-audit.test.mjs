import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const { build } = createRequire(new URL('../packages/cli/package.json', import.meta.url))(
  'esbuild',
);

test('tree-shake gate rejects a fixture importing the conformance kit on both runtimes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-audit-treeshake-'));
  try {
    for (const target of ['cloudflare', 'node']) {
      for (const profile of ['minimal', 'default']) {
        const out = join(dir, `${profile}-${target}`);
        await mkdir(out);
        const result = await build({
          stdin: {
            contents: `import { auditCanonicalVectors } from '@package-broker/core/plugin/testing';
              console.log(auditCanonicalVectors);`,
            resolveDir: root,
          },
          bundle: true,
          format: 'esm',
          write: false,
          metafile: true,
          outfile: 'bundle.js',
        });
        // The default profile must also satisfy the independent plugin-presence check.
        if (profile === 'default')
          result.metafile.inputs['packages/plugin-fixture/src/index.js'] = {
            bytes: 0,
            imports: [],
          };
        await writeFile(join(out, 'bundle.js'), result.outputFiles[0].text);
        await writeFile(join(out, 'metafile.json'), JSON.stringify(result.metafile));
      }
    }
    const child = spawnSync(process.execPath, ['scripts/check-treeshake.mjs'], {
      cwd: root,
      env: { ...process.env, PB_CHECK_TREESHAKE_FIXTURE: dir },
      encoding: 'utf8',
    });
    assert.equal(child.status, 1);
    for (const target of ['cloudflare', 'node']) {
      for (const profile of ['minimal', 'default']) {
        assert.ok(child.stderr.includes(`${profile}/${target}: forbidden modules in bundle`));
      }
    }
    assert.match(child.stderr, /audit\/plugin-testing\.js/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
