import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  symlinkSync,
  chmodSync,
  appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PUBLISH_ORDER,
  releasedPaths,
  orderedPaths,
  componentFor,
  requireHeadTag,
  requireLockstep,
  distTag,
  requireRepository,
  requireCliExpected,
  existingVersion,
  publishSequence,
  requireStaged,
  main,
  publishTarballs,
  requireAnchor,
  requireResolvedSpecifiers,
  verifyArtifacts,
} from './publish-packages.mjs';

const config = JSON.parse(readFileSync(new URL('../release-please-config.json', import.meta.url)));
const missing = { status: 1, stdout: '{"error":{"code":"E404"}}' };

test('full release follows dependency order regardless of input order', () => {
  assert.deepEqual(orderedPaths(Object.keys(config.packages).reverse()), [
    'packages/core',
    'packages/db-sqlite',
    'packages/plugin-github',
    'packages/plugin-sso-oidc',
    'packages/ui',
    'packages/ui-assets',
    'packages/runtime-cloudflare',
    'packages/runtime-node',
    'packages/prebuilt',
    'packages/prebuilt-cloudflare',
    'packages/cli',
  ]);
});

test('plugin-only subset keeps independent release order', () => {
  assert.deepEqual(orderedPaths(['packages/plugin-sso-oidc', 'packages/plugin-github']), [
    'packages/plugin-github',
    'packages/plugin-sso-oidc',
  ]);
});

for (const component of [
  'plugin-github',
  'plugin-sso-oidc',
  'ui-assets',
  'dist',
  'dist-cloudflare',
])
  test(`${component} maps to its own component tag on HEAD`, () => {
    const path =
      { dist: 'prebuilt', 'dist-cloudflare': 'prebuilt-cloudflare' }[component] ?? component;
    assert.equal(componentFor(`packages/${path}`, config), component);
    requireHeadTag(componentFor(`packages/${path}`, config), '2.0.0-rc.1', [
      `${component}-v2.0.0-rc.1`,
    ]);
    assert.throws(
      () => requireHeadTag(component, '2.0.0-rc.1', ['core-v2.0.0-rc.1']),
      /not on HEAD/,
    );
  });

test('tag elsewhere or for another version cannot authorize HEAD', () => {
  assert.throws(() => requireHeadTag('core', '2.0.0', []), /not on HEAD/);
  assert.throws(() => requireHeadTag('core', '2.0.0', ['core-v2.0.1']), /not on HEAD/);
});

test('CLI requires both prebuilt packages; independent releases do not', () => {
  for (const paths of [
    ['packages/cli'],
    ['packages/cli', 'packages/prebuilt'],
    ['packages/cli', 'packages/prebuilt-cloudflare'],
  ])
    assert.throws(() => requireLockstep(paths), /both prebuilt/);
  requireLockstep(PUBLISH_ORDER);
  requireLockstep(['packages/plugin-github']);
});

test('dist tags protect latest from every prerelease', () => {
  assert.equal(distTag('2.0.0-rc.1'), 'rc');
  assert.equal(distTag('2.0.0-beta.1'), 'rc');
  assert.equal(distTag('2.0.0'), 'latest');
});

test('release paths reject malformed, empty, duplicate and unconfigured input', () => {
  for (const input of [
    'no',
    '{}',
    '[]',
    '[null]',
    '["packages/unknown"]',
    '["packages/core","packages/core"]',
  ])
    assert.throws(() => releasedPaths(input, config));
  assert.deepEqual(releasedPaths('["packages/core"]', config), ['packages/core']);
  assert.throws(() => componentFor('packages/unknown', config), /no configured component/);
});

test('packed repository requires the exact source repository and directory', () => {
  for (const repository of [
    undefined,
    {},
    { url: 'wrong', directory: 'packages/core' },
    { url: 'git+https://github.com/package-broker/broker.git', directory: 'packages/cli' },
  ])
    assert.throws(() => requireRepository({ repository }, 'packages/core'), /repository/);
  requireRepository(
    {
      repository: {
        url: 'git+https://github.com/package-broker/broker.git',
        directory: 'packages/core',
      },
    },
    'packages/core',
  );
});

test('CLI expected record must exist and match the CLI version', () => {
  for (const record of [undefined, null, {}, { version: '2.0.0-rc.0' }])
    assert.throws(() => requireCliExpected(record, '2.0.0-rc.1'), /expected record/);
  requireCliExpected({ version: '2.0.0-rc.1' }, '2.0.0-rc.1');
});

test('only exact existing version skips; only E404 permits publishing', () => {
  assert.equal(existingVersion({ status: 0, stdout: '"2.0.0"' }, '2.0.0'), true);
  assert.equal(existingVersion(missing, '2.0.0'), false);
  for (const result of [
    { status: 0, stdout: '"2.0.1"' },
    { status: 0, stdout: 'invalid' },
    { status: 1, stdout: '{"error":{"code":"E403"}}' },
    { status: null, stdout: '' },
    { status: 1, stdout: 'E404 in unstructured output' },
  ])
    assert.throws(() => existingVersion(result, '2.0.0'));
});

function sequence(overrides = {}) {
  const events = [];
  const packages = ['a', 'b', 'c'].map((name) => ({ name, version: '2.0.0-rc.1' }));
  const actions = {
    pack(pkg) {
      events.push(`pack ${pkg.name}`);
      return `${pkg.name}.tgz`;
    },
    view(pkg) {
      events.push(`view ${pkg.name}`);
      return missing;
    },
    publish(pkg, tarball, tag) {
      events.push(`publish ${pkg.name} ${tarball} ${tag}`);
    },
    log(line) {
      events.push(line);
    },
    ...overrides,
  };
  return { events, packages, actions };
}

test('existing versions skip packing and validation; remaining versions publish in order with rc', async () => {
  const f = sequence({
    view: (pkg) => (pkg.name === 'a' ? { status: 0, stdout: '"2.0.0-rc.1"' } : missing),
  });
  await publishSequence(f.packages, f.actions);
  assert.deepEqual(f.events, [
    'a: skipped existing',
    'pack b',
    'publish b b.tgz rc',
    'b: published',
    'pack c',
    'publish c c.tgz rc',
    'c: published',
  ]);
});

for (const phase of ['pack', 'view', 'publish'])
  test(`first ${phase} failure stops before touching later packages`, async () => {
    const f = sequence();
    const original = f.actions[phase];
    f.actions[phase] = (pkg, ...args) => {
      if (pkg.name === 'b') throw new Error('specific command failure');
      return original(pkg, ...args);
    };
    await assert.rejects(publishSequence(f.packages, f.actions), /specific command failure/);
    assert.equal(f.events.at(-1), 'b: failed');
    assert.ok(!f.events.some((line) => line.includes(' c') || line.startsWith('c:')));
    assert.ok(!f.events.some((line) => line.includes('credential')));
  });

test('publisher refuses empty prebuilt shells, partial staging and missing payload entries', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-publish-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(requireStaged(dir, 'node'), /must be staged/);
  writeFileSync(join(dir, 'prebuilt.json'), '{}');
  await assert.rejects(requireStaged(dir, 'node'), /both be staged/);
  mkdirSync(join(dir, 'node'));
  writeFileSync(join(dir, 'package.json'), '{}');
  await assert.rejects(requireStaged(dir, 'node'), /Invalid staged/);
});

test('tag check injection is impossible for real publish', async () => {
  await assert.rejects(main(['--tags-file', 'tags.json']), /requires --dry-run/);
  await assert.rejects(main(['--tags-file', '--dry-run']), /Missing publish argument/);
  await assert.rejects(main(['--unknown']), /Unknown publish argument/);
});

test('staged payload validation ignores workspace links and detects tampering or missing entry', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-publish-staged-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'node'));
  mkdirSync(join(dir, 'node_modules'));
  symlinkSync(dir, join(dir, 'node_modules', 'workspace'));
  const pkg = { name: '@package-broker/dist', version: '2.0.0' };
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  writeFileSync(join(dir, 'node/server.js'), 'bundle');
  const digest = `sha256:${createHash('sha256').update('bundle').digest('hex')}`;
  const record = {
    schemaVersion: 1,
    package: pkg.name,
    version: pkg.version,
    target: 'node',
    payload: 'node',
    gitSha: 'a'.repeat(40),
    lockfileSha256: 'b'.repeat(64),
    toolchain: { node: 'v24.22.0', esbuild: '0.28.2', os: 'linux', arch: 'x64' },
    plugins: {},
    artifactSha256: null,
    files: { 'server.js': digest },
  };
  writeFileSync(join(dir, 'prebuilt.json'), JSON.stringify(record));
  await requireStaged(dir, 'node');
  writeFileSync(join(dir, 'node/server.js'), 'tampered');
  await assert.rejects(requireStaged(dir, 'node'), /Invalid staged/);
  rmSync(join(dir, 'node/server.js'));
  writeFileSync(join(dir, 'node/other.js'), 'bundle');
  record.files = { 'other.js': digest };
  writeFileSync(join(dir, 'prebuilt.json'), JSON.stringify(record));
  await assert.rejects(requireStaged(dir, 'node'), /entry is missing/);
});

test('dry runs report dry-run after npm completes', async () => {
  const f = sequence();
  await publishSequence(f.packages, { ...f.actions, dryRun: true });
  assert.ok(f.events.includes('a: dry-run'));
  assert.ok(!f.events.some((line) => line.includes(': published')));
});

for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'])
  test(`packed ${field} reject workspace, catalog, link and file specifiers`, () => {
    for (const version of [
      'workspace:^',
      'catalog:',
      'catalog:default',
      'link:../core',
      'file:../core',
    ])
      assert.throws(
        () => requireResolvedSpecifiers({ [field]: { example: version } }),
        /unresolved/,
      );
    requireResolvedSpecifiers({ [field]: { example: '^2.0.0' } });
  });

test('dist-cloudflare skipped, cli anchor compared against the registry manifest', async () => {
  const registry = Buffer.from(
    JSON.stringify({
      package: '@package-broker/dist-cloudflare',
      version: '2.0.0',
      artifactSha256: 'registry-artifact',
    }) + '\n',
  );
  const anchor = JSON.stringify({
    schemaVersion: 1,
    ...JSON.parse(registry),
    prebuiltJsonSha256: createHash('sha256').update(registry).digest('hex'),
  });
  const cloudflare = {
    path: 'packages/prebuilt-cloudflare',
    name: '@package-broker/dist-cloudflare',
    version: '2.0.0',
    prebuiltJson: Buffer.from('different local build').toString('base64'),
  };
  const cli = {
    path: 'packages/cli',
    name: '@package-broker/cli',
    version: '2.0.0',
    tarball: 'cli.tgz',
  };
  for (const mismatch of [false, true]) {
    const events = [];
    const result = publishTarballs([cloudflare, cli], {
      view: (pkg) => (pkg === cloudflare ? { status: 0, stdout: '"2.0.0"' } : missing),
      registryPrebuilt(pkg) {
        assert.equal(pkg, cloudflare);
        events.push('registry pack');
        return mismatch ? Buffer.from('{}') : registry;
      },
      validate(pkg, prebuilt) {
        assert.equal(pkg, cli);
        requireAnchor(anchor, prebuilt());
      },
      publish(pkg) {
        events.push(`published ${pkg.name}`);
      },
      log(line) {
        events.push(line);
      },
    });
    if (mismatch) await assert.rejects(result, /CLI anchor/);
    else await result;
    assert.ok(events.includes('registry pack'));
    assert.equal(events.includes('published @package-broker/cli'), !mismatch);
    assert.ok(events.includes('@package-broker/dist-cloudflare: skipped existing'));
  }
});

test('an already published CLI does not fetch or validate either anchor', async () => {
  const packages = ['prebuilt-cloudflare', 'cli'].map((name) => ({
    path: `packages/${name}`,
    name,
    version: '2.0.0',
  }));
  const unexpected = () => assert.fail('existing package should not be touched');
  await publishTarballs(packages, {
    view: () => ({ status: 0, stdout: '"2.0.0"' }),
    registryPrebuilt: unexpected,
    validate: unexpected,
    publish: unexpected,
    log() {},
  });
});

test('artifact checksums and dist-tags are verified before publishing', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-artifacts-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'core.tgz'), 'original tarball');
  const entry = {
    tarball: 'core.tgz',
    version: '2.0.0-rc.1',
    tag: 'rc',
    sha256: createHash('sha256').update('original tarball').digest('hex'),
  };
  verifyArtifacts(dir, [entry]);
  assert.throws(() => verifyArtifacts(dir, [{ ...entry, tag: 'latest' }]), /dist-tag/);
  assert.throws(
    () => verifyArtifacts(dir, [{ ...entry, tarball: '../core.tgz' }]),
    /Invalid tarball/,
  );
  writeFileSync(join(dir, 'core.tgz'), 'tampered');
  assert.throws(() => verifyArtifacts(dir, [entry]), /sha256/);
});

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function isolatedPublisher(t, { packages = ['core'], version = '2.0.0-rc.1', build = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pb-publish-isolated-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, bytes) => {
    const target = join(root, path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, bytes);
  };
  const json = (path, value) => write(path, JSON.stringify(value));
  write(
    'scripts/publish-packages.mjs',
    readFileSync(new URL('./publish-packages.mjs', import.meta.url)),
  );
  // Only pack-only needs the build validators; publishing has the script alone and no dependencies.
  if (build)
    for (const helper of ['check-pack.mjs', 'stage-prebuilt.mjs'])
      symlinkSync(fileURLToPath(new URL(helper, import.meta.url)), join(root, 'scripts', helper));
  json('release-please-config.json', config);
  const prebuilt =
    JSON.stringify({
      schemaVersion: 1,
      package: '@package-broker/dist-cloudflare',
      version,
      target: 'cloudflare',
      payload: 'cloudflare',
      gitSha: 'a'.repeat(40),
      lockfileSha256: 'b'.repeat(64),
      toolchain: { node: 'v24.22.0', esbuild: '0.28.2', os: 'linux', arch: 'x64' },
      plugins: {},
      artifactSha256: 'c'.repeat(64),
      files: { 'worker.js': `sha256:${digest('worker')}` },
    }) + '\n';
  const anchor = {
    schemaVersion: 1,
    package: JSON.parse(prebuilt).package,
    version,
    artifactSha256: JSON.parse(prebuilt).artifactSha256,
    prebuiltJsonSha256: digest(prebuilt),
  };
  const entries = packages.map((id) => {
    const path = `packages/${id}`;
    const name = `@package-broker/${{ prebuilt: 'dist', 'prebuilt-cloudflare': 'dist-cloudflare' }[id] ?? id}`;
    json(`${path}/package.json`, {
      name,
      version,
      repository: { url: 'git+https://github.com/package-broker/broker.git', directory: path },
    });
    if (id === 'prebuilt-cloudflare') {
      write(`${path}/prebuilt.json`, prebuilt);
      write(`${path}/cloudflare/worker.js`, 'worker');
    }
    if (id === 'cli') json(`${path}/dist/prebuilt-expected.json`, anchor);
    return {
      path,
      name,
      version,
      tag: 'rc',
      tarball: `${id}.tgz`,
      ...(id === 'prebuilt-cloudflare'
        ? { prebuiltJson: Buffer.from(prebuilt).toString('base64') }
        : {}),
    };
  });
  mkdirSync(join(root, 'artifacts'));
  const realTar = execFileSync('which', ['tar'], { encoding: 'utf8' }).trim();
  function archive(dir, tarball) {
    // A symlink keeps the fixture source and packed content easy to change independently.
    const stage = mkdtempSync(join(root, 'archive-'));
    symlinkSync(dir, join(stage, 'package'));
    try {
      execFileSync(realTar, ['-chzf', tarball, '-C', stage, 'package']);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }
  function repack(entry) {
    const tarball = join(root, 'artifacts', entry.tarball);
    archive(join(root, entry.path), tarball);
    entry.sha256 = digest(readFileSync(tarball));
  }
  for (const entry of entries) repack(entry);
  const state = { npmVersion: '11.5.1', existing: [], publishExit: 0 };
  const manifest = { packages: entries };
  function save() {
    json('artifacts/manifest.json', manifest);
    json('state.json', state);
  }
  save();
  function fake(program, source) {
    write(
      `bin/${program}`,
      `#!${process.execPath}
      const fs = require('node:fs');
      const path = require('node:path');
      const { execFileSync } = require('node:child_process');
      const root = process.env.PUBLISH_TEST_ROOT;
      const args = process.argv.slice(2);
      fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify({ program: ${JSON.stringify(program)}, args, cwd: process.cwd() }) + '\\n');
      const state = JSON.parse(fs.readFileSync(path.join(root, 'state.json')));
      ${source}
    `,
    );
    chmodSync(join(root, 'bin', program), 0o755);
  }
  fake(
    'npm',
    `
    if (args[0] === '--version') {
      console.log(state.npmVersion);
    } else if (args[0] === 'view') {
      if (!args.includes('--loglevel=silent')) console.log('npm notice fixture noise');
      const spec = args[1];
      const split = spec.lastIndexOf('@');
      if (state.existing.includes(spec.slice(0, split))) console.log(JSON.stringify(spec.slice(split + 1)));
      else { console.log(JSON.stringify({ error: { code: 'E404' } })); process.exitCode = 1; }
    } else if (args[0] === 'pack') {
      const dir = args[args.indexOf('--pack-destination') + 1];
      fs.copyFileSync(path.join(root, 'registry.tgz'), path.join(dir, 'registry.tgz'));
    } else if (args[0] === 'publish') {
      console.log('npm stdout diagnostic');
      console.error('npm stderr diagnostic');
      process.exitCode = state.publishExit;
    } else process.exitCode = 90;
  `,
  );
  fake(
    'tar',
    `
    execFileSync(${JSON.stringify(realTar)}, args, { stdio: 'inherit' });
  `,
  );
  if (build) {
    fake(
      'pnpm',
      `
      const stage = fs.mkdtempSync(path.join(root, 'pack-'));
      try {
        fs.cpSync(process.cwd(), path.join(stage, 'package'), { recursive: true });
        const dir = args[args.indexOf('--pack-destination') + 1];
        execFileSync(${JSON.stringify(realTar)}, ['-czf', path.join(dir, path.basename(process.cwd()) + '.tgz'), '-C', stage, 'package']);
      } finally { fs.rmSync(stage, { recursive: true, force: true }); }
    `,
    );
    json(
      'tags.json',
      entries.map((entry) => `${componentFor(entry.path, config)}-v${entry.version}`),
    );
  }
  function run(args = ['--from-tarballs', join(root, 'artifacts')]) {
    save();
    write('calls.jsonl', '');
    const result = spawnSync(
      process.execPath,
      [join(root, 'scripts/publish-packages.mjs'), ...args],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${join(root, 'bin')}:${process.env.PATH}`,
          PUBLISH_TEST_ROOT: root,
          PATHS_RELEASED: JSON.stringify(entries.map((entry) => entry.path)),
        },
      },
    );
    const calls = readFileSync(join(root, 'calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return { ...result, calls };
  }
  function registry(bytes) {
    json('registry/package.json', { name: '@package-broker/dist-cloudflare', version });
    write('registry/prebuilt.json', bytes);
    archive(join(root, 'registry'), join(root, 'registry.tgz'));
  }
  return { root, entries, state, manifest, run, write, json, repack, registry, prebuilt };
}

const npmCalls = (result, verb) =>
  result.calls.filter((call) => call.program === 'npm' && call.args[0] === verb);
function refused(result, message) {
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, message);
  assert.deepEqual(npmCalls(result, 'publish'), []);
}

test('isolated tarball publisher forwards diagnostics and uses safe npm flags', (t) => {
  const f = isolatedPublisher(t);
  const success = f.run();
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, /npm stdout diagnostic/);
  assert.match(success.stderr, /npm stderr diagnostic/);
  assert.match(success.stdout, /@package-broker\/core: published/);
  assert.deepEqual(npmCalls(success, 'view')[0].args, [
    'view',
    '@package-broker/core@2.0.0-rc.1',
    'version',
    '--json',
    '--loglevel=silent',
  ]);
  assert.deepEqual(npmCalls(success, 'publish')[0].args, [
    'publish',
    join(f.root, 'artifacts/core.tgz'),
    '--ignore-scripts',
    '--access',
    'public',
    '--provenance',
    '--tag',
    'rc',
  ]);
  f.state.publishExit = 42;
  const failure = f.run();
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /npm stderr diagnostic/);
  assert.match(failure.stderr, /npm publish failed \(exit 42\)/);
  assert.match(failure.stdout, /@package-broker\/core: failed/);
  assert.doesNotMatch(failure.stdout, /: published/);
});

test('isolated tarball publisher rejects real publication of rehearsal artifacts', (t) => {
  const f = isolatedPublisher(t);
  f.manifest.dryRun = true;
  refused(f.run(), /Rehearsal artifacts require --dry-run/);
  const rehearsal = f.run(['--dry-run', '--from-tarballs', join(f.root, 'artifacts')]);
  assert.equal(rehearsal.status, 0, rehearsal.stderr);
  assert.match(rehearsal.stdout, /@package-broker\/core: dry-run/);
  assert.ok(npmCalls(rehearsal, 'publish')[0].args.includes('--dry-run'));
});

test('isolated publisher refuses an appended tarball byte before npm publish', (t) => {
  const f = isolatedPublisher(t);
  appendFileSync(join(f.root, 'artifacts/core.tgz'), 'x');
  refused(f.run(), /sha256/);
});

test('isolated publisher refuses manifest prebuiltJson differing from packed bytes', (t) => {
  const f = isolatedPublisher(t, { packages: ['prebuilt-cloudflare'] });
  f.entries[0].prebuiltJson = Buffer.from('{}').toString('base64');
  refused(f.run(), /Manifest prebuilt bytes do not match tarball/);
});

for (const field of ['name', 'version'])
  test(`isolated publisher refuses manifest ${field} differing from checkout`, (t) => {
    const f = isolatedPublisher(t);
    // Keep tarball and manifest consistent so only the checkout identity check can refuse this.
    const entry = f.entries[0];
    entry[field] = field === 'name' ? '@package-broker/other' : '2.0.0-rc.2';
    const source = JSON.parse(readFileSync(join(f.root, entry.path, 'package.json')));
    f.json(`${entry.path}/package.json`, { ...source, [field]: entry[field] });
    f.repack(entry);
    f.json(`${entry.path}/package.json`, source);
    refused(f.run(), /Manifest identity does not match release/);
  });

for (const specifier of ['workspace:^', 'catalog:default', 'link:../core', 'file:../core'])
  test(`isolated publisher refuses packed dependency ${specifier}`, (t) => {
    const f = isolatedPublisher(t);
    const entry = f.entries[0];
    const source = JSON.parse(readFileSync(join(f.root, entry.path, 'package.json')));
    f.json(`${entry.path}/package.json`, { ...source, dependencies: { example: specifier } });
    f.repack(entry);
    refused(f.run(), /unresolved/);
  });

for (const packages of [['cli'], ['cli', 'prebuilt'], ['cli', 'prebuilt-cloudflare']])
  test(`isolated publisher refuses CLI without both prebuilts: ${packages.join(', ')}`, (t) => {
    const f = isolatedPublisher(t, { packages });
    refused(f.run(), /CLI release requires both prebuilt packages/);
  });

for (const mismatch of [false, true])
  test(`isolated publisher compares CLI anchor with registry prebuilt.json: ${mismatch ? 'mismatch' : 'match'}`, (t) => {
    const f = isolatedPublisher(t, { packages: ['prebuilt', 'prebuilt-cloudflare', 'cli'] });
    f.state.existing = ['@package-broker/dist', '@package-broker/dist-cloudflare'];
    // The local build deliberately differs: only the registry bytes can authorize this CLI.
    f.entries.find((entry) => entry.path === 'packages/prebuilt-cloudflare').prebuiltJson =
      Buffer.from('{}').toString('base64');
    f.registry(
      mismatch
        ? JSON.stringify({ ...JSON.parse(f.prebuilt), artifactSha256: 'd'.repeat(64) })
        : f.prebuilt,
    );
    const result = f.run();
    assert.equal(npmCalls(result, '--version').length, 1);
    if (mismatch) refused(result, /CLI anchor does not match/);
    else {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /@package-broker\/cli: published/);
      assert.equal(npmCalls(result, 'publish').length, 1);
      assert.equal(npmCalls(result, 'publish')[0].args[1], join(f.root, 'artifacts/cli.tgz'));
    }
    assert.match(result.stdout, /@package-broker\/dist-cloudflare: skipped existing/);
    const packs = npmCalls(result, 'pack');
    assert.equal(packs.length, 1);
    assert.deepEqual(packs[0].args.slice(0, 4), [
      'pack',
      '@package-broker/dist-cloudflare@2.0.0-rc.1',
      '--ignore-scripts',
      '--pack-destination',
    ]);
    assert.ok(
      result.calls.some(
        (call) =>
          call.program === 'tar' &&
          call.args[2] === 'package/prebuilt.json' &&
          call.args[1].endsWith('registry.tgz'),
      ),
    );
  });

for (const version of ['10.9.3', '11.5.0', 'invalid', '11.5.1', '11.17.0', '12.0.0'])
  test(`isolated publisher checks npm ${version} once before publishing`, (t) => {
    const f = isolatedPublisher(t);
    f.state.npmVersion = version;
    const result = f.run();
    assert.deepEqual(
      npmCalls(result, '--version').map((call) => call.args),
      [['--version']],
    );
    if (['10.9.3', '11.5.0', 'invalid'].includes(version)) {
      refused(result, /npm >= 11.5.1 is required/);
      assert.deepEqual(npmCalls(result, 'view'), []);
    } else assert.equal(result.status, 0, result.stderr);
  });

test('isolated dry-run publishing enforces the npm minimum too', (t) => {
  const f = isolatedPublisher(t);
  f.state.npmVersion = '11.5.0';
  refused(
    f.run(['--dry-run', '--from-tarballs', join(f.root, 'artifacts')]),
    /npm >= 11.5.1 is required/,
  );
});

test('isolated publisher requires an explicit artifact mode, including dry-run', (t) => {
  const f = isolatedPublisher(t);
  for (const args of [[], ['--dry-run']]) {
    const result = f.run(args);
    refused(result, /Publishing requires --from-tarballs/);
    assert.deepEqual(result.calls, []);
  }
});

test('pack-only writes the complete prerelease manifest and publishing consumes it', (t) => {
  const f = isolatedPublisher(t, { packages: ['core', 'prebuilt-cloudflare'], build: true });
  const destination = join(f.root, 'output');
  const packed = f.run([
    '--pack-only',
    destination,
    '--dry-run',
    '--tags-file',
    join(f.root, 'tags.json'),
  ]);
  assert.equal(packed.status, 0, packed.stderr);
  assert.deepEqual(npmCalls(packed, 'publish'), []);
  assert.deepEqual(npmCalls(packed, '--version'), []);
  const manifest = JSON.parse(readFileSync(join(destination, 'manifest.json')));
  assert.deepEqual(Object.keys(manifest).sort(), ['dryRun', 'packages']);
  assert.equal(manifest.dryRun, true);
  assert.equal(manifest.packages.length, 2);
  for (const [index, entry] of manifest.packages.entries()) {
    const expected = f.entries[index];
    assert.deepEqual(Object.keys(entry).sort(), Object.keys(expected).sort());
    assert.equal(entry.path, expected.path);
    assert.equal(entry.name, expected.name);
    assert.equal(entry.version, expected.version);
    assert.equal(entry.tag, 'rc');
    assert.equal(entry.tarball, expected.tarball);
    assert.equal(entry.sha256, digest(readFileSync(join(destination, entry.tarball))));
    if (entry.path === 'packages/prebuilt-cloudflare')
      assert.equal(Buffer.from(entry.prebuiltJson, 'base64').toString(), f.prebuilt);
    else assert.ok(!Object.hasOwn(entry, 'prebuiltJson'));
  }
  const published = f.run(['--from-tarballs', destination, '--dry-run']);
  assert.equal(published.status, 0, published.stderr);
  assert.equal(npmCalls(published, 'publish').length, 2);
});
