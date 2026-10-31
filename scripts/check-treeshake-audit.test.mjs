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
      for (const profile of ['minimal', 'default', 'automatic']) {
        const out = join(dir, `${profile}-${target}`);
        await mkdir(join(out, 'generated'), { recursive: true });
        await writeFile(
          join(out, 'generated/manifest.json'),
          JSON.stringify({ audit: { trail: null, sinks: [] } }),
        );
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
        if (profile !== 'minimal')
          for (const name of ['trail', 'otlp', 'webhook'])
            result.metafile.inputs[`packages/plugin-audit-${name}/dist/index.js`] = {
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
      for (const profile of ['minimal', 'default', 'automatic']) {
        assert.ok(child.stderr.includes(`${profile}/${target}: forbidden modules in bundle`));
      }
    }
    assert.match(child.stderr, /audit\/plugin-testing\.js/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const missing of [
  null,
  'trail',
  'otlp',
  'webhook',
  'automatic',
  'minimal-trail',
  'minimal-sink',
])
  test(`tree-shake gate enforces audit composition (${missing ?? 'all present'})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pb-release-treeshake-'));
    try {
      for (const target of ['cloudflare', 'node']) {
        for (const profile of ['minimal', 'default', 'automatic']) {
          const out = join(dir, `${profile}-${target}`);
          await mkdir(join(out, 'generated'), { recursive: true });
          await writeFile(
            join(out, 'generated/manifest.json'),
            JSON.stringify({
              audit: {
                trail:
                  profile === 'minimal' && missing === 'minimal-trail'
                    ? { plugin: 'audit-trail' }
                    : null,
                sinks: profile === 'minimal' && missing === 'minimal-sink' ? [{ id: 'sink' }] : [],
              },
            }),
          );
          const names =
            profile === 'minimal'
              ? []
              : (profile === 'automatic' ? ['trail'] : ['trail', 'otlp', 'webhook']).filter(
                  (name) =>
                    name !== missing && !(profile === 'automatic' && missing === 'automatic'),
                );
          const inputs = Object.fromEntries(
            names.map((name) => [
              `packages/plugin-audit-${name}/dist/index.js`,
              { bytes: 1, imports: [] },
            ]),
          );
          await writeFile(
            join(out, 'metafile.json'),
            JSON.stringify({ inputs, outputs: { 'bundle.js': { imports: [] } } }),
          );
          await writeFile(join(out, 'bundle.js'), 'export default 1;');
        }
      }
      const child = spawnSync(process.execPath, ['scripts/check-treeshake.mjs'], {
        cwd: root,
        env: { ...process.env, PB_CHECK_TREESHAKE_FIXTURE: dir },
        encoding: 'utf8',
      });
      assert.equal(child.status, missing === null ? 0 : 1);
      if (missing !== null)
        for (const target of ['cloudflare', 'node'])
          assert.ok(
            child.stderr.includes(
              missing === 'automatic'
                ? `automatic/${target}: missing default-added audit trail plugin`
                : missing.startsWith('minimal-')
                  ? `minimal/${target}: expected no audit trail and no sinks`
                  : `default/${target}: missing compiled audit plugin: audit-${missing}`,
            ),
          );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
