import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PACKAGES = [
  'cli',
  'core',
  'db-sqlite',
  'runtime-cloudflare',
  'runtime-node',
  'ui-assets',
  'ui',
];
const UI = '@package-broker/ui';
const BRIDGE = '@package-broker/ui-assets';
const TARGETS = ['cloudflare', 'node'];
const MASTER_KEY = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const UI_CODE =
  /(?:@package-broker\/(?:ui-assets|ui)(?:\/|["'\s]|$)|packages\/(?:ui-assets|ui)\/|(?:^|\/)(?:react|react-dom|scheduler|clsx|class-variance-authority|tailwind-merge|esbuild|typescript)(?:\/|@)|tailwindcss|openapi-typescript|createUiAssetsProvider|MANIFEST_SPECIFIER)/;
const UI_EMITTED_CODE =
  /(?:packages|@package-broker)\/(?:ui-assets|ui)\/(?:src|dist)\/|createUiAssetsProvider|MANIFEST_SPECIFIER|react-dom|tailwindcss|openapi-typescript/;
const RESOLVER = /(?:createRequire|import\.meta\.resolve|require\.resolve|node:module)/;
const mutation = process.argv.find((arg) => arg.startsWith('--mutation='))?.split('=')[1];
assert.ok(mutation === undefined || ['packed-ui', 'staging', 'manifest-value'].includes(mutation));
const env = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' };
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'pb-ui-install-')));
assert.ok(!inside(ROOT, scratch), 'consumer must be outside the repository');
const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

class Unverified extends Error {}

function inside(root, file) {
  const path = relative(root, file);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function install(dir, dependencies, overrides, store) {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({
      ...(await json(join(dir, 'package.json')).catch(() => ({}))),
      private: true,
      type: 'module',
      dependencies,
    }),
  );
  await writeFile(
    join(dir, 'pnpm-workspace.yaml'),
    `nodeLinker: isolated\nhoist: false\nautoInstallPeers: false\nlinkWorkspacePackages: false\nverifyStoreIntegrity: true\noverrides: ${JSON.stringify(overrides)}\n`,
  );
  try {
    run('pnpm', ['install', '--offline', '--ignore-scripts', '--store-dir', store], dir);
  } catch (error) {
    if (
      /ERR_PNPM_(?:NO_OFFLINE|OFFLINE|META_FETCH|FETCH)|ENOENT.*store/.test(
        `${error.stdout}\n${error.stderr}`,
      )
    )
      throw new Unverified('offline package metadata or tarballs are missing from the pnpm store');
    throw error;
  }
}

async function packageGraph(rootManifest, boundary) {
  const seen = new Map();
  async function visit(manifest) {
    const real = await realpath(manifest);
    assert.ok(inside(boundary, real), 'installed dependency escapes the isolated consumer');
    if (seen.has(real)) return;
    const pkg = await json(real);
    seen.set(real, pkg);
    const require = createRequire(real);
    const dependencies = {
      ...pkg.dependencies,
      ...pkg.optionalDependencies,
      ...pkg.peerDependencies,
    };
    for (const name of Object.keys(dependencies)) {
      let entry;
      try {
        entry = require.resolve(`${name}/package.json`);
      } catch (error) {
        // Some external packages do not export package.json.
        try {
          let dir = dirname(require.resolve(name));
          while ((await json(join(dir, 'package.json')).catch(() => ({}))).name !== name) {
            assert.notEqual(dirname(dir), dir, `cannot locate installed ${name}`);
            dir = dirname(dir);
          }
          entry = join(dir, 'package.json');
        } catch {
          if (pkg.optionalDependencies?.[name] || pkg.peerDependenciesMeta?.[name]?.optional)
            continue;
          throw error;
        }
      }
      await visit(entry);
    }
  }
  await visit(rootManifest);
  return [...seen.values()];
}

async function expectAssets(directory, expected) {
  assert.deepEqual((await readdir(directory)).sort(), [...expected.keys()].sort());
  for (const [name, bytes] of expected)
    assert.deepEqual(await readFile(join(directory, name)), bytes, `asset bytes differ: ${name}`);
}

function expectServedAsset(name, bytes, expected) {
  if (name === 'manifest.json') {
    assert.deepEqual(
      JSON.parse(bytes.toString('utf8')),
      JSON.parse(expected.toString('utf8')),
      'served manifest value: manifest.json',
    );
  } else {
    assert.deepEqual(bytes, expected, `served bytes: ${name}`);
  }
}

async function isolation(out, target, buildRoot) {
  const meta = await json(join(out, 'metafile.json'));
  for (const path of [ROOT.replace(/\/$/, ''), scratch, buildRoot])
    assert.ok(!JSON.stringify(meta).includes(path), 'build-machine path in runtime metafile');
  for (const input of Object.keys(meta.inputs))
    assert.ok(!UI_CODE.test(input), `UI input: ${input}`);
  for (const [name, output] of Object.entries(meta.outputs)) {
    for (const item of output.imports ?? []) {
      assert.ok(
        !UI_CODE.test(item.path) && !RESOLVER.test(item.path),
        'build-time external import',
      );
      if (item.external) {
        const allowed =
          target === 'cloudflare'
            ? /^(?:cloudflare:|node:(?:async_hooks|buffer|zlib)$)/.test(item.path)
            : /^(?:node:|better-sqlite3$)/.test(item.path);
        assert.ok(allowed, `unexpected runtime external: ${item.path}`);
      }
    }
    if (!name.endsWith('.js')) continue;
    const code = await readFile(resolve(buildRoot, name), 'utf8');
    assert.ok(!UI_EMITTED_CODE.test(code), 'UI/provider code in emitted JavaScript');
    assert.ok(!RESOLVER.test(code), 'runtime resolver in emitted JavaScript');
    for (const path of [ROOT.replace(/\/$/, ''), scratch, buildRoot])
      assert.ok(!code.includes(path), 'build-machine path in emitted JavaScript');
  }
}

async function seed(execute, orgId) {
  const secret = randomBytes(32).toString('base64url');
  const now = new Date().toISOString();
  await execute('INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)', [
    'install-user',
    orgId,
    'install@example.test',
  ]);
  await execute(
    'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [
      'install-session',
      orgId,
      'install-user',
      hash(secret),
      hash('csrf'),
      now,
      new Date(Date.now() + 3600_000).toISOString(),
    ],
  );
  return `__Host-pb_session=${secret}`;
}

async function delivery(dispatch, cookie, manifest, expected) {
  for (const [name, bytes] of expected) {
    const path = `/_pb/ui/${name === manifest.entry ? '' : name}`;
    const anonymous = await dispatch(path);
    assert.equal(anonymous.status, 200, `anonymous delivery: ${name}`);
    assert.equal(anonymous.headers.get('set-cookie'), null);
    expectServedAsset(name, Buffer.from(await anonymous.arrayBuffer()), bytes);
    const response = await dispatch(path, cookie);
    assert.equal(response.status, 200, `authenticated delivery: ${name}`);
    assert.equal(response.headers.get('set-cookie'), null);
    expectServedAsset(name, Buffer.from(await response.arrayBuffer()), bytes);
    assert.equal((await dispatch(`/${name}`, cookie)).status, 404, 'raw asset bypass');
  }
  const invalidSession = await dispatch('/_pb/ui/', '__Host-pb_session=invalid');
  assert.equal(invalidSession.status, 200);
  assert.equal(invalidSession.headers.get('set-cookie'), null);
  assert.equal((await dispatch('/_pb/ui/manifest.json')).status, 404);
}

async function nodeDelivery(out, expected, manifest) {
  const port = await new Promise((done, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  const database = join(out, 'broker.sqlite');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: out,
    env: {
      ...env,
      PORT: String(port),
      PB_SQLITE_PATH: database,
      PB_MASTER_KEY: MASTER_KEY,
      PB_PUBLIC_URL: origin,
      PB_ORG_SLUG: 'install',
      PB_ORG_NAME: 'Installation',
    },
    stdio: 'ignore',
  });
  const exit = once(child, 'exit');
  try {
    const deadline = Date.now() + 20_000;
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error('relocated Node server exited before readiness');
      if (
        await fetch(`${origin}/health/live`, { signal: AbortSignal.timeout(2000) }).then(
          (response) => response.ok,
          () => false,
        )
      )
        break;
      assert.ok(Date.now() < deadline, 'relocated Node readiness timeout');
      await new Promise((done) => setTimeout(done, 100));
    }
    const db = new DatabaseSync(database);
    let cookie;
    try {
      const org = db.prepare('SELECT id FROM organization WHERE slug = ?').get('install');
      cookie = await seed((sql, params) => db.prepare(sql).run(...params), org.id);
    } finally {
      db.close();
    }
    await delivery(
      (path, cookie) =>
        fetch(`${origin}${path}`, {
          headers: cookie ? { cookie } : {},
          signal: AbortSignal.timeout(5000),
        }),
      cookie,
      manifest,
      expected,
    );
  } finally {
    child.kill('SIGTERM');
    try {
      await bounded(exit, 10_000);
    } catch {
      child.kill('SIGKILL');
      await exit;
    }
  }
}

async function bounded(promise, ms = 20_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('installed-consumer operation timed out')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function workerDelivery(out, expected, manifest, toolsRequire, statements) {
  const { Miniflare, convertV4MiniflareOptions } = toolsRequire('miniflare');
  const { descriptor } = await json(join(out, 'assets.json'));
  assert.deepEqual(descriptor, {
    directory: './assets',
    binding: 'ASSETS',
    run_worker_first: true,
    html_handling: 'none',
    not_found_handling: 'none',
  });
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      rootPath: out,
      modules: true,
      scriptPath: 'worker.js',
      compatibilityDate: '2026-10-01',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
      bindings: { PB_MASTER_KEY: MASTER_KEY, PB_PUBLIC_URL: 'https://broker.test' },
      assets: {
        directory: resolve(out, descriptor.directory),
        binding: descriptor.binding,
        run_worker_first: descriptor.run_worker_first,
        routerConfig: { has_user_worker: true },
        assetConfig: {
          html_handling: descriptor.html_handling,
          not_found_handling: descriptor.not_found_handling,
        },
      },
    }),
  );
  try {
    const db = await bounded(mf.getD1Database('DB'));
    await bounded(db.batch(statements.map((sql) => db.prepare(sql))));
    await db
      .prepare('INSERT INTO organization (id, slug, name) VALUES (?, ?, ?)')
      .bind('install-org', 'install', 'Installation')
      .run();
    const cookie = await seed(
      (sql, params) =>
        db
          .prepare(sql)
          .bind(...params)
          .run(),
      'install-org',
    );
    await delivery(
      (path, cookie) =>
        bounded(
          mf.dispatchFetch(`https://broker.test${path}`, {
            headers: cookie ? { cookie } : {},
          }),
        ),
      cookie,
      manifest,
      expected,
    );
  } finally {
    await bounded(mf.dispose(), 5000);
  }
}

try {
  const store = process.env.PB_UI_ASSETS_STORE_DIR ?? run('pnpm', ['store', 'path'], ROOT).trim();
  const tarDir = join(scratch, 'tarballs');
  await mkdir(tarDir);
  const packed = {};
  for (const name of PACKAGES) {
    const dir = join(tarDir, name);
    await mkdir(dir);
    run('pnpm', ['pack', '--pack-destination', dir], join(ROOT, 'packages', name));
    const tarballs = (await readdir(dir)).filter((file) => file.endsWith('.tgz'));
    assert.equal(tarballs.length, 1);
    packed[`@package-broker/${name}`] = `file:${join(dir, tarballs[0])}`;
  }
  const extract = join(scratch, 'packed-ui');
  await mkdir(extract);
  run('tar', ['-xzf', packed[UI].slice(5), '-C', extract], scratch);
  const payload = join(extract, 'package', 'dist', 'assets');
  const manifest = await json(join(payload, 'manifest.json'));
  const expected = new Map();
  for (const name of ['manifest.json', ...Object.keys(manifest.files)]) {
    assert.match(name, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    const bytes = await readFile(join(payload, name));
    if (name !== 'manifest.json') assert.equal(bytes.length, manifest.files[name].bytes);
    expected.set(name, bytes);
  }
  const document = expected.get(manifest.entry).toString('utf8');
  const references = [...document.matchAll(/(?:src|href)="([^"#]+)"/g)].map((match) => match[1]);
  assert.ok(references.length > 0);
  for (const name of references)
    assert.ok(expected.has(name), 'document references an unpacked asset');

  const packedManifest = expected.get('manifest.json');
  expectServedAsset('manifest.json', Buffer.from(JSON.stringify(manifest)), packedManifest);
  const changedManifest = structuredClone(manifest);
  const entryFile = changedManifest.files[manifest.entry];
  entryFile.bytes += entryFile.bytes % 10 === 9 ? -1 : 1;
  const corruptManifest = Buffer.from(
    JSON.stringify(changedManifest).padEnd(packedManifest.length, ' '),
  );
  assert.equal(corruptManifest.length, packedManifest.length);
  await assert.rejects(
    expectAssets(payload, new Map(expected).set('manifest.json', corruptManifest)),
    /asset bytes differ/,
  );
  assert.throws(
    () => expectServedAsset('manifest.json', corruptManifest, packedManifest),
    /served manifest value/,
  );

  // Same-length corruption must be caught even when the upstream manifest still parses.
  const corrupt = Buffer.from(expected.get(manifest.entry));
  corrupt[0] ^= 1;
  await writeFile(join(payload, manifest.entry), corrupt);
  await assert.rejects(expectAssets(payload, expected), /asset bytes differ/);
  if (mutation === 'packed-ui') {
    await rm(packed[UI].slice(5));
    run('tar', ['-czf', packed[UI].slice(5), '-C', extract, 'package'], scratch);
  }
  await writeFile(join(payload, manifest.entry), expected.get(manifest.entry));

  const headless = join(scratch, 'headless');
  const headlessOverrides = Object.fromEntries(
    Object.entries(packed).filter(([name]) => name !== UI && name !== BRIDGE),
  );
  await install(
    headless,
    {
      '@package-broker/cli': packed['@package-broker/cli'],
      '@package-broker/core': packed['@package-broker/core'],
    },
    headlessOverrides,
    store,
  );
  const requireHeadless = createRequire(join(headless, 'package.json'));
  const headlessCliRequire = createRequire(
    requireHeadless.resolve('@package-broker/cli/package.json'),
  );
  for (const name of ['cli', 'runtime-node', 'runtime-cloudflare']) {
    const graph = await packageGraph(
      (name === 'cli' ? requireHeadless : headlessCliRequire).resolve(
        `@package-broker/${name}/package.json`,
      ),
      headless,
    );
    assert.ok(
      !graph.some((pkg) => pkg.name === UI || pkg.name === BRIDGE),
      'CLI/runtime transitively depends on UI',
    );
  }
  for (const name of [UI, BRIDGE])
    assert.throws(() => requireHeadless.resolve(`${name}/package.json`));
  const headlessConfig = join(headless, 'broker.config.ts');
  await writeFile(
    headlessConfig,
    `import { defineConfig } from '@package-broker/core/config';\nexport default defineConfig({ platform: 'cloudflare', plugins: [] });\n`,
  );
  const invocation = join(scratch, 'invocation');
  await mkdir(invocation);
  const build = (require, config, target, out) =>
    run(
      process.execPath,
      [
        join(dirname(require.resolve('@package-broker/cli/package.json')), 'dist/bin.js'),
        'build',
        '--config',
        config,
        '--target',
        target,
        '--out',
        out,
      ],
      invocation,
    );
  for (const target of TARGETS) {
    const out = join(headless, 'custom-output', target);
    build(requireHeadless, headlessConfig, target, out);
    await assert.rejects(readFile(join(out, 'assets.json')), { code: 'ENOENT' });
    await isolation(out, target, invocation);
  }
  console.log('headless: packed CLI builds both targets with no UI or bridge installed');

  const consumer = join(scratch, 'consumer');
  await install(
    consumer,
    {
      '@package-broker/cli': packed['@package-broker/cli'],
      '@package-broker/core': packed['@package-broker/core'],
      [BRIDGE]: packed[BRIDGE],
    },
    packed,
    store,
  );
  const requireConsumer = createRequire(join(consumer, 'package.json'));
  const cliRequire = createRequire(requireConsumer.resolve('@package-broker/cli/package.json'));
  await packageGraph(join(consumer, 'package.json'), consumer);
  assert.throws(
    () => requireConsumer.resolve(`${UI}/package.json`),
    'UI must be private to the bridge dependency layout',
  );
  const config = join(consumer, 'config', 'broker.config.ts');
  await mkdir(dirname(config));
  await writeFile(
    config,
    `import { defineConfig } from '@package-broker/core/config';\nexport default defineConfig({ platform: 'cloudflare', plugins: [], assets: [{ kind: 'ui', provider: '${BRIDGE}' }] });\n`,
  );
  const split = (
    await import(
      pathToFileURL(cliRequire.resolve('@package-broker/db-sqlite/migrations/split')).href
    )
  ).splitStatements;
  const deployed = join(scratch, 'deployment');
  await mkdir(deployed);
  for (const target of TARGETS) {
    const out = join(consumer, 'custom-output', target);
    build(requireConsumer, config, target, out);
    const record = await json(join(out, 'assets.json'));
    assert.equal(record.schemaVersion, 1);
    assert.equal(record.provider.specifier, BRIDGE);
    const ordered = ['manifest.json', ...Object.keys(manifest.files).sort()];
    assert.equal(
      record.digest,
      `sha256:${hash(JSON.stringify(ordered.map((name) => [name, hash(expected.get(name))])))}`,
    );
    if (mutation === 'staging') await writeFile(join(out, 'assets', manifest.entry), corrupt);
    await expectAssets(join(out, 'assets'), expected);
    await isolation(out, target, invocation);
    await writeFile(join(out, 'assets', manifest.entry), corrupt);
    await assert.rejects(expectAssets(join(out, 'assets'), expected), /asset bytes differ/);
    await writeFile(join(out, 'assets', manifest.entry), expected.get(manifest.entry));
    const destination = join(deployed, target);
    await cp(out, destination, { recursive: true });
    if (mutation === 'manifest-value')
      await writeFile(join(destination, 'assets', 'manifest.json'), corruptManifest);
    // Build diagnostics and source maps are not deployment inputs.
    for (const name of [
      'generated',
      'metafile.json',
      `${target === 'node' ? 'server' : 'worker'}.js.map`,
    ])
      await rm(join(destination, name), { recursive: true, force: true });
  }
  const workerOut = join(deployed, 'cloudflare');
  const migrationRoot = join(workerOut, 'migrations', 'core');
  const statements = [];
  for (const name of (await readdir(migrationRoot)).sort())
    statements.push(...split(await readFile(join(migrationRoot, name), 'utf8')));
  const nodeOut = join(deployed, 'node');
  const nodePackage = await json(join(nodeOut, 'package.json'));
  assert.deepEqual(Object.keys(nodePackage.dependencies), ['better-sqlite3']);
  await install(nodeOut, nodePackage.dependencies, {}, store);
  const nodeRequire = createRequire(join(nodeOut, 'package.json'));
  const native = process.env.PB_UI_ASSETS_NATIVE_BINARY;
  if (native) {
    assert.ok(
      !inside(ROOT, await realpath(native)),
      'prepared native binary must be outside the checkout',
    );
    const destination = join(
      dirname(nodeRequire.resolve('better-sqlite3/package.json')),
      'build',
      'Release',
    );
    await mkdir(destination, { recursive: true });
    await cp(native, join(destination, 'better_sqlite3.node'));
  }
  try {
    const db = new (nodeRequire('better-sqlite3'))(':memory:');
    db.close();
  } catch {
    throw new Unverified(
      'installed better-sqlite3 needs a prepared offline native binary (PB_UI_ASSETS_NATIVE_BINARY)',
    );
  }
  const toolDir = join(scratch, 'simulator');
  const runtimeRequire = createRequire(join(ROOT, 'packages/runtime-cloudflare/package.json'));
  const miniflareVersion = runtimeRequire('miniflare/package.json').version;
  await install(toolDir, { miniflare: miniflareVersion }, {}, store);
  const toolsRequire = createRequire(join(toolDir, 'package.json'));
  for (const path of [consumer, headless, invocation, tarDir, extract])
    await rm(path, { recursive: true, force: true });
  const runtimeGraph = await packageGraph(join(nodeOut, 'package.json'), nodeOut);
  assert.ok(runtimeGraph.every((pkg) => !pkg.name?.startsWith('@package-broker/')));
  await nodeDelivery(nodeOut, expected, manifest);
  console.log(
    'node: relocated deployment serves authenticated packed UI without build-time packages',
  );
  await workerDelivery(workerOut, expected, manifest, toolsRequire, statements);
  console.log(
    'cloudflare: relocated deployment serves authenticated packed UI without build-time packages',
  );
  console.log(
    'check:ui-assets-install ok (packed payload, staging and manifest mutations rejected)',
  );
} catch (error) {
  if (error instanceof Unverified) {
    console.error(
      `check:ui-assets-install UNVERIFIED: ${error.message}; no workspace fallback used`,
    );
    process.exitCode = 2;
  } else {
    console.error(`check:ui-assets-install FAILED: ${error.message}`);
    process.exitCode = 1;
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
