import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { prebuiltProblems, releaseAnchorProblems, stagingState } from './check-pack.mjs';
import {
  checkConsistency,
  currentCommit,
  deriveWrangler,
  payloadFiles,
  checkReproducible,
  listFiles,
  sha256,
  stagePrebuilt,
} from './stage-prebuilt.mjs';

const ROOT = tmpdir();
const write = (root, path, content) => {
  const destination = join(root, path);
  mkdirSync(join(destination, '..'), { recursive: true });
  writeFileSync(destination, typeof content === 'object' ? JSON.stringify(content) : content);
};
function fixture(t) {
  const root = mkdtempSync(join(ROOT, 'stage-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const info = {
    dirty: false,
    gitSha: currentCommit(),
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
    assert.throws(
      () => checkConsistency(f.node, f.cloudflare),
      change === 'missing migration' ? /stale build: run pnpm bundle/ : /Migration bytes differ/,
    );
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
  for (const path of ['server.js.map', 'metafile.json', 'generated/manifest.ts', 'package.json'])
    write(f.root, `.pb/node/${path}`, 'excluded');
  write(f.root, 'packages/prebuilt/node/stale.js', 'stale');
  let calls = 0;
  const { records } = await stagePrebuilt({
    root: f.root,
    writeCliExpected: true,
    esbuildVersion: '0.28.2',
    validateArtifact: async (path) => {
      calls++;
      assert.equal(path.endsWith('/cloudflare'), true);
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
  const problems = prebuiltProblems(dir, listFiles(dir), 'node');
  assert.ok(problems.includes('prebuilt.json schemaVersion must be 1'));
  assert.ok(problems.includes('prebuilt.json contains an invalid payload path'));
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

for (const change of [
  'different commits',
  'stale commits',
  'plugins',
  'empty migrations',
  'empty assets',
])
  test(`consistency rejects ${change} with rebuild instruction`, (t) => {
    const f = fixture(t);
    if (change === 'different commits')
      write(f.root, '.pb/node/build-info.json', { ...f.info, gitSha: '1'.repeat(40) });
    if (change === 'stale commits')
      for (const target of ['node', 'cloudflare'])
        write(f.root, `.pb/${target}/build-info.json`, { ...f.info, gitSha: '2'.repeat(40) });
    if (change === 'plugins')
      write(f.root, '.pb/node/build-info.json', { ...f.info, plugins: { other: '2.0.0' } });
    if (change === 'empty migrations')
      for (const target of [f.node, f.cloudflare])
        rmSync(join(target, 'migrations'), { recursive: true });
    if (change === 'empty assets')
      for (const target of ['node', 'cloudflare'])
        write(f.root, `.pb/${target}/assets.json`, { digest: '' });
    assert.throws(() => checkConsistency(f.node, f.cloudflare), /stale build: run pnpm bundle/);
  });

test('current commit honors GITHUB_SHA', (t) => {
  const previous = process.env.GITHUB_SHA;
  t.after(() => {
    if (previous === undefined) delete process.env.GITHUB_SHA;
    else process.env.GITHUB_SHA = previous;
  });
  process.env.GITHUB_SHA = '3'.repeat(40);
  const f = fixture(t);
  assert.equal(currentCommit(), '3'.repeat(40));
  checkConsistency(f.node, f.cloudflare);
});

test('payload filtering preserves nested state, test and package metadata', (t) => {
  const f = fixture(t);
  const kept = [
    'nested/state/data',
    'nested/test/a.js',
    'test/a.js',
    'nested/a.test.js',
    'nested/package.json',
    'nested/metafile.json',
  ];
  for (const name of [
    ...kept,
    'package.json',
    'metafile.json',
    'generated/manifest.ts',
    'nested/a.js.map',
  ])
    write(f.node, name, 'bytes');
  const files = payloadFiles(f.node);
  for (const name of kept) assert.ok(files.includes(name), name);
  for (const name of ['package.json', 'metafile.json', 'generated/manifest.ts', 'nested/a.js.map'])
    assert.ok(!files.includes(name), name);
});

test('Wrangler derivation matches the real LF and CRLF template and requires every replacement', () => {
  const template = readFileSync(
    new URL('../packages/runtime-cloudflare/wrangler.toml', import.meta.url),
    'utf8',
  );
  for (const input of [template, template.replace(/\n/g, '\r\n')]) {
    const result = deriveWrangler(input);
    assert.match(result, /^main = "worker.js"$/m);
    assert.match(result, /^\[assets\]$/m);
    assert.match(result, /^directory = ".\/assets"$/m);
    assert.match(result, /^# binding = "ASSETS"$/m);
  }
  for (const line of [/^main.*\n/m, /^# \[assets\].*\n/m, /^# directory.*\n/m])
    assert.throws(() => deriveWrangler(template.replace(line, '')), /replacement did not match/);
});

for (const artifactHash of [undefined, null, '', 'sha256:bad', 'z'.repeat(64), 123])
  test(`staging rejects invalid artifact digest ${artifactHash} and removes old outputs`, async (t) => {
    const f = fixture(t);
    for (const [pkg, target] of [
      ['prebuilt', 'node'],
      ['prebuilt-cloudflare', 'cloudflare'],
    ]) {
      write(f.root, `packages/${pkg}/prebuilt.json`, {});
      write(f.root, `packages/${pkg}/${target}/old.js`, 'old');
    }
    await assert.rejects(
      stagePrebuilt({
        root: f.root,
        esbuildVersion: '0.28.2',
        validateArtifact: () => ({ artifactHash }),
      }),
      /artifactSha256/,
    );
    for (const pkg of ['prebuilt', 'prebuilt-cloudflare'])
      assert.deepEqual(listFiles(join(f.root, 'packages', pkg)), ['package.json']);
  });

test('staging clears old outputs on consistency failure', async (t) => {
  const f = fixture(t);
  write(f.root, 'packages/prebuilt/prebuilt.json', {});
  write(f.root, 'packages/prebuilt/node/old.js', 'old');
  write(f.root, '.pb/node/build-info.json', { ...f.info, dirty: true });
  await assert.rejects(stagePrebuilt({ root: f.root }), /dirty/);
  assert.deepEqual(listFiles(join(f.root, 'packages/prebuilt')), ['package.json']);
});

test('pack staging state only skips when both manifest and payload are absent', (t) => {
  const f = fixture(t);
  const dir = join(f.root, 'packages/prebuilt');
  assert.equal(stagingState(dir, 'node'), false);
  write(dir, 'prebuilt.json', {});
  assert.throws(() => stagingState(dir, 'node'), /both be staged/);
  write(dir, 'node/a.js', 'bytes');
  assert.equal(stagingState(dir, 'node'), true);
  rmSync(join(dir, 'prebuilt.json'));
  assert.throws(() => stagingState(dir, 'node'), /both be staged/);
});

async function staged(t) {
  const f = fixture(t);
  await stagePrebuilt({
    root: f.root,
    esbuildVersion: '0.28.2',
    writeCliExpected: true,
    validateArtifact: () => ({ artifactHash: 'd'.repeat(64) }),
  });
  return f;
}

test('release anchor checks packed manifest bytes, artifact and version', async (t) => {
  const f = await staged(t);
  const bytes = readFileSync(join(f.root, 'packages/prebuilt-cloudflare/prebuilt.json'));
  const anchor = JSON.parse(readFileSync(join(f.root, 'packages/cli/dist/prebuilt-expected.json')));
  assert.deepEqual(releaseAnchorProblems(JSON.stringify(anchor), bytes), []);
  for (const key of ['prebuiltJsonSha256', 'artifactSha256', 'version'])
    assert.ok(releaseAnchorProblems(JSON.stringify({ ...anchor, [key]: 'stale' }), bytes).length);
  assert.ok(
    releaseAnchorProblems(JSON.stringify(anchor), Buffer.concat([bytes, Buffer.from(' ')])).length,
  );
  assert.ok(releaseAnchorProblems(undefined, bytes).length);
});

for (const [field, value] of [
  ['package', 'wrong'],
  ['version', 'wrong'],
  ['target', 'node'],
  ['payload', 'node'],
  ['gitSha', 'bad'],
  ['lockfileSha256', 'bad'],
  ['toolchain', {}],
  ['plugins', []],
  ['plugins', { example: '' }],
  ['artifactSha256', 'bad'],
  ['files', {}],
  ['files', { 'worker.js': 'bad' }],
])
  test(`pack validates schema field ${field}: ${JSON.stringify(value)}`, async (t) => {
    const f = await staged(t);
    const dir = join(f.root, 'packages/prebuilt-cloudflare');
    const record = JSON.parse(readFileSync(join(dir, 'prebuilt.json')));
    write(dir, 'prebuilt.json', { ...record, [field]: value });
    assert.ok(prebuiltProblems(dir, listFiles(dir), 'cloudflare').length);
  });

test('fixtures live under os.tmpdir()', (t) => {
  const f = fixture(t);
  assert.equal(join(f.root, '..'), tmpdir());
});

test('validation sees only temporary payloads and a thrown error leaves both packages unstaged', async (t) => {
  const f = fixture(t);
  await assert.rejects(
    stagePrebuilt({
      root: f.root,
      esbuildVersion: '0.28.2',
      validateArtifact: () => {
        for (const [pkg, target] of [
          ['prebuilt', 'node'],
          ['prebuilt-cloudflare', 'cloudflare'],
        ])
          assert.equal(stagingState(join(f.root, 'packages', pkg), target), false);
        throw new Error('validation failed');
      },
    }),
    /validation failed/,
  );
  for (const pkg of ['prebuilt', 'prebuilt-cloudflare'])
    assert.deepEqual(listFiles(join(f.root, 'packages', pkg)), ['package.json']);
});
