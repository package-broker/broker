import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { readFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  MOCK_CLIENT_ID,
  assertDiscovered,
  assertProviderListing,
  assertStartRedirect,
  digestFiles,
  mockIssuerResponse,
  runtimeProviderSettings,
  secretName,
  startMockIssuer,
} from './mock-oidc-issuer.mjs';
import {
  INSTALL_NOT_RUN,
  NODE_SSO_STAGES,
  checkSsoStage,
  discoverTarball,
  copyMetafile,
  installNeedsNetwork,
  loadExpectedRecord,
  parseExpectedRecord,
  runNodeRuntimeSso,
  runPrebuiltSmoke,
  serverEnv,
} from './prebuilt-smoke.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const expected = {
  schemaVersion: 1,
  package: '@package-broker/dist-cloudflare',
  version: '2.0.0-rc.0',
  artifactSha256: 'a'.repeat(64),
  prebuiltJsonSha256: 'b'.repeat(64),
};

async function fixture(t) {
  await mkdir(join(ROOT, '.pb'), { recursive: true });
  const root = await mkdtemp(join(ROOT, '.pb', 'prebuilt-smoke-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('discovers the tarball without depending on pack stdout or a hardcoded version', () => {
  for (const name of [
    'package-broker-dist-2.0.0-rc.0.tgz',
    'package-broker-dist-cloudflare-3.1.4.tgz',
  ])
    assert.equal(discoverTarball(['notes.txt', name, 'package.json']), name);
  for (const names of [[], ['notes.txt'], ['one.tgz', 'two.tgz']])
    assert.throws(() => discoverTarball(names), /exactly one packed tarball/);
});

test('loads the staged CLI expected record and reports missing staging', async (t) => {
  const root = await fixture(t);
  const path = join(root, 'prebuilt-expected.json');
  await assert.rejects(loadExpectedRecord(path), /pnpm stage:prebuilt --write-cli-expected/);
  await writeFile(path, JSON.stringify(expected));
  assert.deepEqual(await loadExpectedRecord(path), expected);
  await writeFile(path, 'invalid private input');
  await assert.rejects(loadExpectedRecord(path), { message: 'Invalid prebuilt expected record' });
});

test('rejects malformed expected records before packing', () => {
  const invalid = [null, [], {}, 'secret', { ...expected, extra: true }];
  for (const key of Object.keys(expected)) {
    const record = { ...expected };
    delete record[key];
    invalid.push(record);
  }
  for (const [key, value] of [
    ['schemaVersion', 2],
    ['package', '@package-broker/dist'],
    ['version', 42],
    ['version', ''],
    ['artifactSha256', 'a'.repeat(63)],
    ['artifactSha256', ['a'.repeat(64)]],
    ['prebuiltJsonSha256', 'x'.repeat(64)],
    ['prebuiltJsonSha256', ['b'.repeat(64)]],
  ])
    invalid.push({ ...expected, [key]: value });
  for (const record of invalid)
    assert.throws(() => parseExpectedRecord(JSON.stringify(record)), {
      message: 'Invalid prebuilt expected record',
    });
  assert.throws(() => parseExpectedRecord('private input'), {
    message: 'Invalid prebuilt expected record',
  });
});

test('classifies network failures but never successful installs or unrelated failures', () => {
  for (const code of [
    'ENOTFOUND',
    'EAI_AGAIN',
    'ECONNREFUSED',
    'ECONNRESET',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'ETIMEDOUT',
    'ENOTCACHED',
  ]) {
    for (const output of [
      { stderr: `npm error code ${code}` },
      { stdout: `prebuild-install ${code}` },
      { error: { code } },
    ]) {
      assert.equal(installNeedsNetwork({ status: 1, ...output }), true);
      assert.equal(installNeedsNetwork({ status: 0, ...output }), false);
    }
  }
  for (const output of [
    { stderr: 'gyp ERR! build error' },
    { stderr: 'npm error code ERESOLVE' },
    { stderr: 'better-sqlite3 failed to compile' },
    { error: { code: 'ENOENT' } },
    {},
  ])
    assert.equal(installNeedsNetwork({ status: 1, ...output }), false);
});

for (const [diagnostic, message] of [
  ['npm error code ENOTFOUND\nprivate-registry-output', INSTALL_NOT_RUN],
  ['gyp ERR! build error\nprivate-build-output', 'npm install failed'],
]) {
  test(`install failure emits the right classification and cleans up: ${message}`, async (t) => {
    const root = await fixture(t);
    const cli = join(root, 'packages/cli/dist');
    await mkdir(cli, { recursive: true });
    await writeFile(join(cli, 'prebuilt-expected.json'), JSON.stringify(expected));
    for (const pkg of ['prebuilt', 'prebuilt-cloudflare'])
      await mkdir(join(root, 'packages', pkg), { recursive: true });
    const bin = join(root, 'bin');
    await mkdir(bin);
    await writeFile(
      join(bin, 'pnpm'),
      `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nimport { join, relative } from 'node:path';\nwriteFileSync(join(process.argv.at(-1), 'packed.tgz'), 'fixture');\n`,
      { mode: 0o755 },
    );
    await writeFile(
      join(bin, 'npm'),
      `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(diagnostic)});\nprocess.exitCode = 1;\n`,
      { mode: 0o755 },
    );
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath}`;
    try {
      await assert.rejects(runPrebuiltSmoke({ root }), (error) => {
        assert.equal(error.message, message);
        assert.equal(error.exitCode, 1);
        return true;
      });
    } finally {
      process.env.PATH = originalPath;
    }
    assert.deepEqual(await readdir(join(root, '.pb')), []);
  });
}

for (const target of ['node', 'cloudflare']) {
  for (const change of ['none', 'chunk', 'migration', 'extra', 'missing', 'asset']) {
    test(`metafile ${target}: validates the whole payload (${change})`, async (t) => {
      const root = await fixture(t);
      const built = join(root, '.pb', target);
      const installed = join(root, 'installed');
      for (const dir of [built, installed]) {
        await mkdir(join(dir, 'migrations'), { recursive: true });
        await mkdir(join(dir, 'assets'), { recursive: true });
        for (const [name, bytes] of [
          [target === 'node' ? 'server.js' : 'worker.js', 'entry'],
          ['chunk.js', 'chunk'],
          ['migrations/0001.sql', 'schema'],
          ['build-info.json', '{}'],
          ['assets/index.html', 'asset'],
        ])
          await writeFile(join(dir, name), bytes);
      }
      await writeFile(join(built, 'metafile.json'), '{"inputs":{}}');
      await writeFile(join(built, 'package.json'), '{}');
      await writeFile(join(built, 'server.js.map'), 'omitted diagnostic');
      if (target === 'cloudflare') await writeFile(join(installed, 'prebuilt.json'), '{}');
      if (change === 'chunk') await writeFile(join(installed, 'chunk.js'), 'changed');
      if (change === 'migration')
        await writeFile(join(installed, 'migrations/0001.sql'), 'changed');
      if (change === 'extra') await writeFile(join(installed, 'extra.txt'), 'extra');
      if (change === 'missing') await rm(join(installed, 'chunk.js'));
      if (change === 'asset') await writeFile(join(installed, 'assets/index.html'), 'changed');
      if (['none', 'asset'].includes(change)) {
        await copyMetafile(root, target, installed);
        assert.equal(await readFile(join(installed, 'metafile.json'), 'utf8'), '{"inputs":{}}');
      } else {
        await assert.rejects(copyMetafile(root, target, installed), {
          message:
            'Smoke metafile needs matching payloads; re-run pnpm bundle && pnpm stage:prebuilt',
        });
        await assert.rejects(readFile(join(installed, 'metafile.json')), { code: 'ENOENT' });
      }
    });
  }
}

test('runner preserves the installed Node layout and selects prebuilt mode for both smokes', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, 'packages/cli/dist'), { recursive: true });
  await writeFile(join(root, 'packages/cli/dist/prebuilt-expected.json'), JSON.stringify(expected));
  const calls = [];
  const run = (program, args, options, label) => {
    calls.push({ program, args, options, label });
    if (program === 'pnpm') writeFileSync(join(args.at(-1), 'fixture.tgz'), 'tarball');
    if (label === 'smoke:prebuilt Node leg') {
      assert.equal(existsSync(join(options.env.SMOKE_NODE_DIR, 'package.json')), false);
      assert.equal(existsSync(join(options.env.SMOKE_NODE_DIR, 'node_modules')), false);
    }
  };
  const materialize = async ({ project }) => {
    for (const [target, pkg] of [
      ['node', 'dist'],
      ['cloudflare', 'dist-cloudflare'],
    ]) {
      const packageDir = join(project, 'node_modules/@package-broker', pkg);
      const out = join(packageDir, target);
      const built = join(root, '.pb', target);
      await mkdir(out, { recursive: true });
      await mkdir(built, { recursive: true });
      await writeFile(
        join(packageDir, 'package.json'),
        JSON.stringify({
          name: `@package-broker/${pkg}`,
          exports: { './package.json': './package.json', './prebuilt.json': './prebuilt.json' },
        }),
      );
      await writeFile(join(packageDir, 'prebuilt.json'), JSON.stringify(expected));
      for (const dir of [out, built])
        await writeFile(join(dir, target === 'node' ? 'server.js' : 'worker.js'), 'entry');
      await writeFile(join(built, 'metafile.json'), '{}');
    }
    return {
      artifactSha256: expected.artifactSha256,
      outDir: join(project, 'node_modules/@package-broker/dist-cloudflare/cloudflare'),
    };
  };
  await runPrebuiltSmoke({ root, run, materialize });
  const smokes = calls.filter(({ label }) => /smoke:prebuilt .* leg/.test(label));
  assert.equal(smokes.length, 2);
  for (const { options } of smokes) assert.equal(options.env.SMOKE_PREBUILT, '1');
  assert.match(
    smokes[0].options.env.SMOKE_NODE_DIR,
    /project\/node_modules\/@package-broker\/dist\/node$/,
  );
  assert.deepEqual(await readdir(join(root, '.pb')), ['cloudflare', 'node']);
});

test('Node prebuilt startup uses the installed entry and hoisted resolution from another cwd', async (t) => {
  const root = await fixture(t);
  const runtime = join(root, 'project/node_modules/@package-broker/dist/node');
  const dependency = join(root, 'project/node_modules/smoke-hoisted');
  await mkdir(runtime, { recursive: true });
  await mkdir(dependency, { recursive: true });
  await writeFile(
    join(root, 'project/node_modules/@package-broker/dist/package.json'),
    JSON.stringify({ type: 'module' }),
  );
  await writeFile(join(dependency, 'package.json'), JSON.stringify({ exports: './index.mjs' }));
  await writeFile(join(dependency, 'index.mjs'), "export default 'hoisted';");
  const marker = join(root, 'started.json');
  await writeFile(
    join(runtime, 'server.js'),
    `
import { writeFileSync } from 'node:fs';
import value from 'smoke-hoisted';
writeFileSync(process.env.SMOKE_TEST_MARKER, JSON.stringify({ cwd: process.cwd(), value }));
process.exit(31);
`,
  );
  // Startup exits before serving HTTP; avoid binding a port in restricted sandboxes.
  const preload = join(root, 'no-network.mjs');
  await writeFile(
    preload,
    `
import net from 'node:net';
net.createServer = () => ({
  once() {},
  listen(_port, ready) { ready(); },
  address() { return { port: 32000 }; },
  close(done) { done(); },
});
globalThis.fetch = () => new Promise(() => {});
`,
  );
  const result = spawnSync(
    process.execPath,
    ['--import', preload, join(ROOT, 'scripts/node-bundle-smoke.mjs')],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 20000,
      env: {
        ...process.env,
        SMOKE_PREBUILT: '1',
        SMOKE_OFFLINE: '1',
        SMOKE_NODE_DIR: relative(ROOT, runtime),
        SMOKE_TEST_MARKER: marker,
      },
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /server exited with code 31 before becoming ready/);
  assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), { cwd: runtime, value: 'hoisted' });
  assert.equal(existsSync(join(runtime, 'package.json')), false);
  assert.equal(existsSync(join(runtime, 'node_modules')), false);
});

test('runner runs the Node runtime SSO stage on the installed Node directory', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, 'packages/cli/dist'), { recursive: true });
  await writeFile(join(root, 'packages/cli/dist/prebuilt-expected.json'), JSON.stringify(expected));
  const calls = [];
  const run = (program, args, options, label) => {
    calls.push({ args, options, label });
    if (program === 'pnpm') writeFileSync(join(args.at(-1), 'fixture.tgz'), 'tarball');
  };
  const materialize = async ({ project }) => {
    for (const [target, pkg] of [
      ['node', 'dist'],
      ['cloudflare', 'dist-cloudflare'],
    ]) {
      const packageDir = join(project, 'node_modules/@package-broker', pkg);
      const out = join(packageDir, target);
      const built = join(root, '.pb', target);
      await mkdir(out, { recursive: true });
      await mkdir(built, { recursive: true });
      await writeFile(
        join(packageDir, 'package.json'),
        JSON.stringify({
          name: `@package-broker/${pkg}`,
          exports: { './package.json': './package.json', './prebuilt.json': './prebuilt.json' },
        }),
      );
      await writeFile(join(packageDir, 'prebuilt.json'), JSON.stringify(expected));
      for (const dir of [out, built])
        await writeFile(join(dir, target === 'node' ? 'server.js' : 'worker.js'), 'entry');
      await writeFile(join(built, 'metafile.json'), '{}');
    }
    return {
      artifactSha256: expected.artifactSha256,
      outDir: join(project, 'node_modules/@package-broker/dist-cloudflare/cloudflare'),
    };
  };
  await runPrebuiltSmoke({ root, run, materialize });
  const labels = calls.map(({ label }) => label);
  const node = labels.indexOf('smoke:prebuilt Node leg');
  const sso = labels.indexOf('smoke:prebuilt Node runtime SSO stage');
  assert.ok(node >= 0 && sso === node + 1, 'the SSO stage runs right after the Node leg');
  assert.ok(sso < labels.indexOf('smoke:prebuilt Worker leg'));
  const stage = calls[sso];
  assert.deepEqual(stage.args, [join(root, 'scripts/prebuilt-smoke.mjs'), '--node-runtime-sso']);
  assert.equal(stage.options.env.SMOKE_NODE_DIR, calls[node].options.env.SMOKE_NODE_DIR);
  assert.match(stage.options.env.SMOKE_SSO_DATA, /prebuilt-smoke-[^/]+\/sso-data$/);
  assert.equal(stage.options.env.npm_config_offline, 'true');
});

test('mock issuer answers discovery under any issuer path and an empty JWKS', () => {
  const origin = 'http://127.0.0.1:4100';
  for (const prefix of ['', '/tenant-a', '/a/b']) {
    const { status, body } = mockIssuerResponse(
      origin,
      'GET',
      `${prefix}/.well-known/openid-configuration`,
    );
    assert.equal(status, 200);
    assert.equal(body.issuer, `${origin}${prefix}`);
    for (const [key, suffix] of [
      ['authorization_endpoint', 'authorize'],
      ['token_endpoint', 'token'],
      ['jwks_uri', 'jwks'],
    ]) {
      const url = new URL(body[key]);
      assert.equal(url.origin, origin, `${key} stays on the issuer origin`);
      assert.equal(body[key], `${origin}${prefix}/${suffix}`);
    }
    assert.ok(body.code_challenge_methods_supported.includes('S256'));
  }
  assert.deepEqual(mockIssuerResponse(origin, 'GET', '/tenant-a/jwks'), {
    status: 200,
    body: { keys: [] },
  });
  assert.equal(mockIssuerResponse(origin, 'GET', '/tenant-a/token').status, 404);
  assert.equal(mockIssuerResponse(origin, 'POST', '/tenant-a/token').status, 405);
});

test('mock issuer listens on loopback, records requests and closes', async () => {
  const issuer = await startMockIssuer();
  try {
    assert.match(issuer.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(`${issuer.issuer('/tenant-a')}/.well-known/openid-configuration`);
    assert.equal(response.status, 200);
    const document = await response.json();
    assert.equal(document.issuer, issuer.issuer('/tenant-a'));
    assert.equal(document.authorization_endpoint, issuer.authorizationEndpoint('/tenant-a'));
    assert.deepEqual(await (await fetch(document.jwks_uri)).json(), { keys: [] });
    assertDiscovered(issuer.requests, '/tenant-a');
    assert.throws(() => assertDiscovered(issuer.requests, '/tenant-b'), /discovery/);
  } finally {
    await issuer.close();
  }
  await assert.rejects(fetch(issuer.origin));
});

test('runtime provider settings carry one OIDC entry and its client secret only', () => {
  assert.equal(secretName('mock'), 'PB_IDP_MOCK_CLIENT_SECRET');
  assert.equal(secretName('corp-sso'), 'PB_IDP_CORP_SSO_CLIENT_SECRET');
  const settings = runtimeProviderSettings('mock2', 'http://127.0.0.1:4100/tenant-b');
  assert.deepEqual(Object.keys(settings).sort(), [
    'PB_IDP_MOCK2_CLIENT_SECRET',
    'PB_IDP_PROVIDERS',
  ]);
  const [entry, ...rest] = JSON.parse(settings.PB_IDP_PROVIDERS);
  assert.deepEqual(rest, []);
  assert.equal(entry.id, 'mock2');
  assert.equal(entry.kind, 'oidc');
  assert.equal(entry.issuer, 'http://127.0.0.1:4100/tenant-b');
  assert.equal(entry.clientId, MOCK_CLIENT_ID);
  assert.ok(entry.policy && Array.isArray(entry.policy.verifiedDomains));
  assert.ok(!settings.PB_IDP_PROVIDERS.includes(settings.PB_IDP_MOCK2_CLIENT_SECRET));
});

test('provider listing assertion requires present ids and refuses absent ones', () => {
  const listing = { providers: [{ id: 'mock2' }], local: true };
  assert.deepEqual(assertProviderListing(listing, { present: ['mock2'], absent: ['mock'] }), [
    'mock2',
  ]);
  assert.throws(() => assertProviderListing(listing, { present: ['mock'] }), /mock must be listed/);
  assert.throws(
    () =>
      assertProviderListing(
        { providers: [{ id: 'mock' }, { id: 'mock2' }] },
        {
          present: ['mock2'],
          absent: ['mock'],
        },
      ),
    /mock must not be listed/,
  );
  for (const bad of [null, {}, { providers: 'mock' }])
    assert.throws(() => assertProviderListing(bad, { present: [] }), /providers array/);
});

test('start redirect assertion checks status, endpoint and authorization parameters', () => {
  const authorizationEndpoint = 'http://127.0.0.1:4100/tenant-a/authorize';
  const callbackUrl = 'http://127.0.0.1:5000/_pb/auth/sso/mock/callback';
  const location = (overrides = {}, endpoint = authorizationEndpoint) => {
    const url = new URL(endpoint);
    for (const [key, value] of Object.entries({
      response_type: 'code',
      client_id: MOCK_CLIENT_ID,
      redirect_uri: callbackUrl,
      state: 'state',
      code_challenge_method: 'S256',
      ...overrides,
    }))
      if (value !== null) url.searchParams.set(key, value);
    return url.href;
  };
  const expectations = { authorizationEndpoint, callbackUrl };
  assertStartRedirect({ status: 303, location: location() }, expectations);
  for (const [response, pattern] of [
    [{ status: 200, location: location() }, /303/],
    [{ status: 303, location: null }, /Location/],
    [
      { status: 303, location: location({}, 'http://127.0.0.1:4100/tenant-b/authorize') },
      /mock authorization endpoint/,
    ],
    [{ status: 303, location: location({ client_id: 'other' }) }, /other/],
    [{ status: 303, location: location({ redirect_uri: 'http://x.test/cb' }) }, /x\.test/],
    [{ status: 303, location: location({ state: null }) }, /state/],
  ])
    assert.throws(() => assertStartRedirect(response, expectations), pattern);
});

test('Node SSO stage checks listing, redirect, discovery and removed providers', async () => {
  const issuer = {
    origin: 'http://127.0.0.1:4100',
    requests: [{ method: 'GET', pathname: '/tenant-b/.well-known/openid-configuration' }],
    authorizationEndpoint: (path) => `http://127.0.0.1:4100${path}/authorize`,
  };
  const base = 'http://127.0.0.1:5000';
  const fake =
    ({ listed = ['mock2'], removed = 404, location } = {}) =>
    async (url, init = {}) => {
      if (url.endsWith('/_pb/auth/providers'))
        return Response.json({ providers: listed.map((id) => ({ id })) });
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'manual');
      assert.equal(init.headers.origin, base);
      if (url.includes('/sso/mock/')) return new Response(null, { status: removed });
      const target = new URL(location ?? issuer.authorizationEndpoint('/tenant-b'));
      target.search = new URLSearchParams({
        response_type: 'code',
        client_id: MOCK_CLIENT_ID,
        redirect_uri: `${base}/_pb/auth/sso/mock2/callback`,
        state: 's',
        code_challenge_method: 'S256',
      }).toString();
      return new Response(null, { status: 303, headers: { location: target.href } });
    };
  const stage = NODE_SSO_STAGES[1];
  assert.deepEqual(stage, { id: 'mock2', path: '/tenant-b', absent: ['mock'] });
  assert.deepEqual(await checkSsoStage(base, issuer, stage, fake()), ['mock2']);
  await assert.rejects(
    checkSsoStage(base, issuer, stage, fake({ listed: ['mock', 'mock2'] })),
    /mock must not be listed/,
  );
  await assert.rejects(
    checkSsoStage(base, issuer, stage, fake({ removed: 303 })),
    /removed provider mock answered 303/,
  );
  await assert.rejects(
    checkSsoStage(
      base,
      issuer,
      stage,
      fake({ location: issuer.authorizationEndpoint('/tenant-a') }),
    ),
    /mock authorization endpoint/,
  );
  await assert.rejects(
    checkSsoStage(base, { ...issuer, requests: [] }, stage, fake()),
    /fetch discovery/,
  );
});

test('server environment drops inherited PB_ settings and sets the stage providers', () => {
  const env = serverEnv(
    {
      PATH: '/bin',
      NODE_PATH: '/elsewhere',
      PB_IDP_PROVIDERS: '[{"id":"leak"}]',
      PB_IDP_LEAK_CLIENT_SECRET: 'x',
      PB_MASTER_KEY_FILE: '/key',
    },
    {
      port: 4321,
      dataDir: '/data',
      settings: runtimeProviderSettings('mock', 'http://127.0.0.1:1/a'),
    },
  );
  assert.equal(env.PATH, '/bin');
  for (const name of ['NODE_PATH', 'PB_IDP_LEAK_CLIENT_SECRET', 'PB_MASTER_KEY_FILE'])
    assert.equal(env[name], undefined);
  assert.equal(JSON.parse(env.PB_IDP_PROVIDERS)[0].id, 'mock');
  assert.equal(env.PB_IDP_MOCK_CLIENT_SECRET, 'smoke-secret-mock');
  assert.equal(env.PB_PUBLIC_URL, 'http://127.0.0.1:4321');
  assert.equal(env.PORT, '4321');
  assert.equal(env.PB_SQLITE_PATH, '/data/db.sqlite');
});

test('bundle digests are per file and change with any byte', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'server.js'), 'entry');
  await writeFile(join(root, 'nested/chunk.js'), 'chunk');
  const first = await digestFiles(root, ['server.js', 'nested/chunk.js']);
  assert.deepEqual(Object.keys(first.files), ['nested/chunk.js', 'server.js']);
  assert.match(first.combined, /^[a-f0-9]{64}$/);
  assert.deepEqual(await digestFiles(root, ['nested/chunk.js', 'server.js']), first);
  await writeFile(join(root, 'nested/chunk.js'), 'chunk!');
  const second = await digestFiles(root, ['server.js', 'nested/chunk.js']);
  assert.equal(second.files['server.js'], first.files['server.js']);
  assert.notEqual(second.combined, first.combined);
});

const FAKE_SERVER = `
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
const providers = JSON.parse(process.env.PB_IDP_PROVIDERS);
const base = process.env.PB_PUBLIC_URL;
if (process.env.SMOKE_FAKE_MUTATE === '1') appendFileSync(new URL(import.meta.url), '\\n');
const server = createServer(async (request, response) => {
  if (request.url === '/health/ready') return response.end('ok');
  if (request.url === '/_pb/auth/providers') {
    response.setHeader('content-type', 'application/json');
    return response.end(JSON.stringify({ providers: providers.map(({ id }) => ({ id })) }));
  }
  const id = /^\\/_pb\\/auth\\/sso\\/([^/]+)\\/start$/.exec(request.url)?.[1];
  const provider = providers.find((entry) => entry.id === id);
  if (!provider || !process.env['PB_IDP_' + id.toUpperCase() + '_CLIENT_SECRET']) {
    response.statusCode = 404;
    return response.end();
  }
  const discovery = await (await fetch(provider.issuer + '/.well-known/openid-configuration')).json();
  const target = new URL(discovery.authorization_endpoint);
  target.search = new URLSearchParams({
    response_type: 'code',
    client_id: provider.clientId,
    redirect_uri: base + '/_pb/auth/sso/' + id + '/callback',
    state: 's',
    code_challenge_method: 'S256',
  }).toString();
  response.writeHead(303, { location: target.href });
  response.end();
});
server.listen(Number(process.env.PORT), '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;

for (const mutate of [false, true]) {
  test(`Node runtime SSO stage restarts one install with two provider sets (mutate=${mutate})`, async (t) => {
    const root = await fixture(t);
    const nodeDir = join(root, 'node');
    await mkdir(join(nodeDir, 'assets'), { recursive: true });
    await writeFile(join(nodeDir, 'package.json'), JSON.stringify({ type: 'module' }));
    await writeFile(join(nodeDir, 'server.js'), FAKE_SERVER);
    await writeFile(join(nodeDir, 'assets/index.html'), 'ui');
    const lines = [];
    const previous = process.env.SMOKE_FAKE_MUTATE;
    process.env.SMOKE_FAKE_MUTATE = mutate ? '1' : '0';
    try {
      const outcome = runNodeRuntimeSso({
        nodeDir,
        dataDir: join(root, 'data'),
        log: (line) => lines.push(line),
      });
      if (mutate) {
        await assert.rejects(outcome, /Installed Node bundle changed between provider sets/);
        return;
      }
      const { before, after } = await outcome;
      assert.deepEqual(after, before);
      assert.deepEqual(Object.keys(before.files), ['package.json', 'server.js']);
    } finally {
      if (previous === undefined) delete process.env.SMOKE_FAKE_MUTATE;
      else process.env.SMOKE_FAKE_MUTATE = previous;
    }
    assert.ok(lines.some((line) => /PB_IDP_PROVIDERS=mock: providers \[mock\]/.test(line)));
    assert.ok(
      lines.some((line) =>
        /PB_IDP_PROVIDERS=mock2: providers \[mock2\], start 303 to <mock>\/tenant-b\/authorize, mock start 404/.test(
          line,
        ),
      ),
    );
    assert.ok(lines.some((line) => /bundle sha256 before=[a-f0-9]{64}/.test(line)));
  });
}
