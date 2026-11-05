import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  selectClient,
  clientCommands,
  checkResult,
  checkTraffic,
  fixtureReply,
  PUBLISH_PACKAGES,
} from './client-matrix.mjs';

test('requires a supported client and an exact approved version', () => {
  for (const [client, version] of Object.entries({
    npm: '11.17.0',
    pnpm: '12.5.1',
    yarn: '4.9.2',
    composer: '2.10',
  })) {
    assert.deepEqual(selectClient({ CLIENT: client, CLIENT_VERSION: version }), {
      client,
      version,
    });
  }
  for (const env of [
    {},
    { CLIENT: 'other', CLIENT_VERSION: '1' },
    { CLIENT: 'npm', CLIENT_VERSION: '11' },
    { CLIENT: 'npm', CLIENT_VERSION: '11.17.1' },
  ]) {
    assert.throws(() => selectClient(env), /Unsupported client selection/);
  }
});

test('uses native install, audit and whoami commands; explicitly skips unsupported Yarn ping', () => {
  for (const client of ['npm', 'pnpm', 'yarn']) {
    const commands = clientCommands(client);
    assert.equal(commands.install.command, client);
    assert.ok(commands.install.args.includes('install'));
    assert.equal(commands.audit.command, client);
    assert.ok(commands.audit.args.includes('audit'));
    assert.equal(commands.whoami.command, client);
    assert.ok(commands.whoami.args.includes('whoami'));
    if (client === 'yarn') assert.equal(commands.ping, null);
    else {
      assert.equal(commands.ping.command, client);
      assert.ok(commands.ping.args.includes('ping'));
    }
  }
});

test('rejects failed commands, incorrect identities, and unexpectedly successful refused audits without printing client output', () => {
  checkResult({ code: 0, output: 'matrix-bot\n' }, 'whoami');
  checkResult({ code: 0, output: '{}' }, 'audit');
  checkResult({ code: 1, output: 'unsupported' }, 'audit-without-proxy');
  for (const [result, step] of [
    [{ code: 1, output: 'secret@example.test' }, 'install'],
    [{ code: 0, output: 'wrong-user' }, 'whoami'],
    [{ code: 0, output: 'unsupported' }, 'audit-without-proxy'],
    [{ code: 1, output: 'unrelated failure' }, 'audit-without-proxy'],
  ]) {
    assert.throws(
      () => checkResult(result, step),
      (error) => !error.message.includes(result.output),
    );
  }
});

test('traffic evidence requires each route, both tarballs and a forwarded public-only audit', () => {
  const routes = [
    'packument:matrix-public',
    'packument:@matrix/private',
    'tarball:matrix-public',
    'tarball:@matrix/private',
    'whoami',
    'ping',
    'audit:200',
    'audit:501',
  ];
  const audits = [{ 'matrix-public': ['1.0.0'] }];
  checkTraffic(routes, audits);
  for (const route of routes)
    assert.throws(() =>
      checkTraffic(
        routes.filter((entry) => entry !== route),
        audits,
      ),
    );
  checkTraffic(
    routes.filter((route) => route !== 'ping'),
    audits,
    'yarn',
  );
  assert.throws(() =>
    checkTraffic(
      routes.filter((route) => route !== 'whoami'),
      audits,
      'yarn',
    ),
  );
  assert.throws(() => checkTraffic(routes, []));
  assert.throws(() => checkTraffic(routes, [{ '@matrix/private': ['1.0.0'] }]));
  assert.throws(() => checkTraffic(routes, [{ 'matrix-public': ['2.0.0'] }]));
});

test('local fixture serves scoped registry and npmjs, refuses unknown destinations and credential forwarding', async () => {
  for (const [host, name] of [
    ['registry.npmjs.org', 'matrix-public'],
    ['npm.matrix.test', '@matrix/private'],
  ]) {
    const response = await fixtureReply(
      new Request(`https://${host}/${encodeURIComponent(name)}`),
      [],
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).name, name);
  }
  for (const url of [
    'https://unexpected.test/matrix-public',
    'https://unexpected.test/%40matrix%2Fprivate',
  ]) {
    await assert.rejects(() => fixtureReply(new Request(url), []));
  }
  for (const name of ['authorization', 'cookie']) {
    await assert.rejects(() =>
      fixtureReply(
        new Request('https://registry.npmjs.org/matrix-public', {
          headers: { [name]: 'sensitive' },
        }),
        [],
      ),
    );
  }
  const audits = [];
  assert.equal(
    (
      await fixtureReply(
        new Request('https://registry.npmjs.org/-/npm/v1/security/advisories/bulk', {
          method: 'POST',
          body: JSON.stringify({ 'matrix-public': ['1.0.0'] }),
        }),
        audits,
      )
    ).status,
    200,
  );
  assert.deepEqual(audits, [{ 'matrix-public': ['1.0.0'] }]);
});

test('accepts the native Yarn 4 report format and rejects a different reported identity', () => {
  checkResult(
    { code: 0, output: '➤ YN0000: matrix-bot\n➤ YN0000: Done in 0s 1ms\n' },
    'whoami',
    'yarn',
  );
  assert.throws(() => checkResult({ code: 0, output: '➤ YN0000: wrong-user\n' }, 'whoami', 'yarn'));
  assert.throws(() =>
    checkResult({ code: 0, output: 'prefix matrix-bot suffix' }, 'whoami', 'yarn'),
  );
});

test('fixture rejects wrong methods and private audit bodies', async () => {
  await assert.rejects(() =>
    fixtureReply(new Request('https://registry.npmjs.org/matrix-public', { method: 'POST' }), []),
  );
  await assert.rejects(() =>
    fixtureReply(
      new Request('https://registry.npmjs.org/-/npm/v1/security/advisories/bulk', {
        method: 'POST',
        body: JSON.stringify({ '@matrix/private': ['1.0.0'] }),
      }),
      [],
    ),
  );
});

test('observes validated response bodies and refuses status-only successes', async () => {
  const { observeResponse } = await import('./client-matrix.mjs');
  for (const [path, body, status, expected] of [
    ['/-/whoami', { username: 'matrix-bot' }, 200, 'whoami'],
    ['/-/ping', {}, 200, 'ping'],
    ['/-/npm/v1/security/advisories/bulk', {}, 200, 'audit:200'],
    ['/-/npm/v1/security/advisories/bulk', { code: 'unsupported' }, 501, 'audit:501'],
  ]) {
    const routes = [];
    await observeResponse(
      routes,
      new Request(`http://broker.test/alpha/npm${path}`),
      Response.json(body, { status }),
      status,
    );
    assert.deepEqual(routes, [expected]);
  }
  for (const [path, body, status, expectedStatus] of [
    ['/-/whoami', { username: 'other' }, 200, 200],
    ['/-/whoami', { username: 'matrix-bot' }, 401, 200],
    ['/-/whoami', { username: 'matrix-bot', email: 'private@example.test' }, 200, 200],
    ['/-/ping', { error: 'bad' }, 200, 200],
    ['/-/ping', {}, 401, 200],
    ['/-/npm/v1/security/advisories/bulk', {}, 200, 501],
    ['/-/npm/v1/security/advisories/bulk', {}, 201, 200],
    ['/-/npm/v1/security/advisories/bulk', { code: 'unsupported' }, 200, 501],
    ['/-/npm/v1/security/advisories/bulk', { code: 'unrelated' }, 501, 501],
    ['/-/npm/v1/security/advisories/bulk', { unexpected: [] }, 200, 200],
  ]) {
    await assert.rejects(() =>
      observeResponse(
        [],
        new Request(`http://broker.test/alpha/npm${path}`),
        Response.json(body, { status }),
        expectedStatus,
      ),
    );
  }
});

test('requires installed package identity and bytes, and checks the actual client version', async () => {
  const { checkInstalledPackage, checkVersion } = await import('./client-matrix.mjs');
  checkVersion({ code: 0, stdout: '11.17.0\n', output: '11.17.0\nwarning' }, 'npm', '11.17.0');
  checkVersion({ code: 0, stdout: '12.5.1\n', output: '12.5.1\nwarning' }, 'pnpm', '12.5.1');
  for (const result of [
    { code: 1, stdout: '11.17.0', output: '11.17.0' },
    { code: 0, stdout: '11.17.1', output: '11.17.1' },
    { code: 0, stdout: '', output: '11.17.0' },
  ]) {
    assert.throws(() => checkVersion(result, 'npm', '11.17.0'));
  }
  checkVersion({ code: 0, stdout: 'Composer version 2.10.0 2026-01-01\n' }, 'composer', '2.10');
  assert.throws(() =>
    checkVersion({ code: 0, stdout: 'Composer version 2.9.0' }, 'composer', '2.10'),
  );
  const content = 'module.exports = "client-matrix fixture";\n';
  const manifest = JSON.stringify({ name: 'matrix-public', version: '1.0.0' });
  checkInstalledPackage('matrix-public', manifest, content);
  for (const [metadata, bytes] of [
    [manifest, 'tampered'],
    [JSON.stringify({ name: 'wrong', version: '1.0.0' }), content],
    [JSON.stringify({ name: 'matrix-public', version: '2.0.0' }), content],
    ['invalid-json', content],
  ])
    assert.throws(() => checkInstalledPackage('matrix-public', metadata, bytes));
});

test('does not give pnpm npm-only install or ping options', () => {
  const commands = clientCommands('pnpm');
  assert.deepEqual(commands.install.args, ['install', '--ignore-scripts', '--no-frozen-lockfile']);
  assert.deepEqual(commands.ping.args, ['ping']);
});

test('fixture answers public-name admission probes for every hosted publish fixture', async () => {
  for (const name of PUBLISH_PACKAGES) {
    const path = name.startsWith('@')
      ? `@${encodeURIComponent(name.slice(1))}`
      : encodeURIComponent(name);
    const response = await fixtureReply(
      new Request(`https://registry.npmjs.org/${path}`, { method: 'HEAD' }),
      [],
    );
    assert.equal(response.status, 404);
    assert.equal(await response.text(), '');
  }
  for (const url of [
    'https://registry.npmjs.org/matrix-public',
    'https://npm.matrix.test/matrix-publish-active',
    'https://registry.npmjs.org/missing',
  ])
    await assert.rejects(() => fixtureReply(new Request(url, { method: 'HEAD' }), []));
});

test('fixture returns 404 for names and tarballs absent from each origin', async () => {
  for (const host of ['registry.npmjs.org', 'npm.matrix.test']) {
    const absent = host === 'registry.npmjs.org' ? '@matrix/private' : 'matrix-public';
    for (const path of ['/missing', `/${encodeURIComponent(absent)}`, `/${absent}/-/missing.tgz`]) {
      assert.equal((await fixtureReply(new Request(`https://${host}${path}`), [])).status, 404);
    }
  }
});

test('CLI self-check selects the pinned version and rejects unknown arguments', async () => {
  const { parseSelection } = await import('./client-matrix.mjs');
  assert.deepEqual(parseSelection(['--client', 'npm', '--verbose-steps'], {}), {
    client: 'npm',
    version: '11.17.0',
    verboseSteps: true,
    debug: false,
  });
  assert.deepEqual(parseSelection([], { CLIENT: 'pnpm' }), {
    client: 'pnpm',
    version: '12.5.1',
    verboseSteps: false,
    debug: false,
  });
  for (const args of [['--unknown'], ['--client'], ['--client', 'other']])
    assert.throws(() => parseSelection(args, {}), /Unsupported harness arguments/);
});

test('step failures expose fixed harness messages and withhold arbitrary error data', async () => {
  const { matrixStep } = await import('./client-matrix.mjs');
  await assert.rejects(
    () =>
      matrixStep('node npm install', async () => {
        checkResult({ code: 1, output: 'credential-bearing output' }, 'install', 'npm');
      }),
    { message: 'node npm install failed: Client matrix mismatch: install' },
  );
  await assert.rejects(
    () =>
      matrixStep('node npm boot', async () => {
        throw new Error('credential-bearing exception');
      }),
    { message: 'node npm boot failed: Harness operation failed' },
  );
});

test('seed registers its attached active scoped source before any package is known', async () => {
  const { seed } = await import('./client-matrix-runtime.mjs');
  const { openMigratedDatabase } =
    await import('../packages/db-sqlite/dist/testing/migrated-database.js');
  const { createRegistryReads } =
    await import('../packages/db-sqlite/dist/repositories/registry-reads.js');
  const db = await openMigratedDatabase();
  try {
    await seed(db.executor);
    const rows = await db.executor.all({
      sql: `SELECT s.id, s.org_id, s.status, s.config_json
      FROM source s JOIN project_source ps ON ps.org_id = s.org_id AND ps.source_id = s.id
      WHERE s.type = 'npm_registry'`,
      params: [],
    });
    assert.equal(rows.length, 1);
    const source = rows[0];
    assert.equal(source.status, 'active');
    assert.deepEqual(JSON.parse(source.config_json), { scopes: ['@matrix'] });
    assert.equal(
      await createRegistryReads(db.executor).covers(
        { orgId: source.org_id },
        source.id,
        '@matrix/private',
      ),
      true,
    );
    assert.deepEqual(
      await db.executor.all({
        sql: 'SELECT name FROM project_package WHERE org_id = ?',
        params: [source.org_id],
      }),
      [],
    );
  } finally {
    await db.close();
  }
});

test('debug is opt-in and redacts commands and output including failed and missing commands', async () => {
  const { parseSelection, runCommand, redactClientOutput } = await import('./client-matrix.mjs');
  assert.equal(parseSelection(['--client', 'pnpm', '--debug'], {}).debug, true);
  assert.equal(parseSelection([], { CLIENT: 'yarn', CLIENT_MATRIX_DEBUG: '1' }).debug, true);
  assert.equal(parseSelection([], { CLIENT: 'npm' }).debug, false);
  const secrets = [
    'pb_svc_abc-123',
    'pb_other_token',
    'plain-token',
    'header-secret',
    'person@example.test',
  ];
  const payload = `${secrets[0]} ${secrets[1]}\n//127.0.0.1/alpha/npm/:_authToken=${secrets[2]}\nAuthorization: Bearer ${secrets[3]}\n${secrets[4]}\n`;
  const lines = [];
  const args = ['-e', 'process.stdout.write(process.argv[1]); process.exit(7)', payload];
  const result = await runCommand(process.execPath, args, process.cwd(), process.env, {
    debug: true,
    log: (line) => lines.push(line),
  });
  assert.equal(result.code, 7);
  assert.equal(result.output, payload);
  assert.match(lines.join('\n'), /exit=7/);
  for (const secret of secrets) assert.ok(!lines.join('\n').includes(secret));
  assert.match(redactClientOutput('{"_authToken":"json-secret"}'), /REDACTED/);
  assert.ok(!redactClientOutput('{"Authorization":"Basic json-header"}').includes('json-header'));
  assert.ok(!redactClientOutput('Cookie: session=cookie-secret').includes('cookie-secret'));
  assert.ok(!redactClientOutput('https://user:password@example.test/x').includes('password'));
  lines.length = 0;
  await runCommand(process.execPath, args, process.cwd(), process.env, {
    log: (line) => lines.push(line),
  });
  assert.deepEqual(lines, []);
  await runCommand('/missing-client-matrix-command', [], process.cwd(), process.env, {
    debug: true,
    log: (line) => lines.push(line),
  });
  assert.match(lines.join('\n'), /exit=1/);
  lines.length = 0;
  const failedSpawn = await runCommand(null, [], process.cwd(), process.env, {
    debug: true,
    log: (line) => lines.push(line),
  });
  assert.equal(failedSpawn.code, 1);
  assert.match(lines.join('\n'), /exit=1/);
});

test('prepares isolated path-prefixed client auth, stores and mutable scratch lockfiles', async () => {
  const { mkdir, mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { prepareClient } = await import('./client-matrix.mjs');
  const scratch = join(process.cwd(), '.pb', 'client-matrix-tests');
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'config-'));
  const registry = 'http://127.0.0.1:12345/alpha/npm/';
  try {
    const { project, env } = await prepareClient(directory, 'pnpm', registry, 'pb_test_config');
    const npmrc = await readFile(join(project, '.npmrc'), 'utf8');
    assert.match(npmrc, /\/\/127\.0\.0\.1:12345\/alpha\/npm\/:_authToken=pb_test_config/);
    assert.ok(!npmrc.includes('//127.0.0.1:12345/:_authToken'));
    for (const key of [
      'HOME',
      'TMPDIR',
      'XDG_CACHE_HOME',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_STATE_HOME',
      'npm_config_cache',
    ])
      assert.ok(env[key].startsWith(`${directory}/`), key);
    const workspace = JSON.parse(await readFile(join(project, 'pnpm-workspace.yaml'), 'utf8'));
    assert.equal(workspace.managePackageManagerVersions, undefined);
    assert.equal(env.npm_config_manage_package_manager_versions, undefined);
    assert.equal(workspace.frozenLockfile, false);
    for (const key of ['storeDir', 'cacheDir'])
      assert.ok(workspace[key].startsWith(`${env.HOME}/`));
    assert.equal(workspace.ignoreScripts, true);
    assert.equal(env.YARN_IGNORE_PATH, '1');
    const yarn = JSON.parse(await readFile(join(project, '.yarnrc.yml'), 'utf8'));
    assert.equal(yarn.npmRegistryServer, registry);
    assert.equal(yarn.npmAuditRegistry, registry);
    assert.equal(yarn.npmAuthToken, undefined);
    assert.deepEqual(yarn.npmRegistries[registry.replace(/\/$/, '')], {
      npmAuthToken: 'pb_test_config',
      npmAlwaysAuth: true,
    });
    assert.deepEqual(yarn.unsafeHttpWhitelist, ['127.0.0.1']);
    assert.equal(yarn.enableStrictSsl, true);
    assert.equal(yarn.ignorePath, true);
    for (const key of ['cacheFolder', 'globalFolder'])
      assert.ok(yarn[key].startsWith(`${env.HOME}/`));
    assert.deepEqual(yarn.networkSettings, {
      '*': { enableNetwork: false },
      '127.0.0.1': { enableNetwork: true },
    });
    assert.equal(yarn.enableImmutableInstalls, false);
    assert.equal(yarn.enableScripts, false);
    assert.equal(await readFile(join(project, 'yarn.lock'), 'utf8'), '');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('package manager version management override stays in the pnpm workspace', async () => {
  const { mkdir, mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { prepareClient } = await import('./client-matrix.mjs');
  const scratch = join(process.cwd(), '.pb', 'client-matrix-tests');
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'versions-'));
  try {
    for (const client of ['npm', 'yarn']) {
      const { project, env } = await prepareClient(
        join(directory, client),
        client,
        'http://127.0.0.1:12345/alpha/npm/',
        'pb_test_config',
      );
      const workspace = JSON.parse(await readFile(join(project, 'pnpm-workspace.yaml'), 'utf8'));
      assert.equal(workspace.managePackageManagerVersions, undefined);
      assert.equal(env.npm_config_manage_package_manager_versions, undefined);
    }
    const result = await (
      await import('./client-matrix.mjs')
    ).runCommand(
      process.execPath,
      ['-e', 'process.stdout.write("12.5.1\\n"); process.stderr.write("warning\\n")'],
      process.cwd(),
      process.env,
    );
    assert.equal(result.stdout, '12.5.1\n');
    assert.equal(result.output, '12.5.1\nwarning\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('publish uses each native client with provenance disabled and scripts suppressed', () => {
  for (const client of ['npm', 'pnpm', 'yarn']) {
    const command = clientCommands(client).publish;
    assert.equal(command.command, client);
    assert.ok(command.args.includes('publish'));
    if (client !== 'yarn') {
      assert.ok(command.args.includes('--provenance=false'));
      assert.ok(command.args.includes('--ignore-scripts'));
    }
  }
});

test('publisher prepares Yarn lockfile before publishing', async () => {
  const { preparePublisher } = await import('./client-matrix.mjs');
  const { mkdir, mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const scratch = join(process.cwd(), '.pb', 'client-matrix-tests');
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'publisher-'));
  try {
    for (const client of ['npm', 'pnpm', 'yarn']) {
      const calls = [];
      const publisher = await preparePublisher(
        join(directory, client),
        client,
        'http://127.0.0.1:12345/alpha/npm/',
        'pb_fixture',
        'matrix-publish-active',
        {
          debug: true,
          run: async (command, args, project, env, options) => {
            const manifest = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
            assert.equal(manifest.name, 'matrix-publish-active');
            assert.equal(manifest.dependencies, undefined);
            assert.equal(await readFile(join(project, 'README.md'), 'utf8'), '# Publish fixture\n');
            assert.equal(env.COREPACK_ENABLE_NETWORK, '0');
            assert.deepEqual(options, { debug: true });
            calls.push({ command, args });
            return { code: 0, output: '' };
          },
        },
      );
      assert.deepEqual(calls, client === 'yarn' ? [{ command: 'yarn', args: ['install'] }] : []);
      assert.equal(publisher.project, join(directory, client, 'client'));
    }
    await assert.rejects(
      () =>
        preparePublisher(
          join(directory, 'failed'),
          'yarn',
          'http://127.0.0.1:12345/alpha/npm/',
          'pb_fixture',
          'matrix-publish-active',
          { run: async () => ({ code: 1, output: '' }) },
        ),
      /Client matrix mismatch: publisher install/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('bridge failure reasons preserve harness assertions and withhold arbitrary errors', async () => {
  const { safeFailureReason, harnessAssert, matrixStep } = await import('./client-matrix.mjs');
  let reason;
  try {
    harnessAssert.equal(503, 201, 'Unexpected publish status');
  } catch (error) {
    reason = safeFailureReason(error);
  }
  assert.equal(reason, 'Unexpected publish status');
  assert.equal(
    safeFailureReason(new Error('credential-bearing exception')),
    'Harness operation failed',
  );
  await assert.rejects(
    () =>
      matrixStep('node npm publish matrix-publish-active', async () => {
        harnessAssert.ok(false, `Registry bridge failed: ${reason}`);
      }),
    {
      message:
        'node npm publish matrix-publish-active failed: Registry bridge failed: Unexpected publish status',
    },
  );
});

test('Node harness stages an upload using the configured publish cap', async () => {
  const { openMatrixBlobStore } = await import('./client-matrix-runtime.mjs');
  const { openMigratedDatabase } =
    await import('../packages/db-sqlite/dist/testing/migrated-database.js');
  const { orgContext } = await import('../packages/core/dist/db/port.js');
  const { resolveRegistryConfig } =
    await import('../packages/core/dist/registry/registry-config.js');
  const { mkdtemp, rm, realpath } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'matrix-stage-'));
  const db = await openMigratedDatabase();
  try {
    const store = await openMatrixBlobStore(db.executor, directory, 'https://broker.test');
    const ctx = orgContext('org');
    const bytes = new TextEncoder().encode('staged fixture');
    const staged = await store.stage(ctx, new Blob([bytes]).stream(), {
      maxBytes: resolveRegistryConfig(undefined, 'node', 'https://broker.test').caps
        .publishTarballBytes,
      mediaType: 'application/gzip',
    });
    assert.equal(staged.size, bytes.length);
    await store.discard(ctx, staged);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('seeded harness passes startup keyring verification and grants hosted access management', async () => {
  const { seed } = await import('./client-matrix-runtime.mjs');
  const { openMigratedDatabase } =
    await import('../packages/db-sqlite/dist/testing/migrated-database.js');
  const { createKeyringVerifierStore } =
    await import('../packages/db-sqlite/dist/repositories/keyring-verifier.js');
  const { verifyKeyring } = await import('../packages/core/dist/secrets/keyring-verifier.js');
  const { createKeyring } = await import('../packages/core/dist/secrets/keyring.js');
  const { parseMasterKey } = await import('../packages/core/dist/secrets/master-key.js');
  const db = await openMigratedDatabase();
  try {
    const { orgId } = await seed(db.executor);
    const keyring = createKeyring([
      parseMasterKey('pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', 'PB_MASTER_KEY'),
    ]);
    await verifyKeyring(keyring, createKeyringVerifierStore(db.executor));
    assert.equal(
      (
        await db.executor.all({
          sql: "SELECT permission FROM role_permission WHERE org_id=? AND permission='org:sources:write'",
          params: [orgId],
        })
      ).length,
      1,
    );
  } finally {
    db.close();
  }
});

test('publisher restricts packed files and prepares Yarn lockfile before publishing', async () => {
  const { preparePublisher } = await import('./client-matrix.mjs');
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const directory = await mkdtemp(join(tmpdir(), 'npm21-publisher-'));
  try {
    const calls = [];
    const publisher = await preparePublisher(
      directory,
      'yarn',
      'http://127.0.0.1:12345/alpha/npm/',
      'pb_fixture',
      'matrix-publish-active',
      {
        debug: true,
        run: async (command, args, project, env, options) => {
          const manifest = JSON.parse(await readFile(`${project}/package.json`, 'utf8'));
          assert.equal(manifest.name, 'matrix-publish-active');
          assert.deepEqual(manifest.files, ['index.js', 'README.md']);
          assert.equal(await readFile(`${project}/README.md`, 'utf8'), '# Publish fixture\n');
          assert.equal(env.COREPACK_ENABLE_NETWORK, '0');
          assert.deepEqual(options, { debug: true });
          calls.push({ command, args });
          return { code: 0, output: '' };
        },
      },
    );
    assert.deepEqual(calls, [{ command: 'yarn', args: ['install'] }]);
    assert.equal(publisher.project, `${directory}/client`);
    await assert.rejects(
      () =>
        preparePublisher(
          `${directory}/failed`,
          'yarn',
          'http://127.0.0.1:12345/alpha/npm/',
          'pb_fixture',
          'matrix-publish-active',
          { run: async () => ({ code: 1, output: '' }) },
        ),
      /Client matrix mismatch: publisher install/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('debug login output redacts browser and done capabilities', async () => {
  const { redactClientOutput } = await import('./client-matrix.mjs');
  for (const path of ['/#/npm-login/', '/alpha/npm/-/v1/done/']) {
    const selector = 's'.repeat(43);
    const redacted = redactClientOutput(`Login at http://127.0.0.1:12345${path}${selector}`);
    assert.ok(!redacted.includes(selector));
    assert.match(redacted, /REDACTED/);
  }
});

test('independent publisher roots pack identical bytes without local config or credentials', async () => {
  const { preparePublisher, runCommand } = await import('./client-matrix.mjs');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const directory = await mkdtemp(join(tmpdir(), 'npm21-pack-'));
  try {
    const integrities = [];
    for (const target of ['node', 'worker']) {
      const publisher = await preparePublisher(
        `${directory}/${target}`,
        'npm',
        'http://127.0.0.1:12345/alpha/npm/',
        `pb_synthetic_${target}`,
        'matrix-publish-active',
      );
      const result = await runCommand(
        'npm',
        ['pack', '--dry-run', '--json', '--ignore-scripts', '--offline'],
        publisher.project,
        publisher.env,
      );
      assert.equal(result.code, 0);
      const [pack] = JSON.parse(result.stdout);
      assert.deepEqual(pack.files.map((item) => item.path).sort(), [
        'README.md',
        'index.js',
        'package.json',
      ]);
      assert.match(pack.integrity, /^sha512-/);
      integrities.push(pack.integrity);
    }
    assert.equal(integrities[0], integrities[1]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('republish evidence requires the version_exists refusal code', async () => {
  const { observeResponse } = await import('./client-matrix.mjs');
  const request = () =>
    new Request('http://broker.test/alpha/npm/matrix-publish-active', { method: 'PUT' });
  const routes = [];
  await observeResponse(
    routes,
    request(),
    Response.json({ code: 'version_exists' }, { status: 409 }),
    200,
  );
  assert.deepEqual(routes, ['republish:matrix-publish-active:409']);
  await assert.rejects(() =>
    observeResponse(
      [],
      request(),
      Response.json({ code: 'version_conflict' }, { status: 409 }),
      200,
    ),
  );
});

test('seed keeps a write publish token and a separate full management token', async () => {
  const { seed } = await import('./client-matrix-runtime.mjs');
  const { openMigratedDatabase } =
    await import('../packages/db-sqlite/dist/testing/migrated-database.js');
  const db = await openMigratedDatabase();
  try {
    const seeded = await seed(db.executor);
    assert.notEqual(seeded.publishToken, seeded.manageToken);
    const scopes = await db.executor.all({
      sql: "SELECT selector, scopes_json FROM token WHERE org_id=? AND selector IN ('publishabcde','manageabcdef') ORDER BY selector",
      params: [seeded.orgId],
    });
    assert.deepEqual(scopes, [
      { selector: 'manageabcdef', scopes_json: '["full"]' },
      { selector: 'publishabcde', scopes_json: '["write"]' },
    ]);
  } finally {
    db.close();
  }
});

test('management preparation restores the package to the alpha project', async () => {
  const { seed } = await import('./client-matrix-runtime.mjs');
  const { openMigratedDatabase } =
    await import('../packages/db-sqlite/dist/testing/migrated-database.js');
  const db = await openMigratedDatabase();
  try {
    const seeded = await seed(db.executor);
    await db.executor.batch([
      {
        sql: "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('01J0ACME000000000000000008', ?, 'Active publishes', 'npm', 'hosted')",
        params: [seeded.orgId],
      },
      {
        sql: "INSERT INTO package (id, org_id, source_id, ecosystem, name, visible_to_new_projects) SELECT '01J0ACME000000000000000009', org_id, id, 'npm', 'matrix-publish-active', 0 FROM source WHERE org_id=? AND name='Active publishes'",
        params: [seeded.orgId],
      },
    ]);
    await seeded.prepareManagement('matrix-publish-active');
    await seeded.prepareManagement('matrix-publish-active');
    assert.deepEqual(
      await db.executor.all({
        sql: 'SELECT project_id FROM project_package WHERE org_id=? AND name=?',
        params: [seeded.orgId, 'matrix-publish-active'],
      }),
      [{ project_id: seeded.projectId }],
    );
    const rev = async () =>
      (
        await db.executor.all({
          sql: 'SELECT rev FROM package WHERE org_id=? AND name=?',
          params: [seeded.orgId, 'matrix-publish-active'],
        })
      )[0].rev;
    const before = await rev();
    await seeded.agePublish('matrix-publish-active', true);
    assert.equal(await rev(), before + 1);
  } finally {
    db.close();
  }
});
