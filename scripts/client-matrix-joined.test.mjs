import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertJoinedEvidence, runJoinedJourneys } from './client-matrix-joined.mjs';

const journeys = [
  'approval-first',
  'scan-first',
  'failed-scan',
  'scan-only-failure',
  'workload',
  'repository-tag',
];

test('joined evidence requires every successful journey on each runtime', () => {
  const evidence = Object.fromEntries(journeys.map((name) => [name, true]));
  assertJoinedEvidence(evidence);
  for (const name of journeys) {
    assert.throws(() => assertJoinedEvidence({ ...evidence, [name]: false }));
    const missing = { ...evidence };
    delete missing[name];
    assert.throws(() => assertJoinedEvidence(missing));
  }
});

function fixture(broken = '') {
  const workloadToken = 'pb_svc_abcdefghijkl_' + 'x'.repeat(43);
  const items = new Map();
  const modes = new Map();
  const issued = new Map();
  const firstRunning = new Map();
  const events = [];
  let trusted = false;
  let disabled = false;
  let exchanged = false;
  const response = (value, status = 200, revision = 1) =>
    Response.json(value, { status, headers: { etag: `"r${revision}"` } });
  const broker = {
    publishToken: 'publisher',
    token: 'reader',
    browserHeaders: () => ({}),
    tick: async () => {
      for (const item of items.values()) {
        if (!['queued', 'running'].includes(item.scanState)) continue;
        const mode = modes.get(item.packageName);
        if (mode === 'hold') {
          if (item.scanState === 'queued') {
            item.scanState = 'running';
            item.scanAttempts = 1;
            item.revision++;
          }
          continue;
        }
        item.scanState = mode === 'fail' ? 'failed' : 'allowed';
        item.scanAttempts = mode === 'fail' ? (broken === 'attempts' ? 2 : 3) : 1;
        item.revision++;
      }
    },
    inspectRepositoryBuild: async () => [
      {
        status: broken === 'build' ? 'dead' : 'succeeded',
        refetchable: broken === 'refetchable' ? 1 : 0,
      },
    ],
    dispatch: async (request) => {
      const path = new URL(request.url).pathname;
      events.push(`${request.method} ${path}`);
      if (path === '/_pb/projects/alpha/packages')
        return response({
          items: [{ id: 'repository-package', name: 'matrix-joined-repository' }],
        });
      if (path === '/_pb/projects/alpha/packages/repository-package/readme') {
        assert.equal(new URL(request.url).searchParams.get('version'), '1.0.0');
        return response({ body: broken === 'readme' ? '' : '# Joined repository fixture\n' });
      }
      if (path === '/_pb/sources' && request.method === 'POST')
        return response({ id: 'source' }, 201);
      if (path === '/_pb/trusted-publishers' && request.method === 'POST') {
        trusted = true;
        return response({ id: 'publisher', revision: 1 }, 201);
      }
      if (path.startsWith('/_pb/trusted-publishers/')) {
        disabled = true;
        return new Response(null, { status: 204 });
      }
      if (path.includes('/oidc/token/exchange/')) {
        if (!trusted || exchanged || disabled) return response({}, 403);
        exchanged = true;
        return response({ token: workloadToken }, 201);
      }
      if (path.endsWith('/names')) return response({}, 201);
      if (path === '/_pb/publishes') return response({ items: [...items.values()] });
      if (path.startsWith('/_pb/publishes/')) {
        const [, , , id, action] = path.split('/');
        const item = items.get(id);
        if (!action) {
          const etag = `"r${item.revision}"`;
          if (!issued.has(id)) issued.set(id, new Set());
          issued.get(id).add(etag);
          if (item.scanState === 'running' && !firstRunning.has(id)) firstRunning.set(id, etag);
          return response(item, 200, item.revision);
        }
        if (action === 'rescan')
          assert.ok(
            issued.get(id).has(request.headers.get('if-match')),
            'Rescan must use issued ETag',
          );
        if (request.headers.get('if-match') !== `"r${item.revision}"`) {
          assert.equal(request.headers.get('if-match'), firstRunning.get(id));
          return response({}, 412);
        }
        if (action === 'approve') item.approvalState = 'approved';
        else item.scanState = 'queued';
        item.revision++;
        return response(item, 200, item.revision);
      }
      if (path.endsWith('/sync')) return new Response(null, { status: 202 });
      return new Response(null, { status: 204 });
    },
  };
  return {
    broker,
    repositoryTag: () => events.push('repository tag created'),
    origin: 'https://broker.test',
    scanner: (name, mode) => {
      events.push(`scan ${name} ${mode}`);
      modes.set(name, mode);
    },
    publish: async (name, token, expected = true) => {
      events.push(`publish ${name} ${token === workloadToken ? 'workload' : token}`);
      const allowed = token !== workloadToken || (name === 'matrix-joined-workload' && !disabled);
      assert.equal(allowed, expected);
      if (!allowed) return;
      const scanOnly = ['matrix-joined-workload', 'matrix-joined-scan-only-failure'].includes(name);
      items.set(name, {
        id: name,
        packageName: name,
        revision: 1,
        approvalState: scanOnly ? 'not_required' : 'pending',
        scanState: 'queued',
        scanAttempts: 0,
      });
    },
    install: async (name, expected) => {
      events.push(`install ${name} ${expected}`);
      const item = items.get(name);
      const visible =
        name === 'matrix-joined-repository' ||
        (item.scanState === 'allowed' && item.approvalState !== 'pending');
      assert.equal(visible, expected);
      if (!expected && item && item.scanState !== 'failed') {
        item.revision++;
        if (broken === 'approval-state') item.scanState = 'allowed';
        if (broken === 'approval-attempts') item.scanAttempts = 2;
      }
      if (broken === 'install' && expected) throw new Error('native install failed');
    },
    events,
  };
}

test('joined journeys use public setup, both completion orders, failed recovery, workload publish and repository build', async () => {
  const f = fixture();
  assertJoinedEvidence(await runJoinedJourneys(f));
  assert.ok(f.events.includes('POST /_pb/trusted-publishers'));
  assert.ok(f.events.includes('publish matrix-joined-workload workload'));
  assert.ok(f.events.includes('publish matrix-joined-wrong-binding workload'));
  assert.equal(
    f.events.filter((event) => event === 'publish matrix-joined-workload workload').length,
    2,
  );
  for (const journey of ['failed-scan', 'scan-only-failure'])
    assert.equal(
      f.events.filter((event) => event === `POST /_pb/publishes/matrix-joined-${journey}/rescan`)
        .length,
      2,
    );
  for (const [journey, first, second] of [
    [
      'approval-first',
      'POST /_pb/publishes/matrix-joined-approval-first/approve',
      'scan matrix-joined-approval-first allow',
    ],
    [
      'scan-first',
      'scan matrix-joined-scan-first allow',
      'POST /_pb/publishes/matrix-joined-scan-first/approve',
    ],
    [
      'failed-scan',
      'POST /_pb/publishes/matrix-joined-failed-scan/approve',
      'scan matrix-joined-failed-scan fail',
    ],
  ]) {
    assert.ok(f.events.indexOf(first) >= 0, journey);
    assert.ok(f.events.indexOf(second) > f.events.indexOf(first), journey);
  }
  assert.ok(
    f.events.indexOf('POST /_pb/sources/source/sync') > f.events.indexOf('repository tag created'),
  );
  assert.ok(f.events.includes('repository tag created'));
  for (const name of ['approval-first', 'scan-first', 'failed-scan', 'scan-only-failure']) {
    assert.ok(f.events.includes(`install matrix-joined-${name} false`));
    assert.ok(f.events.includes(`install matrix-joined-${name} true`));
  }
});

for (const [broken, message] of [
  ['install', 'native install failed'],
  ['build', 'Registered repository build did not complete'],
  ['refetchable', 'Repository archive must not be refetchable'],
  ['attempts', 'Scan did not exhaust its attempts'],
  ['readme', 'Repository README differs'],
  ['approval-state', 'Scan state changed before approval'],
  ['approval-attempts', 'Scan attempts changed before approval'],
])
  test(`joined gate fails when ${broken} evidence is broken`, async () => {
    await assert.rejects(() => runJoinedJourneys(fixture(broken)), { message });
  });

test('scanner fixture reads the staged bytes and propagates failure and cancellation', async () => {
  const { default: scanner } = await import('../fixtures/client-matrix-scanner.mjs');
  const { createJoinedFixture } = await import('./client-matrix-joined-fixture.mjs');
  const fixture = createJoinedFixture([]);
  const policy = scanner(fixture.fetch).publishPolicy;
  const input = {
    name: 'matrix-joined-fixture',
    sizeBytes: 3,
    signal: new AbortController().signal,
    openTarball: async () => new Blob(['abc']).stream(),
  };
  fixture.scanner(input.name, 'allow');
  assert.deepEqual(await policy.inspect({}, input), { verdict: 'allow' });
  await assert.rejects(() => policy.inspect({}, { ...input, sizeBytes: 4 }), /fixture_scan_size/);
  fixture.scanner(input.name, 'fail');
  await assert.rejects(() => policy.inspect({}, input), /fixture_scan_failure/);
  fixture.scanner(input.name, 'hold');
  const controller = new AbortController();
  const pending = policy.inspect({}, { ...input, signal: controller.signal });
  controller.abort();
  await assert.rejects(() => pending);
});

test('GitHub fixture restricts credentials and serves a real tag and repository archive', async () => {
  const { createJoinedFixture } = await import('./client-matrix-joined-fixture.mjs');
  const { gunzipSync } = await import('node:zlib');
  const fixture = createJoinedFixture([]);
  const request = (path) =>
    new Request('https://api.github.com' + path, {
      headers: { authorization: 'Bearer matrix-github-fixture-token' },
    });
  fixture.tag();
  const tags = await (await fixture.fetch(request('/repos/fixture/repository/tags'))).json();
  assert.equal(tags[0].name, 'v1.0.0');
  const archive = await fixture.fetch(
    request(`/repos/fixture/repository/tarball/${tags[0].commit.sha}`),
  );
  const bytes = gunzipSync(Buffer.from(await archive.arrayBuffer()));
  assert.ok(bytes.includes(Buffer.from('repository/package.json')));
  assert.ok(bytes.includes(Buffer.from('"name":"matrix-joined-repository"')));
  assert.ok(bytes.includes(Buffer.from('module.exports = true;\n')));
  await assert.rejects(() =>
    fixture.fetch(new Request('https://api.github.com/repos/fixture/repository')),
  );
  await assert.rejects(() =>
    fixture.fetch(
      new Request('https://registry.npmjs.org/matrix-joined-workload', {
        headers: { authorization: 'Bearer matrix-github-fixture-token' },
      }),
    ),
  );
});

test('joined GitHub fixture drives the production provider through tag enumeration and manifest parsing', async () => {
  const { default: github } = await import('../packages/plugin-github/dist/index.js');
  const { createJoinedFixture } = await import('./client-matrix-joined-fixture.mjs');
  const fixture = createJoinedFixture([]);
  fixture.tag();
  const [provider] = github().sourceProviders();
  const ctx = {
    org: { orgId: 'fixture' },
    signal: new AbortController().signal,
    clock: { now: () => new Date() },
    credential: {
      apply(headers, url) {
        headers.set('authorization', 'Bearer matrix-github-fixture-token');
        return { headers, url };
      },
    },
    fetch: async (input) =>
      fixture.fetch(
        new Request(input.url, {
          method: input.method,
          headers: input.credential.apply(new Headers(input.headers), new URL(input.url)).headers,
          ...(input.body ? { body: input.body } : {}),
        }),
      ),
  };
  const source = {
    id: 'fixture',
    ecosystem: 'npm',
    type: 'vcs',
    url: null,
    config: {
      provider: 'github',
      repository: 'fixture/repository',
      packageName: 'matrix-joined-repository',
      refs: { tags: true, branches: [] },
    },
  };
  assert.deepEqual((await provider.listPackages(ctx, source, null)).names, [
    'matrix-joined-repository',
  ]);
  const result = await provider.describe(ctx, source, 'matrix-joined-repository', {});
  assert.equal(result.kind, 'found');
  const versions = await Array.fromAsync(result.description.members);
  assert.equal(versions.length, 1);
  assert.equal(versions[0].version, '1.0.0');
});

test('joined seed starts without a trusted binding or seeded build and its evidence queries execute on SQLite', async () => {
  const { seed } = await import('./client-matrix-runtime.mjs');
  const { openMigratedDatabase } =
    await import('../packages/db-sqlite/dist/testing/migrated-database.js');
  const database = await openMigratedDatabase();
  try {
    const broker = await seed(database.executor, { joined: true });
    const rows = await database.executor.all({
      sql: 'SELECT id FROM trusted_publisher WHERE org_id=?',
      params: [broker.orgId],
    });
    assert.deepEqual(rows, []);
    assert.deepEqual(await broker.inspectRepositoryBuild('missing-source'), []);
    await database.executor.batch([
      {
        sql: "INSERT INTO source (id,org_id,name,ecosystem,type) VALUES ('dead-source',?,'Dead','npm','vcs')",
        params: [broker.orgId],
      },
      {
        sql: "INSERT INTO job (id,org_id,type,payload_json,state) VALUES ('dead-job',?,'core:npm-vcs-build:v1',?,'dead')",
        params: [
          broker.orgId,
          JSON.stringify({ sourceId: 'dead-source', versionId: 'missing-version' }),
        ],
      },
    ]);
    assert.deepEqual(await broker.inspectRepositoryBuild('dead-source'), [
      { status: 'dead', refetchable: null },
    ]);
    assert.match((await broker.backendVersion())[0].version, /^\d+\.\d+\.\d+/);
  } finally {
    await database.close();
  }
});

test('scanner holds have a deadline and dispose releases every pending hold', async () => {
  const { createJoinedFixture } = await import('./client-matrix-joined-fixture.mjs');
  const timed = createJoinedFixture([], { holdTimeoutMs: 1 });
  timed.scanner('timed', 'hold');
  await assert.rejects(() => timed.fetch(new Request('https://scanner.matrix.test/timed')), {
    message: 'Joined scanner hold timed out',
  });
  assert.throws(() => timed.assertHealthy(), /Joined fixture assertion failed/);
  const f = createJoinedFixture([]);
  const pending = ['one', 'two'].map((name) => {
    f.scanner(name, 'hold');
    return f.fetch(new Request(`https://scanner.matrix.test/${name}`));
  });
  f.dispose();
  assert.deepEqual(
    (await Promise.all(pending)).map((r) => r.status),
    [503, 503],
  );
  f.assertHealthy();
});

test('fixture health retains swallowed scanner, GitHub and probe assertion failures', async () => {
  const { createJoinedFixture } = await import('./client-matrix-joined-fixture.mjs');
  for (const [url, headers] of [
    ['https://scanner.matrix.test/pkg', { authorization: 'secret' }],
    ['https://scanner.matrix.test/pkg', { cookie: 'secret' }],
    ['https://api.github.com/repos/fixture/repository', {}],
    [
      'https://api.github.com/repos/fixture/repository',
      { authorization: 'Bearer matrix-github-fixture-token', cookie: 'secret' },
    ],
    ['https://registry.npmjs.org/matrix-joined-workload', { authorization: 'secret' }],
  ]) {
    const f = createJoinedFixture([]);
    await f
      .fetch(
        new Request(url, { headers, method: url.includes('registry.npmjs.org') ? 'HEAD' : 'GET' }),
      )
      .catch(() => {});
    assert.throws(() => f.assertHealthy(), { message: 'Joined fixture assertion failed' });
  }
});

test('tag listing evidence requires a request after tag exposure', async () => {
  const { createJoinedFixture } = await import('./client-matrix-joined-fixture.mjs');
  const f = createJoinedFixture([]);
  const request = () =>
    new Request('https://api.github.com/repos/fixture/repository/tags', {
      headers: { authorization: 'Bearer matrix-github-fixture-token' },
    });
  await f.fetch(request());
  assert.throws(() => f.assertTagListing(), /Repository tag listing after exposure missing/);
  f.tag();
  assert.throws(() => f.assertTagListing(), /Repository tag listing after exposure missing/);
  await f.fetch(request());
  f.assertTagListing();
  f.assertHealthy();
});

test('acceptance identity refuses dirty HEAD and records gate run identity and built inputs', async () => {
  const { acceptanceIdentity, fingerprintBuiltInputs } =
    await import('./client-matrix-runtime.mjs');
  const { createHash } = await import('node:crypto');
  const { readFile } = await import('node:fs/promises');
  const inputs = await fingerprintBuiltInputs();
  const entry = 'packages/plugin-github/dist/index.js';
  assert.equal(
    inputs[entry],
    createHash('sha256')
      .update(await readFile(entry))
      .digest('hex'),
  );
  const dirty = acceptanceIdentity('abc\n', ' M scripts/client-matrix-runtime.mjs', inputs, {
    PB_GATE_RUN_ID: 'gate',
    GITHUB_RUN_ID: 'github',
  });
  assert.equal(dirty.acceptance, false);
  assert.equal(dirty.reason, 'Working tree is dirty');
  assert.equal(dirty.head, 'abc');
  assert.equal(dirty.runId, 'gate');
  assert.equal(dirty.builtInputs, inputs);
  assert.equal(acceptanceIdentity('abc', '', inputs, { GITHUB_RUN_ID: 'github' }).runId, 'github');
  assert.equal(acceptanceIdentity('abc', '', inputs, {}).acceptance, true);
});

test('joined consumers preserve prepared version and packageManager and verify the native client version', async () => {
  const { configureJoinedConsumer, verifyClientVersion } =
    await import('./client-matrix-runtime.mjs');
  const { prepareClient, CLIENT_VERSIONS } = await import('./client-matrix.mjs');
  const { mkdir, mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  await mkdir('.pb', { recursive: true });
  const directory = await mkdtemp('.pb/joined-client-test-');
  try {
    for (const client of ['npm', 'pnpm', 'yarn']) {
      const prepared = await prepareClient(
        join(directory, client),
        client,
        'http://127.0.0.1/alpha/npm/',
        'fixture',
      );
      const path = join(prepared.project, 'package.json');
      const before = JSON.parse(await readFile(path, 'utf8'));
      await configureJoinedConsumer(prepared, 'joined-package');
      const after = JSON.parse(await readFile(path, 'utf8'));
      assert.equal(after.version, before.version);
      assert.equal(after.packageManager, before.packageManager);
      assert.deepEqual(after.dependencies, { 'joined-package': '1.0.0' });
      const workspace = await readFile(join(prepared.project, 'pnpm-workspace.yaml'), 'utf8');
      assert.doesNotMatch(workspace, /^\{/);
      assert.match(workspace, /^ignoreScripts: true$/m);
      assert.match(workspace, /^frozenLockfile: false$/m);
      const command = async (name, args, project, env) => {
        assert.equal(name, client);
        assert.deepEqual(args, ['--version']);
        assert.equal(project, prepared.project);
        assert.equal(env, prepared.env);
        return { code: 0, stdout: CLIENT_VERSIONS[client] + '\n' };
      };
      await verifyClientVersion(client, CLIENT_VERSIONS[client], prepared, {}, command);
      await assert.rejects(() => verifyClientVersion(client, '0.0.0', prepared, {}, command));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('built input fingerprint changes when an entry changes and excludes source files', async () => {
  const { fingerprintBuiltInputs } = await import('./client-matrix-runtime.mjs');
  const { mkdir, mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  await mkdir('.pb', { recursive: true });
  const directory = await mkdtemp('.pb/joined-input-test-');
  try {
    const dist = join(directory, 'packages/example/dist');
    await mkdir(dist, { recursive: true });
    await writeFile(join(dist, 'index.js'), 'export const value = 1;');
    const before = await fingerprintBuiltInputs(directory);
    assert.deepEqual(Object.keys(before), ['packages/example/dist/index.js']);
    await writeFile(join(directory, 'packages/example/source.js'), 'source');
    assert.deepEqual(await fingerprintBuiltInputs(directory), before);
    await writeFile(join(dist, 'index.js'), 'export const value = 2;');
    assert.notDeepEqual(await fingerprintBuiltInputs(directory), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('block YAML writes one top-level key per line with block sequences', async () => {
  const { blockYaml } = await import('./client-matrix-runtime.mjs');
  assert.equal(
    blockYaml({ packages: [], storeDir: '/a b', fetchRetries: 0, exclude: ['x', 'y'] }),
    'packages: []\nstoreDir: "/a b"\nfetchRetries: 0\nexclude:\n  - "x"\n  - "y"\n',
  );
});
