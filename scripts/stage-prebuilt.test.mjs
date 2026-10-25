import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { prebuiltProblems } from './check-pack.mjs';
import {
  checkConsistency,
  checkReproducible,
  listFiles,
  sha256,
  stagePrebuilt,
} from './stage-prebuilt.mjs';

const ROOT = new URL('../.pb/', import.meta.url);
mkdirSync(ROOT, { recursive: true });
const write = (root, path, content) => {
  const destination = join(root, path);
  mkdirSync(join(destination, '..'), { recursive: true });
  writeFileSync(destination, typeof content === 'object' ? JSON.stringify(content) : content);
};
function fixture(t) {
  const root = mkdtempSync(new URL('stage-test-', ROOT));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const info = {
    dirty: false,
    gitSha: 'a'.repeat(40),
    lockfileSha256: 'b'.repeat(64),
    plugins: { example: '1.0.0' },
  };
  function build() {
    for (const [target, pkg] of [
      ['node', 'prebuilt'],
      ['cloudflare', 'prebuilt-cloudflare'],
    ]) {
      write(root, `.pb/${target}/build-info.json`, info);
      write(root, `.pb/${target}/assets.json`, { digest: `sha256:${'c'.repeat(64)}` });
      write(root, `.pb/${target}/migrations/core/0001_init.sql`, 'migration bytes');
      write(root, `.pb/${target}/${target === 'node' ? 'server' : 'worker'}.js`, 'bundle bytes');
      write(root, `.pb/${target}/generated/manifest.json`, { schemaVersion: 1 });
      write(root, `packages/${pkg}/package.json`, { name: `dist-${target}`, version: '2.0.0' });
    }
  }
  build();
  write(
    root,
    'packages/runtime-cloudflare/wrangler.toml',
    'main = "../../.pb/cloudflare/worker.js"\n# [[d1_databases]]\n# binding = "DB"\n# [assets]\n# binding = "ASSETS"\n# directory = "../../.pb/cloudflare/assets"\n',
  );
  mkdirSync(join(root, 'packages/cli/dist'), { recursive: true });
  return {
    root,
    info,
    build,
    node: join(root, '.pb/node'),
    cloudflare: join(root, '.pb/cloudflare'),
  };
}

for (const target of ['node', 'cloudflare']) {
  for (const [label, change, message] of [
    ['dirty true', { dirty: true }, /dirty must be false/],
    ['dirty null', { dirty: null }, /dirty must be false/],
    ['dirty missing', { dirty: undefined }, /dirty must be false/],
    ['gitSha missing', { gitSha: undefined }, /gitSha must be 40 hex/],
    ['gitSha invalid', { gitSha: 'abc' }, /gitSha must be 40 hex/],
    ['lockfile missing', { lockfileSha256: null }, /lockfileSha256 must be 64 hex/],
  ])
    test(`${target}: rejects ${label}`, (t) => {
      const f = fixture(t);
      write(f.root, `.pb/${target}/build-info.json`, { ...f.info, ...change });
      assert.throws(() => checkConsistency(f.node, f.cloudflare), message);
    });
}

for (const change of ['different bytes', 'missing migration', 'extra migration'])
  test(`rejects ${change}`, (t) => {
    const f = fixture(t);
    const path = '.pb/cloudflare/migrations/core/0001_init.sql';
    if (change === 'missing migration') rmSync(join(f.root, path));
    else
      write(
        f.root,
        change === 'extra migration' ? '.pb/cloudflare/migrations/core/0002_extra.sql' : path,
        'different',
      );
    assert.throws(() => checkConsistency(f.node, f.cloudflare), /Migration bytes differ/);
  });

test('rejects differing asset digests', (t) => {
  const f = fixture(t);
  write(f.root, '.pb/cloudflare/assets.json', { digest: 'different' });
  assert.throws(() => checkConsistency(f.node, f.cloudflare), /Asset digests differ/);
});

test('rejects differing lockfile digests', (t) => {
  const f = fixture(t);
  write(f.root, '.pb/cloudflare/build-info.json', { ...f.info, lockfileSha256: 'd'.repeat(64) });
  assert.throws(() => checkConsistency(f.node, f.cloudflare), /lockfileSha256 values differ/);
});

test('reproducibility rebuilds clean directories and compares every path', (t) => {
  const f = fixture(t);
  const result = checkReproducible(f.root, () => {
    assert.throws(() => readFileSync(join(f.node, 'server.js')), /ENOENT/);
    assert.throws(() => readFileSync(join(f.cloudflare, 'worker.js')), /ENOENT/);
    f.build();
  });
  assert.deepEqual(result.before, result.after);
});

for (const change of ['changed', 'added', 'removed'])
  test(`reproducibility detects ${change} payload files`, (t) => {
    const f = fixture(t);
    assert.throws(
      () =>
        checkReproducible(f.root, () => {
          f.build();
          if (change === 'removed') rmSync(join(f.cloudflare, 'worker.js'));
          else
            write(
              f.root,
              `.pb/cloudflare/${change === 'added' ? 'extra.js' : 'worker.js'}`,
              'changed bytes',
            );
        }),
      /Reproducibility digests differ:\ncloudflare\/(?:extra|worker)\.js/,
    );
  });

test('stages only payload, clears stale files, derives template and anchors exact JSON bytes', async (t) => {
  const f = fixture(t);
  for (const path of [
    'server.js.map',
    'metafile.json',
    'generated/manifest.ts',
    'package.json',
    'nested/package.json',
    'nested/a.test.js',
    'test/a.js',
    'state/secret',
  ])
    write(f.root, `.pb/node/${path}`, 'excluded');
  write(f.root, 'packages/prebuilt/node/stale.js', 'stale');
  let calls = 0;
  const { records } = await stagePrebuilt({
    root: f.root,
    writeCliExpected: true,
    esbuildVersion: '0.28.2',
    validateArtifact: async (path) => {
      calls++;
      assert.equal(path, join(f.root, 'packages/prebuilt-cloudflare/cloudflare'));
      assert.equal(readFileSync(join(path, 'worker.js'), 'utf8'), 'bundle bytes');
      return { artifactHash: 'd'.repeat(64) };
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(Object.keys(records.node.files), [
    'assets.json',
    'build-info.json',
    'generated/manifest.json',
    'migrations/core/0001_init.sql',
    'server.js',
  ]);
  assert.equal(records.node.artifactSha256, null);
  assert.deepEqual(records.node.toolchain, {
    node: process.version,
    esbuild: '0.28.2',
    os: process.platform,
    arch: process.arch,
  });
  assert.equal(records.cloudflare.artifactSha256, 'd'.repeat(64));
  assert.equal(records.cloudflare.files['worker.js'], `sha256:${sha256('bundle bytes')}`);
  const template = readFileSync(
    join(f.root, 'packages/prebuilt-cloudflare/cloudflare/wrangler.toml'),
    'utf8',
  );
  assert.match(template, /^main = "worker.js"$/m);
  assert.match(template, /^\[assets\]$/m);
  assert.match(template, /^directory = "\.\/assets"$/m);
  assert.match(template, /^# binding = "ASSETS"$/m);
  const bytes = readFileSync(join(f.root, 'packages/prebuilt-cloudflare/prebuilt.json'));
  assert.deepEqual(
    JSON.parse(readFileSync(join(f.root, 'packages/cli/dist/prebuilt-expected.json'))),
    {
      schemaVersion: 1,
      package: 'dist-cloudflare',
      version: '2.0.0',
      artifactSha256: 'd'.repeat(64),
      prebuiltJsonSha256: sha256(bytes),
    },
  );
  const dir = join(f.root, 'packages/prebuilt-cloudflare');
  assert.deepEqual(prebuiltProblems(dir, listFiles(dir), 'cloudflare'), []);
  write(f.root, 'packages/prebuilt-cloudflare/cloudflare/unlisted.js', 'unlisted');
  assert.deepEqual(prebuiltProblems(dir, listFiles(dir), 'cloudflare'), [
    'prebuilt.json unlisted payload file: cloudflare/unlisted.js',
  ]);
  rmSync(join(dir, 'cloudflare/unlisted.js'));
  write(f.root, 'packages/prebuilt-cloudflare/cloudflare/worker.js', 'tampered');
  assert.deepEqual(prebuiltProblems(dir, listFiles(dir), 'cloudflare'), [
    'prebuilt.json digest mismatch: cloudflare/worker.js',
  ]);
  rmSync(join(dir, 'cloudflare/worker.js'));
  assert.deepEqual(prebuiltProblems(dir, listFiles(dir), 'cloudflare'), [
    'prebuilt.json listed file missing: cloudflare/worker.js',
  ]);
});

test('pack validator refuses invalid schema and unsafe file paths', (t) => {
  const f = fixture(t);
  const dir = join(f.root, 'packages/prebuilt');
  write(f.root, 'packages/prebuilt/prebuilt.json', {
    schemaVersion: 2,
    files: { '../escape': 'sha256:x' },
  });
  assert.deepEqual(prebuiltProblems(dir, listFiles(dir), 'node'), [
    'prebuilt.json schemaVersion must be 1',
    'prebuilt.json contains an invalid payload path',
  ]);
});

for (const dirty of [true, null])
  test(`staging refuses dirty ${dirty} before copying or hashing`, async (t) => {
    const f = fixture(t);
    write(f.root, '.pb/node/build-info.json', { ...f.info, dirty });
    await assert.rejects(
      stagePrebuilt({
        root: f.root,
        validateArtifact: () => assert.fail('must not hash a refused build'),
      }),
      /dirty must be false/,
    );
  });

test('staging reproducibility option invokes the builder and refuses differences', async (t) => {
  const f = fixture(t);
  let calls = 0;
  await assert.rejects(
    stagePrebuilt({
      root: f.root,
      reproducible: true,
      builder: () => {
        calls++;
        f.build();
        write(f.root, '.pb/cloudflare/worker.js', 'changed');
      },
      validateArtifact: () => assert.fail('must refuse before deployment hashing'),
    }),
    /Reproducibility digests differ:\ncloudflare\/worker.js/,
  );
  assert.equal(calls, 1);
});
