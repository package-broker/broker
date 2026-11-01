import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { envelopeResponse } from '@package-broker/core/kernel/errors';
import { smoke } from './smoke.js';
import { resolveLocalAuth } from './local-auth.js';
import { readProvidersOption } from './providers-file.js';
import { teardown } from './teardown.js';
import { stageAssets } from '../../build-assets.js';
import { CloudflareApi, CloudflareError, object } from './api.js';
import {
  assertLocalAuthAccepted,
  deploy,
  tracesMetadata,
  cloudflareDeployContract,
  cloudflareAssetHash,
  validateDeploymentArtifact,
  withCandidatePreview,
  rollbackDeployment,
  runCloudflareDeploy,
  type DeployOptions,
  type DeployProviderContract,
} from './deploy.js';
import {
  digest,
  emptyInventory,
  installIdentity,
  InventoryStore,
  type Distribution,
  type ManagedSettings,
} from './inventory.js';

const providerFixtures = JSON.parse(
  await readFile(new URL('./fixtures/provider-responses.json', import.meta.url), 'utf8'),
);
const ACCOUNT = 'a'.repeat(32),
  KEY = 'MASTER_SENTINEL',
  PREVIOUS = 'PREVIOUS_SENTINEL',
  TOKEN = 'API_SENTINEL';
const CREATED = '66666666-6666-4666-8666-666666666666';
const documented = JSON.parse(
  await readFile(new URL('./fixtures/deploy-responses.json', import.meta.url), 'utf8'),
);
const realConsumer = JSON.parse(
  await readFile(new URL('./fixtures/queue-consumer.json', import.meta.url), 'utf8'),
);
const realWorkerSettings = JSON.parse(
  await readFile(new URL('./fixtures/worker-settings.json', import.meta.url), 'utf8'),
);
const OLD = '11111111-1111-4111-8111-111111111111',
  CANDIDATE = '22222222-2222-4222-8222-222222222222',
  NEWEST = '33333333-3333-4333-8333-333333333333',
  THIRD = '55555555-5555-4555-8555-555555555555';
const DB = '44444444-4444-4444-8444-444444444444',
  JOBS = 'b'.repeat(32),
  DLQ = 'c'.repeat(32),
  ZONE = 'd'.repeat(32);
const identity = installIdentity({ accountId: ACCOUNT, workerName: 'broker' });
const script = identity.script_name,
  base = `/workers/scripts/${script}`;
const ports = {
  blob: { adapter: 'r2', binding: 'STORAGE', maxBytes: 50_000_000 },
  cache: { adapter: 'cache-api', namespace: 'pb-metadata-v1' },
  jobs: { adapter: 'queues', binding: 'JOBS', maxRunning: 2 },
  observability: {
    adapter: 'workers',
    analyticsBinding: 'ANALYTICS',
    deploymentIdEnv: 'DEPLOYMENT_ID',
  },
};
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
let project: string, out: string, store: InventoryStore;
const fixtureContract: DeployProviderContract = {
  versionsCreateScript: true,
  secretInheritance: true,
  assetHash: sha,
  domainZone: async () => ZONE,
  preview: async (_api, _script, version) => ({
    version_id: version,
    url: `https://${version.slice(0, 8).toLowerCase()}-${script}.account.workers.dev`,
    bindings_verified: true,
  }),
};
async function artifact() {
  await mkdir(join(out, 'generated'), { recursive: true });
  await mkdir(join(out, 'migrations/core'), { recursive: true });
  await writeFile(join(out, 'migrations/core/0001_init.sql'), '-- fixture migration\n');
  await writeFile(
    join(out, 'worker.js'),
    'export default { fetch() { return new Response("ok") } };',
  );
  await writeFile(
    join(out, 'generated/manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      platform: 'cloudflare',
      platformPorts: ports,
      plugins: [],
      bindings: [],
      migrations: [
        {
          id: 'core:0001_init',
          name: '0001_init.sql',
          checksum: digest('-- fixture migration\n'),
          phase: 'expand',
        },
      ],
      routes: [],
    }),
  );
  await writeFile(
    join(out, 'build-info.json'),
    JSON.stringify({
      schemaVersion: 1,
      target: 'cloudflare',
      core: '2.0.0',
      plugins: {},
      lockfileSha256: null,
      gitSha: null,
    }),
  );
  const html = Buffer.from('<script src="/app.1234.js"></script>');
  const js = Buffer.from([0, 128, 255, 42]);
  const manifest = Buffer.from(
    JSON.stringify({
      version: 1,
      entry: 'index.html',
      files: {
        'index.html': { bytes: html.length, contentType: 'text/html' },
        'app.1234.js': { bytes: js.length, contentType: 'text/javascript' },
      },
    }),
  );
  const files = [
    { name: 'manifest.json', content: manifest },
    { name: 'app.1234.js', content: js },
    { name: 'index.html', content: html },
  ];
  await stageAssets(out, {
    record: {
      schemaVersion: 1,
      provider: { specifier: '@package-broker/ui-assets', version: '2.0.0' },
      digest: `sha256:${digest(JSON.stringify(files.map((f) => [f.name, sha(f.content)])))}`,
      descriptor: {
        directory: './assets',
        binding: 'ASSETS',
        run_worker_first: true,
        html_handling: 'none',
        not_found_handling: 'none',
      },
    },
    files,
  });
}
beforeEach(async () => {
  await mkdir('.pb', { recursive: true });
  project = await mkdtemp(resolve('.pb/deploy-test-'));
  out = join(project, '.pb/cloudflare');
  await artifact();
  store = await InventoryStore.create({ project, outDir: out, identity });
  const j = emptyInventory(identity, Date.now());
  j.migrations.ledger = [
    { id: 'core:0001_init', checksum: digest('-- fixture migration\n'), phase: 'expand' },
  ];
  for (const [key, id] of [
    ['d1', DB],
    ['r2', `${script}-blobs`],
    ['jobs', JOBS],
    ['dlq', DLQ],
  ] as const)
    j.resources[key] = {
      name:
        key === 'd1'
          ? `${script}-db`
          : key === 'r2'
            ? `${script}-blobs`
            : key === 'jobs'
              ? `${script}-jobs`
              : `${script}-jobs-dlq`,
      id,
      state: 'complete',
      ...(key === 'd1' || key === 'r2' ? { jurisdiction: 'eu' as const } : {}),
      evidence: { source: 'adopted', operation_id: null, verified_at: new Date().toISOString() },
    };
  j.resources.analytics = {
    name: 'broker_production_metrics',
    id: null,
    state: 'binding_pending',
    evidence: null,
  };
  await store.write(j);
});
afterEach(async () => {
  await rm(project, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function snap(result: unknown) {
  return new Response(JSON.stringify({ success: true, result }));
}
function ok(result: unknown, result_info: unknown = { total_pages: 1 }) {
  return new Response(JSON.stringify({ success: true, result, result_info }));
}
function harness() {
  let clock = Date.now(),
    uploads = 0;
  const h = {
    exists: true,
    active: { id: 'active-prior', versions: [{ version_id: OLD, percentage: 100 }] } as {
      id: string | null;
      versions: Distribution[];
    },
    endpoints: { enabled: true, previews_enabled: true },
    schedules: [] as string[],
    consumer: null as ManagedSettings['consumer'],
    routes: [] as Record<string, unknown>[],
    domain: null as Record<string, unknown> | null,
    installed: ['PB_MASTER_KEY', 'PB_MASTER_KEY_PREVIOUS'],
    versions: new Map<string, Record<string, unknown>>([
      [OLD, { id: OLD, annotations: {}, resources: { bindings: [] } }],
      [NEWEST, { id: NEWEST, annotations: {}, resources: { bindings: [] } }],
    ]),
    calls: [] as { path: string; method: string; body: unknown; auth: string | null }[],
    settingsVersion: null as string | null,
    uploadLost: false,
    uploadAbsent: false,
    activationLost: false,
    activationAbsent: false,
    activationReject: false,
    configFail: false,
    drift: false,
    cleanupFail: false,
    subdomain: 'account' as string | null,
    bindingDrift: false,
    secretErased: false,
    maintainedShell: false,
    sessionManifest: {} as Record<string, { hash: string; size: number }>,
    metadata: null as Record<string, unknown> | null,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    fetch: undefined as unknown as typeof fetch,
  };
  h.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input)),
      path = url.pathname.replace(`/client/v4/accounts/${ACCOUNT}`, '').replace('/client/v4', '');
    const method = init?.method ?? 'GET',
      body =
        init?.body instanceof FormData
          ? init.body
          : init?.body
            ? JSON.parse(String(init.body))
            : undefined;
    if (
      path === `/d1/database/${DB}/query` &&
      body.batch === undefined &&
      typeof body.sql === 'string' &&
      /^\s*select\b[^;]*;?\s*$/i.test(body.sql)
    )
      return ok([{ success: true, results: [], meta: { changes: 0 } }]);
    h.calls.push({ path, method, body, auth: new Headers(init?.headers).get('authorization') });
    if (method === 'DELETE') throw new Error('forbidden deletion');
    if (path === '/workers/scripts')
      return snap(
        h.exists
          ? [{ id: script, tags: ['pb-install-v1', `pb-owner-${identity.owner_digest}`] }]
          : [],
      );
    if (path === '/d1/database/' + DB)
      return ok({ uuid: DB, id: DB, name: `${script}-db`, jurisdiction: 'eu' });
    if (path === `/r2/buckets/${script}-blobs`) {
      expect(new Headers(init?.headers).get('cf-r2-jurisdiction')).toBe('eu');
      expect(url.searchParams.has('jurisdiction')).toBe(false);
      return ok({ name: `${script}-blobs`, jurisdiction: 'eu' });
    }
    if (path === '/queues/' + JOBS) return ok({ queue_id: JOBS, queue_name: `${script}-jobs` });
    if (path === '/queues/' + DLQ) return ok({ queue_id: DLQ, queue_name: `${script}-jobs-dlq` });
    if (path === `/queues/${DLQ}/consumers`) return snap([]);
    if (path.startsWith(`/queues/${JOBS}/consumers`)) {
      if (method === 'GET')
        return snap(
          h.consumer
            ? [
                {
                  type: 'worker',
                  consumer_id: h.consumer.consumer_id,
                  script_name: h.consumer.script_name,
                  dead_letter_queue: h.consumer.dead_letter_queue,
                  settings: {
                    batch_size: h.consumer.batch_size,
                    max_wait_time_ms: h.consumer.max_wait_time_ms,
                    max_retries: h.consumer.max_retries,
                    max_concurrency: h.consumer.max_concurrency,
                  },
                },
              ]
            : [],
        );
      h.consumer = {
        consumer_id: 'managed-consumer',
        script_name: body.script_name,
        dead_letter_queue: body.dead_letter_queue,
        ...body.settings,
      };
      return ok({ consumer_id: 'managed-consumer' });
    }
    if (path === '/workers/subdomain') return ok({ subdomain: h.subdomain });
    if (path === base + '/deployments') {
      if (method === 'GET')
        return new Response(
          JSON.stringify({
            ...documented.deployments,
            result: {
              deployments: h.active.id
                ? [
                    h.active,
                    { id: 'older-deployment', versions: [{ version_id: NEWEST, percentage: 100 }] },
                  ]
                : [],
            },
          }),
        );
      if (h.activationReject) return new Response(TOKEN, { status: 403 });
      if (!h.activationAbsent) h.active = { id: 'candidate-active', versions: body.versions };
      if (h.activationLost) throw new Error(TOKEN);
      return ok(h.active);
    }
    if (path === base + '/settings') {
      if (!h.exists)
        return new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 10007, message: 'Worker not found' }],
          }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        );
      const current = h.versions.get(h.settingsVersion ?? h.active.versions[0]?.version_id ?? '');
      const currentBindings = (current?.resources as { bindings: unknown[] } | undefined)?.bindings;
      return ok({
        tags: [
          'pb-install-v1',
          `pb-owner-${identity.owner_digest}`,
          ...(h.bindingDrift && h.metadata ? ['foreign-change'] : []),
        ],
        bindings: currentBindings?.length ? currentBindings : [{ type: 'd1', name: 'DB', id: DB }],
      });
    }
    if (path === base + '/secrets')
      return snap(h.installed.map((name) => ({ name, type: 'secret_text' })));
    if (path === base + '/subdomain') {
      if (method !== 'GET') {
        if (h.cleanupFail && body.previews_enabled === false)
          return new Response(TOKEN, { status: 403 });
        h.endpoints = body;
      }
      return ok(h.endpoints);
    }
    if (path === base + '/schedules') {
      if (method !== 'GET') {
        if (h.configFail) return new Response(TOKEN, { status: 403 });
        h.schedules = body.map((s: { cron: string }) => s.cron);
      }
      return ok({ schedules: h.schedules.map((cron) => ({ cron })) });
    }
    if (path === '/workers/domains') {
      if (method !== 'GET') h.domain = { ...body, id: 'managed-domain' };
      return method === 'GET'
        ? new Response(
            JSON.stringify({
              ...providerFixtures.domainsEmpty,
              result: h.domain ? [h.domain] : [],
            }),
          )
        : ok(h.domain ? [h.domain] : []);
    }
    if (path === `/zones/${ZONE}/workers/routes`) {
      if (method !== 'GET') h.routes = [{ ...body, id: 'managed-route' }];
      return method === 'GET'
        ? new Response(JSON.stringify({ ...providerFixtures.zoneRoutesEmpty, result: h.routes }))
        : ok(h.routes);
    }
    if (path === base + '/assets-upload-session') {
      h.sessionManifest = body.manifest;
      return ok({
        jwt: 'SESSION_SENTINEL',
        buckets: [Object.values(body.manifest).map((v) => (v as { hash: string }).hash)],
      });
    }
    if (path === '/workers/assets/upload') return ok({ jwt: 'COMPLETION_SENTINEL' });
    if (path === base && method === 'PUT') {
      expect(h.exists).toBe(false);
      const metadata = JSON.parse(String((body as FormData).get('metadata')));
      h.exists = true;
      h.installed = metadata.bindings
        .filter((b: Record<string, unknown>) => b.type === 'secret_text')
        .map((b: Record<string, string>) => b.name);
      h.active = { id: 'created-deployment', versions: [{ version_id: CREATED, percentage: 100 }] };
      h.versions.set(CREATED, {
        id: CREATED,
        annotations: metadata.annotations,
        resources: {
          bindings: metadata.bindings.map((b: Record<string, unknown>) =>
            b.type === 'secret_text' ? { type: b.type, name: b.name } : b,
          ),
          assets: { config: metadata.assets.config },
          script_runtime: {
            compatibility_date: '2026-10-01',
            compatibility_flags: ['nodejs_compat'],
          },
        },
      });
      return ok({ ...documented.scriptCreated.result, id: script });
    }
    if (path === base + '/versions' && method === 'POST') {
      const candidate = [CANDIDATE, NEWEST, THIRD][uploads++]!;
      expect(body).toBeInstanceOf(FormData);
      h.metadata = JSON.parse(String(body.get('metadata')));
      h.exists = true;
      const bindings = [...(h.metadata!.bindings as Record<string, unknown>[])].map((b) =>
        b.type === 'secret_text' ? { type: b.type, name: b.name } : b,
      );
      if (h.metadata!.keep_bindings)
        for (const name of h.installed)
          if (!bindings.some((b) => b.name === name)) bindings.push({ type: 'secret_text', name });
      if (!h.uploadAbsent)
        h.versions.set(candidate, {
          id: candidate,
          annotations: h.metadata!.annotations,
          resources: {
            bindings: h.secretErased
              ? bindings.filter((b) => b.name !== 'PB_MASTER_KEY')
              : bindings,
            assets: { config: (h.metadata!.assets as { config: unknown }).config },
            script_runtime: {
              compatibility_date: '2026-10-01',
              compatibility_flags: ['nodejs_compat'],
            },
          },
        });
      if (h.drift)
        h.active = { id: 'other-deploy', versions: [{ version_id: NEWEST, percentage: 100 }] };
      if (h.uploadLost) throw new Error(`${KEY} ${TOKEN}`);
      return ok({ ...documented.versionUploaded.result, id: candidate });
    }
    if (path === base + '/versions') {
      const items = [...h.versions.values()];
      return ok(
        { items },
        { page: 1, per_page: 10, count: items.length, total_count: items.length },
      );
    }
    if (path.startsWith(base + '/versions/'))
      return ok(h.versions.get(path.split('/').at(-1)!) ?? {});
    throw new Error(`Unexpected request ${method} ${path}`);
  }) as typeof fetch;
  return h;
}
function options(h: ReturnType<typeof harness>, extra: Partial<DeployOptions> = {}): DeployOptions {
  return {
    workerName: 'broker',
    project,
    outDir: out,
    domain: 'broker.example.test',
    env: {
      CLOUDFLARE_API_TOKEN: TOKEN,
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      PB_MASTER_KEY: KEY,
      PB_MASTER_KEY_PREVIOUS: PREVIOUS,
      PB_IDP_TEST_CLIENT_SECRET: 'IDP_SENTINEL',
    },
    fetch: h.fetch,
    now: h.now,
    sleep: h.sleep,
    contract: fixtureContract,
    ...extra,
  };
}
const mutations = (h: ReturnType<typeof harness>) => h.calls.filter((c) => c.method !== 'GET');

it('refuses pending expand migrations before provider calls', async () => {
  const j = (await store.read())!;
  j.migrations.ledger = [];
  await store.write(j);
  const before = await readFile(store.path, 'utf8');
  const h = harness();
  const result = await deploy(options(h));
  expect(result).toMatchObject({
    exitCode: 2,
    output: {
      status: 'error',
      error: {
        code: 'migrations_pending',
        stage: 'deploy',
        retryable: false,
        message: expect.stringContaining('pb cloudflare migrate'),
      },
    },
  });
  expect(h.calls).toHaveLength(0);
  expect(await readFile(store.path, 'utf8')).toBe(before);
});

it('plans pending expand migrations and deployment on dry run without mutations or state changes', async () => {
  const j = (await store.read())!;
  j.migrations.ledger = [];
  await store.write(j);
  const before = await readFile(store.path, 'utf8');
  const filesBefore = await readdir(store.directory);
  const h = harness();
  expect(await deploy(options(h, { dryRun: true }))).toMatchObject({
    exitCode: 0,
    output: {
      status: 'planned',
      error: null,
      pending_migrations: ['core:0001_init'],
      worker_url: 'https://broker.example.test',
      plan: [
        { stage: 'migrate', action: 'apply', name: 'core:0001_init', kind: 'expand' },
        { stage: 'deploy', action: 'upload_activate' },
      ],
      checks: expect.arrayContaining([{ name: 'provider_semantics', status: 'injected' }]),
    },
  });
  expect(h.calls.length).toBeGreaterThan(0);
  expect(mutations(h)).toEqual([]);
  expect(await readFile(store.path, 'utf8')).toBe(before);
  expect(await readdir(store.directory)).toEqual(filesBefore);
});

it.each(['pending', 'drift', 'dry-run drift', 'dry-run pending'])(
  'handles contract migrations: %s',
  async (mode) => {
    const sql = '-- pb:phase contract\n-- contract fixture\n';
    const file = join(out, 'generated/manifest.json');
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    manifest.migrations.push({
      id: 'core:0002_contract',
      name: '0002_contract.sql',
      checksum: digest(sql),
      phase: 'contract',
    });
    await writeFile(join(out, 'migrations/core/0002_contract.sql'), sql);
    await writeFile(file, JSON.stringify(manifest));
    if (mode.includes('drift')) {
      const j = (await store.read())!;
      j.migrations.ledger.push({
        id: 'core:0002_contract',
        checksum: digest('different'),
        phase: 'contract',
      });
      await store.write(j);
    }
    const before = await readFile(store.path, 'utf8');
    const h = harness();
    const result = await deploy(options(h, { dryRun: mode.startsWith('dry-run') }));
    if (mode.includes('drift')) {
      expect(result).toMatchObject({
        exitCode: 2,
        output: { error: { code: 'migrations_pending' } },
      });
      expect(h.calls).toHaveLength(0);
      expect(await readFile(store.path, 'utf8')).toBe(before);
    } else {
      expect(result).toMatchObject({ exitCode: 0, output: { error: null } });
      expect(result.output.checks).toContainEqual({
        name: 'core:0002_contract',
        status: 'warning',
        source:
          'Pending contract migration requires pb cloudflare migrate --allow-contract core:0002_contract.',
      });
      if (mode === 'pending') expect(mutations(h).length).toBeGreaterThan(0);
      else expect(await readFile(store.path, 'utf8')).toBe(before);
    }
  },
);

it.each(['pending', 'checksum drift', 'dry-run checksum drift'])(
  'refuses a later plugin migration with %s even when the core migration is applied',
  async (mode) => {
    const sql = '-- plugin migration\n';
    const file = join(out, 'generated/manifest.json');
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    manifest.migrations.push({
      id: 'example:0001_init',
      name: '0001_init.sql',
      checksum: digest(sql),
      phase: 'expand',
    });
    await mkdir(join(out, 'migrations/example'), { recursive: true });
    await writeFile(join(out, 'migrations/example/0001_init.sql'), sql);
    await writeFile(file, JSON.stringify(manifest));
    if (mode.includes('checksum drift')) {
      const j = (await store.read())!;
      j.migrations.ledger.push({
        id: 'example:0001_init',
        checksum: digest('-- different plugin migration\n'),
        phase: 'expand',
      });
      await store.write(j);
    }
    const before = await readFile(store.path, 'utf8');
    const h = harness();
    const result = await deploy(options(h, { dryRun: mode.startsWith('dry-run') }));
    expect(result).toMatchObject({
      exitCode: 2,
      output: {
        error: {
          code: 'migrations_pending',
          message: expect.stringContaining('pb cloudflare migrate'),
        },
      },
    });
    expect(h.calls).toHaveLength(0);
    expect(await readFile(store.path, 'utf8')).toBe(before);
  },
);

it('deploys when every artifact migration is applied, allowing additional ledger entries', async () => {
  const j = (await store.read())!;
  j.migrations.ledger.unshift({
    id: 'retired:0001_init',
    checksum: digest('-- retired migration\n'),
    phase: 'expand',
  });
  await store.write(j);
  const h = harness();
  expect(await deploy(options(h))).toMatchObject({
    exitCode: 0,
    output: { error: null, version_id: CANDIDATE },
  });
  expect(h.calls.some((c) => c.path === base + '/versions' && c.method === 'POST')).toBe(true);
});

it('checks migrations before reusing a verified deployment receipt', async () => {
  const h = harness();
  expect((await deploy(options(h))).exitCode).toBe(0);
  const j = (await store.read())!;
  j.deployment!.attempt.phase = 'verified';
  j.deployment!.attempt.smoke = 'passed';
  j.migrations.ledger = [];
  await store.write(j);
  h.calls.length = 0;
  expect(await deploy(options(h))).toMatchObject({
    exitCode: 2,
    output: { error: { code: 'migrations_pending' } },
  });
  expect(h.calls).toHaveLength(0);
});

it.each([
  ['', 'no-extension', 'e3b0c44298fc1c149afbf4c8996fb924'],
  ['68656c6c6f', 'hello.txt', '129d0bf9c674d4cc340cf5f8feeb9f36'],
  ['68656c6c6f', 'nested/hello.html', '5deeda9d2277e0ed541bfc03adafb3cf'],
  ['0080ff2a', 'app.1234.js', '2bc926e0a131a6279c79f1e99279a6c8'],
])('hashes documented asset vector %s / %s', (hex, name, expected) => {
  expect(cloudflareAssetHash(Buffer.from(hex, 'hex'), name)).toBe(expected);
});
function firstInstall() {
  const h = harness();
  h.exists = false;
  h.active = { id: null, versions: [] };
  h.installed = [];
  h.endpoints = { enabled: false, previews_enabled: false };
  const o = options(h, { secret: ['PB_MASTER_KEY'] });
  delete o.contract;
  delete o.domain;
  return { h, o };
}
it('uses the production contract by default: adopts the created version and enables workers.dev', async () => {
  const { h, o } = firstInstall();
  expect(cloudflareDeployContract).toMatchObject({
    versionsCreateScript: false,
    secretInheritance: true,
  });
  expect(cloudflareDeployContract.preview).toBeTypeOf('function');
  const result = await deploy(o);
  expect(result.output.error).toBeNull();
  expect(result.output).toMatchObject({ version_id: CREATED, previous_version_id: null });
  const writes = mutations(h);
  const create = writes.findIndex((c) => c.path === base && c.method === 'PUT');
  const version = writes.findIndex((c) => c.path === base + '/versions' && c.method === 'POST');
  const deployment = writes.findIndex(
    (c) => c.path === base + '/deployments' && c.method === 'POST',
  );
  expect(create).toBeGreaterThan(-1);
  expect(version).toBe(-1);
  expect(deployment).toBeGreaterThan(create);
  expect(writes[deployment]!.body).toEqual({
    strategy: 'percentage',
    versions: [{ version_id: CREATED, percentage: 100 }],
  });
  for (const call of [writes[create]!]) {
    const form = call.body as FormData;
    expect(await (form.get('worker.js') as Blob).text()).toContain('export default');
    expect(JSON.parse(String(form.get('metadata')))).toMatchObject({
      main_module: 'worker.js',
      compatibility_date: '2026-10-01',
      compatibility_flags: ['nodejs_compat'],
      bindings: expect.arrayContaining([{ type: 'assets', name: 'ASSETS' }]),
      assets: { jwt: 'COMPLETION_SENTINEL' },
    });
  }
  const attempt = (await store.read())!.deployment!.attempt;
  expect(h.versions.get(CREATED)!.annotations).toEqual({
    'workers/tag': `pb-${attempt.operation_id}-create`,
    'workers/message': `pb-artifact-sha256:${attempt.artifact_sha256}`,
  });
  expect(attempt.previous_distribution).toEqual([]);
  expect(attempt.previous_deployment_id).toBeNull();
  expect(h.endpoints).toEqual({ enabled: true, previews_enabled: false });
  expect(result.output.checks).toContainEqual({
    name: 'endpoint_policy',
    status: 'verified',
    enabled: true,
    previews_enabled: false,
  });
  const enable = h.calls.findIndex(
    (c) =>
      c.path === base + '/subdomain' &&
      c.method === 'POST' &&
      (c.body as { enabled: boolean }).enabled,
  );
  expect(enable).toBeGreaterThan(create);
  expect(h.calls.slice(enable + 1)).toContainEqual(
    expect.objectContaining({
      path: base + '/subdomain',
      method: 'GET',
    }),
  );
});
function realConsumerReadback(h: ReturnType<typeof harness>, o: DeployOptions) {
  const send = o.fetch!;
  o.fetch = (async (input, init) => {
    const response = await send(input, init);
    if (
      (init?.method ?? 'GET') !== 'GET' ||
      !new URL(String(input)).pathname.endsWith(`/queues/${JOBS}/consumers`)
    )
      return response;
    return snap(
      h.consumer
        ? [
            {
              ...realConsumer,
              script: h.consumer.script_name,
              dead_letter_queue: h.consumer.dead_letter_queue,
              settings: {
                ...realConsumer.settings,
                batch_size: h.consumer.batch_size,
                max_wait_time_ms: h.consumer.max_wait_time_ms,
                max_retries: h.consumer.max_retries,
                max_concurrency: h.consumer.max_concurrency,
              },
            },
          ]
        : [],
    );
  }) as typeof fetch;
}
it('R8 reconciles the real consumer shape after a sent create without replaying it', async () => {
  const { h, o } = firstInstall();
  const send = o.fetch!;
  let loseConsumer = true;
  o.fetch = (async (input, init) => {
    const response = await send(input, init);
    if (loseConsumer && init?.method === 'POST' && String(input).endsWith('/consumers')) {
      loseConsumer = false;
      throw new Error('consumer acknowledgement lost');
    }
    return response;
  }) as typeof fetch;
  realConsumerReadback(h, o);
  const failed = await deploy(o);
  expect(failed.exitCode).not.toBe(0);
  expect(failed.output.checks).toContainEqual({
    name: 'configuration_restoration',
    status: 'incomplete_attachments_retained',
  });
  expect(failed.output.checks).not.toContainEqual({
    name: 'configuration_restoration',
    status: 'failed_or_unknown',
  });
  expect((await store.read())!.deployment!.attempt.changes).toContainEqual(
    expect.objectContaining({ kind: 'consumer', restoration: 'retained_first_install' }),
  );
  const result = await deploy(o);
  expect(result.output.error).toBeNull();
  expect(
    h.calls.filter((c) => c.path === `/queues/${JOBS}/consumers` && c.method === 'POST'),
  ).toHaveLength(1);
  expect(h.calls.filter((c) => c.path === base && c.method === 'PUT')).toHaveLength(1);
  expect(h.endpoints).toEqual({ enabled: true, previews_enabled: false });
});
it('R8 restores prior consumer limits with the real read-back shape', async () => {
  const h = harness();
  const o = options(h);
  realConsumerReadback(h, o);
  expect((await deploy(o)).exitCode).toBe(0);
  const j = (await store.read())!;
  j.deployment!.attempt.phase = 'verified';
  j.deployment!.attempt.smoke = 'passed';
  j.deployment!.attempt.prior_settings.schedules = [];
  j.deployment!.attempt.intended_settings.schedules = [];
  j.deployment!.attempt.intended_settings.consumer!.batch_size = 2;
  h.consumer!.batch_size = 2;
  h.schedules = [];
  await store.write(j);
  await writeFile(join(out, 'worker.js'), 'export default {fetch(){return new Response("retry")}}');
  h.configFail = true;
  const result = await deploy(o);
  expect(result.exitCode).not.toBe(0);
  expect(h.consumer!.batch_size).toBe(2);
  expect((await store.read())!.deployment!.attempt.changes).toContainEqual(
    expect.objectContaining({ kind: 'consumer', restoration: 'restored' }),
  );
  expect(result.output.checks).not.toContainEqual({
    name: 'configuration_restoration',
    status: 'failed_or_unknown',
  });
});
it.each(['valid', 'consumer-drift', 'deployment-drift'] as const)(
  'R8 recovers the old failed journal only from matching consumer and deployment evidence: %s',
  async (evidence) => {
    const { h, o } = firstInstall();
    realConsumerReadback(h, o);
    h.configFail = true;
    expect((await deploy(o)).exitCode).not.toBe(0);
    const failed = (await store.read())!;
    const a = failed.deployment!.attempt;
    expect(a.phase).toBe('failed');
    for (const change of a.changes) if (change.kind !== 'endpoints') change.restoration = 'unknown';
    h.configFail = false;
    if (evidence === 'consumer-drift') h.consumer!.max_retries += 1;
    if (evidence === 'deployment-drift') h.active.id = 'foreign-deployment';
    await store.write(failed);
    const before = await readFile(store.path, 'utf8');
    const count = mutations(h).length;
    const planned = await deploy({ ...o, dryRun: true });
    expect(await readFile(store.path, 'utf8')).toBe(before);
    expect(mutations(h)).toHaveLength(count);
    if (evidence === 'valid') {
      expect(planned.output.error).toBeNull();
      expect((await deploy(o)).exitCode).toBe(0);
      expect(
        h.calls.filter((c) => c.path === `/queues/${JOBS}/consumers` && c.method === 'POST'),
      ).toHaveLength(1);
    } else {
      expect(planned.output.error?.code).toBe('configuration_conflict');
      expect((await deploy(o)).output.error?.code).toBe('configuration_conflict');
      expect(mutations(h)).toHaveLength(count);
    }
  },
);
it.each([
  'script',
  'dead_letter_queue',
  'batch_size',
  'max_wait_time_ms',
  'max_retries',
  'max_concurrency',
  'retry_delay',
])('R8 refuses a genuinely different real consumer %s after configuration', async (field) => {
  const { h, o } = firstInstall();
  realConsumerReadback(h, o);
  const send = o.fetch!;
  o.fetch = (async (input, init) => {
    const response = await send(input, init);
    if (
      !h.consumer ||
      (init?.method ?? 'GET') !== 'GET' ||
      !new URL(String(input)).pathname.endsWith(`/queues/${JOBS}/consumers`)
    )
      return response;
    const consumers = object(await response.json()).result as Record<string, unknown>[];
    const consumer = consumers[0]!;
    if (field === 'script' || field === 'dead_letter_queue') consumer[field] = TOKEN;
    else {
      const settings = object(consumer.settings);
      settings[field] = Number(settings[field]) + 1;
    }
    return snap(consumers);
  }) as typeof fetch;
  const result = await deploy(o);
  expect(result.output.error?.code).toBe('configuration_conflict');
  expect(result.output.checks).toContainEqual({
    name: 'queue_consumer',
    status: 'configuration_conflict',
  });
  expect(JSON.stringify(result.output)).not.toContain(TOKEN);
  expect(h.calls.filter((c) => c.path === base + '/deployments' && c.method === 'POST')).toEqual(
    [],
  );
  expect(h.endpoints.enabled).toBe(false);
});
it('plans the real first install without provider writes or inventory changes', async () => {
  const { h, o } = firstInstall();
  const before = await readFile(store.path, 'utf8');
  const result = await deploy({ ...o, dryRun: true });
  expect(result.output.error).toBeNull();
  expect(result.output.status).toBe('planned');
  expect(mutations(h)).toEqual([]);
  expect(await readFile(store.path, 'utf8')).toBe(before);
});
it.each(['pending', 'complete'] as const)(
  'reconciles a %s script-create receipt using result.items without another version',
  async (state) => {
    const { h, o } = firstInstall();
    const inner = h.fetch;
    o.fetch = (async (input, init) => {
      const response = await inner(input, init);
      if (new URL(String(input)).pathname.endsWith(base) && init?.method === 'PUT')
        throw new Error('create acknowledgement lost');
      return response;
    }) as typeof fetch;
    expect((await deploy(o)).output.error?.code).toBe('outcome_unknown');
    expect((await store.read())!.deployment!.attempt.script_creation?.state).toBe('pending');
    if (state === 'complete') {
      const j = (await store.read())!;
      j.deployment!.attempt.script_creation = {
        state,
        deployment_id: 'created-deployment',
        version_id: CREATED,
      };
      await store.write(j);
    }
    expect(h.endpoints).toEqual({ enabled: false, previews_enabled: false });
    const result = await deploy(o);
    expect(result.output.error).toBeNull();
    expect(result.output.version_id).toBe(CREATED);
    const attempt = (await store.read())!.deployment!.attempt;
    expect(attempt).toMatchObject({
      phase: 'active',
      version_id: CREATED,
      previous_version_id: null,
      previous_distribution: [],
      script_creation: { state: 'complete', version_id: CREATED },
    });
    expect(h.calls.filter((c) => c.path === base && c.method === 'PUT')).toHaveLength(1);
    expect(h.calls.filter((c) => c.path === base + '/versions' && c.method === 'POST')).toEqual([]);
    expect(h.calls.some((c) => c.path === base + '/versions' && c.method === 'GET')).toBe(true);
    expect(h.endpoints).toEqual({ enabled: true, previews_enabled: false });
  },
);
function providerReadback(
  h: ReturnType<typeof harness>,
  o: DeployOptions,
  listing: 'worker_id' | 'name_only' = 'name_only',
) {
  const inner = o.fetch!;
  o.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/workers/scripts')) {
      const response = await inner(input, init);
      const envelope = object(await response.json());
      envelope.result = (envelope.result as Record<string, unknown>[]).map((w) =>
        listing === 'name_only'
          ? { ...providerFixtures.workerNameOnly.result[0], ...w }
          : { ...w, worker_id: providerFixtures.workerWithId.result[0]!.worker_id },
      );
      return Response.json(envelope);
    }
    if (path.includes('/workers/workers/')) {
      expect(path).toContain(
        `/workers/workers/${listing === 'name_only' ? script : providerFixtures.workerWithId.result[0]!.worker_id}/versions/`,
      );
      const v = h.versions.get(path.split('/').at(-1)!)!;
      const resources = v.resources as Record<string, unknown>;
      return snap({
        id: v.id,
        annotations: v.annotations,
        bindings: resources.bindings,
        compatibility_date: '2026-10-01',
        compatibility_flags: ['nodejs_compat'],
        assets: {
          config: {
            run_worker_first: ['/*'],
            html_handling: 'none',
            not_found_handling: 'none',
            base_path: '/',
          },
        },
      });
    }
    const response = await inner(input, init);
    if (!response.ok) return response;
    if (path.endsWith(base + '/settings') || path.includes(base + '/versions/')) {
      const envelope = object(await response.json());
      const result = object(envelope.result);
      const target = path.endsWith('/settings') ? result : object(result.resources);
      target.bindings = (target.bindings as Record<string, unknown>[]).map((b) => {
        if (b.type !== 'd1') return b;
        const { id, ...binding } = b;
        return { ...binding, database_id: id };
      });
      if (path.endsWith('/settings')) {
        target.compatibility_date = '2026-10-01';
        target.compatibility_flags = ['nodejs_compat'];
      } else {
        delete target.assets;
        target.script_runtime = {
          compatibility_date: '2026-10-01',
          compatibility_flags: ['nodejs_compat'],
        };
      }
      return new Response(JSON.stringify(envelope));
    }
    return response;
  }) as typeof fetch;
}
function realSettingsReadback(h: ReturnType<typeof harness>, o: DeployOptions) {
  providerReadback(h, o);
  realConsumerReadback(h, o);
  const send = o.fetch!;
  o.fetch = (async (input, init) => {
    const response = await send(input, init);
    if (!response.ok || !String(input).endsWith(base + '/settings')) return response;
    const result = object(object(await response.json()).result);
    const bindings = (result.bindings as Record<string, unknown>[]).map((b) =>
      b.type === 'd1' ? { ...b, id: b.database_id } : b,
    );
    return snap({
      ...realWorkerSettings,
      ...result,
      bindings: h.consumer ? bindings.reverse() : bindings,
      annotations: h.consumer ? { 'workers/tag': TOKEN } : realWorkerSettings.annotations,
    });
  }) as typeof fetch;
}
it.each([false, true])(
  'R9 reconciles real worker settings with defaults appearing=%s',
  async (defaultsAppear) => {
    const { h, o } = firstInstall();
    const send = o.fetch!;
    let loseCreate = true;
    o.fetch = (async (input, init) => {
      const response = await send(input, init);
      if (loseCreate && init?.method === 'PUT' && String(input).endsWith(base)) {
        loseCreate = false;
        throw new Error('create acknowledgement lost');
      }
      return response;
    }) as typeof fetch;
    realSettingsReadback(h, o);
    expect((await deploy(o)).output.error?.code).toBe('outcome_unknown');
    if (defaultsAppear) {
      const read = o.fetch!;
      let settingsReads = 0;
      o.fetch = (async (input, init) => {
        const response = await read(input, init);
        if (!String(input).endsWith(base + '/settings') || settingsReads++ !== 0) return response;
        const result = object(object(await response.json()).result);
        for (const key of [
          'placement',
          'usage_model',
          'tail_consumers',
          'logpush',
          'observability',
        ])
          delete result[key];
        return snap(result);
      }) as typeof fetch;
    }
    const result = await deploy(o);
    expect(result.output.error).toBeNull();
    expect(result.output.checks).not.toContainEqual(
      expect.objectContaining({ name: 'configuration_restoration' }),
    );
    expect(h.endpoints).toEqual({ enabled: true, previews_enabled: false });
    expect((await store.read())!.deployment!.attempt.phase).toBe('active');
    expect(h.calls.filter((c) => c.path === base && c.method === 'PUT')).toHaveLength(1);
    expect(h.calls.filter((c) => c.path === base + '/versions' && c.method === 'POST')).toEqual([]);
    expect(
      h.calls.filter((c) => c.path.endsWith('/consumers') && c.method === 'POST'),
    ).toHaveLength(1);
    expect(JSON.stringify(result.output)).not.toContain(TOKEN);
  },
);
it.each([
  ['compatibility_date', 'worker_settings:compatibility_date'],
  ['compatibility_flags', 'worker_settings:compatibility_flags'],
  ['tags', 'worker_settings:tags'],
  ['DB:id', 'worker_settings:binding:DB:id'],
  ['JOBS:queue_name', 'worker_settings:binding:JOBS:queue_name'],
  ['STORAGE:bucket_name', 'worker_settings:r2:bucket_name'],
  ['STORAGE:jurisdiction', 'worker_settings:r2:jurisdiction'],
  ['ANALYTICS:dataset', 'worker_settings:analytics_engine:dataset'],
  ['PB_PUBLIC_URL:text', 'worker_settings:binding:PB_PUBLIC_URL:text'],
  ['DEPLOYMENT_ID:text', 'worker_settings:binding:DEPLOYMENT_ID:text'],
  ['ASSETS:type', 'worker_settings:binding:ASSETS:type'],
  ['PB_MASTER_KEY:presence', 'worker_settings:binding:PB_MASTER_KEY:presence'],
  ['observability', 'worker_settings:observability:logs:invocation_logs'],
])(
  'R9 refuses concurrent real settings drift with a safe field name: %s',
  async (field, diagnostic) => {
    const { h, o } = firstInstall();
    const send = o.fetch!;
    let loseCreate = true;
    o.fetch = (async (input, init) => {
      const response = await send(input, init);
      if (loseCreate && init?.method === 'PUT' && String(input).endsWith(base)) {
        loseCreate = false;
        throw new Error('create acknowledgement lost');
      }
      return response;
    }) as typeof fetch;
    realSettingsReadback(h, o);
    expect((await deploy(o)).output.error?.code).toBe('outcome_unknown');
    const read = o.fetch!;
    let settingsReads = 0;
    o.fetch = (async (input, init) => {
      const response = await read(input, init);
      if (!String(input).endsWith(base + '/settings') || settingsReads++ === 0) return response;
      const result = object(object(await response.json()).result);
      const bindings = result.bindings as Record<string, unknown>[];
      const [name, key] = field.split(':');
      const binding = bindings.find((b) => b.name === name);
      if (key === 'presence') result.bindings = bindings.filter((b) => b !== binding);
      else if (key) binding![key] = TOKEN;
      else if (field === 'tags') result.tags = [...(result.tags as string[]), TOKEN];
      else if (field === 'observability')
        object(object(result.observability).logs).invocation_logs = true;
      else result[field] = field === 'compatibility_date' ? TOKEN : [TOKEN];
      return snap(result);
    }) as typeof fetch;
    const result = await deploy(o);
    expect(result.output.error?.code).toBe('configuration_conflict');
    expect(result.output.checks).toContainEqual({
      name: diagnostic,
      status: 'configuration_conflict',
    });
    expect(JSON.stringify(result.output)).not.toContain(TOKEN);
    expect(h.calls.filter((c) => c.path === base + '/deployments' && c.method === 'POST')).toEqual(
      [],
    );
    expect(h.endpoints.enabled).toBe(false);
  },
);
it('R9 retries the retained first-install attachments with real settings without replaying them', async () => {
  const { h, o } = firstInstall();
  realSettingsReadback(h, o);
  h.configFail = true;
  const failed = await deploy(o);
  expect(failed.output.checks).toContainEqual({
    name: 'configuration_restoration',
    status: 'incomplete_attachments_retained',
  });
  h.configFail = false;
  const result = await deploy(o);
  expect(result.output.error).toBeNull();
  expect(result.output.checks).not.toContainEqual(
    expect.objectContaining({ name: 'configuration_restoration' }),
  );
  expect(h.endpoints).toEqual({ enabled: true, previews_enabled: false });
  expect(h.calls.filter((c) => c.path.endsWith('/consumers') && c.method === 'POST')).toHaveLength(
    1,
  );
});
it('resolves a distinct Worker ID for real settings and authoritative version evidence', async () => {
  const { h, o } = firstInstall();
  providerReadback(h, o, 'worker_id');
  const inner = o.fetch!;
  let loseCreate = true;
  o.fetch = (async (input, init) => {
    const response = await inner(input, init);
    if (loseCreate && new URL(String(input)).pathname.endsWith(base) && init?.method === 'PUT') {
      loseCreate = false;
      throw new Error('create acknowledgement lost');
    }
    return response;
  }) as typeof fetch;
  expect((await deploy(o)).output.error?.code).toBe('outcome_unknown');
  expect(h.endpoints).toEqual({ enabled: false, previews_enabled: false });
  const result = await deploy(o);
  expect(result.output.plan).toContainEqual({ stage: 'deploy', action: 'reconcile' });
  expect(result.output.error).toBeNull();
  expect(result.output.version_id).toBe(CREATED);
  expect(h.endpoints).toEqual({ enabled: true, previews_enabled: false });
  expect(h.calls.filter((c) => c.path === base && c.method === 'PUT')).toHaveLength(1);
  expect(h.calls.filter((c) => c.path === base + '/versions' && c.method === 'POST')).toEqual([]);
  expect(h.consumer).toMatchObject({
    script_name: script,
    dead_letter_queue: `${script}-jobs-dlq`,
  });
});
it.each(['eu', 'default', 'missing'] as const)(
  'requires authoritative EU jurisdiction when legacy reads omit it: %s',
  async (jurisdiction) => {
    const { h, o } = firstInstall();
    providerReadback(h, o);
    const inner = o.fetch!;
    let fullReads = 0;
    o.fetch = (async (input, init) => {
      const response = await inner(input, init);
      if (!response.ok) return response;
      const path = new URL(String(input)).pathname;
      const full = path.includes('/workers/workers/');
      if (!full && !path.endsWith(base + '/settings') && !path.includes(base + '/versions/'))
        return response;
      const envelope = object(await response.json());
      const result = object(envelope.result);
      const target = full || path.endsWith('/settings') ? result : object(result.resources);
      for (const b of (target.bindings as Record<string, unknown>[]).filter(
        (b) => b.type === 'r2_bucket',
      )) {
        if (full && jurisdiction !== 'missing') b.jurisdiction = jurisdiction;
        else delete b.jurisdiction;
      }
      if (full) fullReads++;
      return new Response(JSON.stringify(envelope));
    }) as typeof fetch;
    const result = await deploy(o);
    expect(fullReads).toBeGreaterThan(0);
    if (jurisdiction === 'eu') {
      expect(result.output.error).toBeNull();
      expect(h.endpoints.enabled).toBe(true);
    } else {
      expect(result.output.error?.code).toBe('configuration_conflict');
      expect(result.output.checks).toContainEqual({
        name: 'r2:jurisdiction',
        status: 'configuration_conflict',
      });
      expect(h.endpoints.enabled).toBe(false);
    }
  },
);
it.each(['id', 'assets', 'annotations'] as const)(
  'rejects different authoritative version evidence: %s',
  async (field) => {
    const { h, o } = firstInstall();
    providerReadback(h, o);
    const inner = o.fetch!;
    o.fetch = (async (input, init) => {
      const response = await inner(input, init);
      if (!String(input).includes('/workers/workers/')) return response;
      const envelope = object(await response.json());
      const result = object(envelope.result);
      if (field === 'id') result.id = CANDIDATE;
      if (field === 'assets') result.assets = { config: { run_worker_first: false } };
      if (field === 'annotations') result.annotations = { 'workers/tag': TOKEN };
      return new Response(JSON.stringify(envelope));
    }) as typeof fetch;
    const result = await deploy(o);
    expect(result.output.error?.code).toBe('configuration_conflict');
    expect(result.output.checks).toContainEqual({
      name:
        field === 'id'
          ? 'version_id'
          : field === 'assets'
            ? 'assets:run_worker_first'
            : 'version_annotations',
      status: 'configuration_conflict',
    });
    expect(JSON.stringify(result.output)).not.toContain(TOKEN);
    expect(h.endpoints.enabled).toBe(false);
  },
);
it.each([
  ['queue', 'JOBS', 'queue_name', 'worker_settings:binding:JOBS:queue_name'],
  ['d1', 'DB', 'id', 'worker_settings:binding:DB:id'],
  ['r2_bucket', 'STORAGE', 'jurisdiction', 'worker_settings:r2:jurisdiction'],
  ['plain_text', 'PB_PUBLIC_URL', 'text', 'binding:plain_text:PB_PUBLIC_URL:text'],
  ['plain_text', 'DEPLOYMENT_ID', 'text', 'worker_settings:binding:DEPLOYMENT_ID:text'],
  ['assets', 'ASSETS', 'name', 'binding:assets:ASSETS:presence'],
] as const)(
  'reports only the safe differing binding field: %s:%s:%s',
  async (type, name, field, diagnostic) => {
    const { h, o } = firstInstall();
    const inner = h.fetch;
    o.fetch = (async (input, init) => {
      const response = await inner(input, init);
      if (new URL(String(input)).pathname.endsWith(base) && init?.method === 'PUT') {
        const resources = h.versions.get(CREATED)!.resources as {
          bindings: Record<string, unknown>[];
        };
        resources.bindings.find((b) => b.type === type && b.name === name)![field] = TOKEN;
      }
      return response;
    }) as typeof fetch;
    const result = await deploy(o);
    expect(result.output.error?.code).toBe('configuration_conflict');
    expect(result.output.checks).toContainEqual({
      name: diagnostic,
      status: 'configuration_conflict',
    });
    expect(JSON.stringify(result.output)).not.toContain(TOKEN);
    expect(h.endpoints.enabled).toBe(false);
  },
);
it.each(['compatibility_date', 'compatibility_flags', 'assets', 'queue_consumer'] as const)(
  'reports the safe configuration field for %s',
  async (field) => {
    const { h, o } = firstInstall();
    const inner = h.fetch;
    o.fetch = (async (input, init) => {
      const response = await inner(input, init);
      if (new URL(String(input)).pathname.endsWith(base) && init?.method === 'PUT') {
        const resources = h.versions.get(CREATED)!.resources as Record<string, unknown>;
        if (field === 'assets') resources.assets = { config: { run_worker_first: false } };
        else if (field !== 'queue_consumer')
          resources.script_runtime = {
            compatibility_date: '2026-10-01',
            compatibility_flags: ['nodejs_compat'],
            [field]: TOKEN,
          };
      }
      if (
        field === 'queue_consumer' &&
        init?.method === 'POST' &&
        String(input).endsWith('/consumers')
      )
        h.consumer!.script_name = TOKEN;
      return response;
    }) as typeof fetch;
    const result = await deploy(o);
    expect(result.output.error?.code).toBe('configuration_conflict');
    expect(result.output.checks).toContainEqual({
      name: field === 'assets' ? 'assets:run_worker_first' : field,
      status: 'configuration_conflict',
    });
    expect(JSON.stringify(result.output)).not.toContain(TOKEN);
  },
);
it('reconciles a version upload already sent by an earlier CLI after script creation', async () => {
  const { h, o } = firstInstall();
  expect((await deploy(o)).output.error).toBeNull();
  const j = (await store.read())!;
  const a = j.deployment!.attempt;
  a.phase = 'upload_pending';
  a.version_id = null;
  a.activated_at = null;
  await store.write(j);
  h.active = {
    id: a.script_creation!.deployment_id!,
    versions: [{ version_id: CREATED, percentage: 100 }],
  };
  h.versions.set(CANDIDATE, {
    ...h.versions.get(CREATED)!,
    id: CANDIDATE,
    annotations: {
      'workers/tag': `pb-${a.operation_id}`,
      'workers/message': `pb-artifact-sha256:${a.artifact_sha256}`,
    },
  });
  const result = await deploy(o);
  expect(result.output.error).toBeNull();
  expect(result.output.version_id).toBe(CANDIDATE);
  expect(h.calls.filter((c) => c.path === base + '/versions' && c.method === 'POST')).toEqual([]);
  expect(h.calls.filter((c) => c.path === base && c.method === 'PUT')).toHaveLength(1);
});
it.each(['tag', 'artifact', 'duplicate', 'incomplete'] as const)(
  'does not adopt an ambiguous or unverifiable created version: %s',
  async (failure) => {
    const { h, o } = firstInstall();
    const inner = h.fetch;
    o.fetch = (async (input, init) => {
      const response = await inner(input, init);
      const path = new URL(String(input)).pathname;
      if (path.endsWith(base) && init?.method === 'PUT') {
        const annotations = h.versions.get(CREATED)!.annotations as Record<string, string>;
        if (failure === 'tag') annotations['workers/tag'] = 'foreign-operation';
        if (failure === 'artifact')
          annotations['workers/message'] = `pb-artifact-sha256:${'f'.repeat(64)}`;
        if (failure === 'duplicate')
          h.versions.set(THIRD, { ...h.versions.get(CREATED)!, id: THIRD });
      }
      if (failure === 'incomplete' && path.endsWith(base + '/versions'))
        return snap({ items: [...h.versions.values()] });
      return response;
    }) as typeof fetch;
    expect((await deploy(o)).exitCode).not.toBe(0);
    expect((await deploy(o)).exitCode).not.toBe(0);
    expect(h.calls.filter((c) => c.path === base && c.method === 'PUT')).toHaveLength(1);
    expect(h.calls.filter((c) => c.path === base + '/versions' && c.method === 'POST')).toEqual([]);
    expect(h.endpoints).toEqual({ enabled: false, previews_enabled: false });
  },
);
it.each(['refused', 'not applied'] as const)(
  'fails when workers.dev enable is %s',
  async (failure) => {
    const { h, o } = firstInstall();
    const inner = h.fetch;
    o.fetch = (async (input, init) => {
      if (
        new URL(String(input)).pathname.endsWith(base + '/subdomain') &&
        init?.method === 'POST' &&
        JSON.parse(String(init.body)).enabled
      )
        return failure === 'refused' ? new Response('', { status: 403 }) : ok(h.endpoints);
      return inner(input, init);
    }) as typeof fetch;
    expect((await deploy(o)).exitCode).not.toBe(0);
    expect(h.calls.filter((c) => c.path === base + '/deployments' && c.method === 'POST')).toEqual(
      [],
    );
    expect(h.endpoints).toEqual({ enabled: false, previews_enabled: false });
  },
);
it('uploads documented asset buckets with the session bearer and redeems only the completion JWT', async () => {
  const { h, o } = firstInstall();
  const inner = h.fetch;
  let uploads = 0;
  o.fetch = (async (input, init) => {
    const response = await inner(input, init);
    const url = new URL(String(input));
    if (url.pathname.endsWith('/assets-upload-session')) {
      const hashes = Object.values(h.sessionManifest).map((v) => v.hash);
      return new Response(
        JSON.stringify({
          ...documented.assetSession,
          result: {
            ...documented.assetSession.result,
            buckets: [[hashes[0]], hashes.slice(1)],
          },
        }),
      );
    }
    if (url.pathname.endsWith('/assets/upload')) {
      expect(url.search).toBe('?base64=true');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer SESSION_SENTINEL');
      return new Response(
        JSON.stringify(++uploads === 1 ? documented.assetBatch : documented.assetComplete),
        { status: uploads === 1 ? 200 : 201 },
      );
    }
    return response;
  }) as typeof fetch;
  expect((await deploy(o)).output.error).toBeNull();
  expect(uploads).toBe(2);
  const assets = (await validateDeploymentArtifact(out)).assets;
  const forms = h.calls
    .filter((c) => c.path === '/workers/assets/upload')
    .map((c) => c.body as FormData);
  for (const asset of assets) {
    const hash = cloudflareAssetHash(asset.content, asset.name);
    expect(h.sessionManifest['/' + asset.name]).toEqual({ hash, size: asset.content.length });
    const part = forms.map((f) => f.get(hash)).find(Boolean) as Blob;
    expect(Buffer.from(await part.text(), 'base64')).toEqual(asset.content);
  }
});
it('preserves manifest content types on asset upload parts', async () => {
  const { h, o } = firstInstall();
  expect((await deploy(o)).output.error).toBeNull();
  const form = h.calls.find((c) => c.path === '/workers/assets/upload')!.body as FormData;
  for (const [name, expected] of [
    ['manifest.json', 'application/json'],
    ['index.html', 'text/html'],
    ['app.1234.js', 'text/javascript'],
  ]) {
    const asset = (await validateDeploymentArtifact(out)).assets.find((f) => f.name === name)!;
    expect((form.get(cloudflareAssetHash(asset.content, name!)) as Blob).type).toBe(expected);
  }
});
it('refuses malformed intermediate upload tokens before sending the remaining bucket', async () => {
  const { h, o } = firstInstall();
  const inner = h.fetch;
  o.fetch = (async (input, init) => {
    const response = await inner(input, init);
    const url = new URL(String(input));
    if (url.pathname.endsWith('/assets-upload-session')) {
      const hashes = Object.values(h.sessionManifest).map((v) => v.hash);
      return ok({ jwt: 'SESSION_SENTINEL', buckets: [[hashes[0]], hashes.slice(1)] });
    }
    return url.pathname.endsWith('/assets/upload') ? ok({ jwt: 123 }) : response;
  }) as typeof fetch;
  expect((await deploy(o)).exitCode).not.toBe(0);
  expect(h.calls.filter((c) => c.path === '/workers/assets/upload')).toHaveLength(1);
});
it('does not repeat a create whose outcome is still absent after a lost response', async () => {
  const { h, o } = firstInstall();
  const inner = h.fetch;
  let creates = 0;
  o.fetch = (async (input, init) => {
    if (new URL(String(input)).pathname.endsWith(base) && init?.method === 'PUT') {
      creates++;
      throw new Error(TOKEN);
    }
    return inner(input, init);
  }) as typeof fetch;
  expect((await deploy(o)).output.error?.code).toBe('outcome_unknown');
  expect((await deploy(o)).exitCode).not.toBe(0);
  expect(creates).toBe(1);
});
it('keeps a definite create refusal retryable without issuing a version upload', async () => {
  const { h, o } = firstInstall();
  const inner = h.fetch;
  o.fetch = (async (input, init) =>
    new URL(String(input)).pathname.endsWith(base) && init?.method === 'PUT'
      ? new Response('', { status: 403 })
      : inner(input, init)) as typeof fetch;
  expect((await deploy(o)).exitCode).not.toBe(0);
  expect((await store.read())!.deployment!.attempt).not.toHaveProperty('script_creation');
  expect(h.calls.some((c) => c.path === base + '/versions' && c.method === 'POST')).toBe(false);
  o.fetch = inner;
  expect((await deploy(o)).output.error).toBeNull();
});
it('rejects a changed creation version rather than taking over its deployment', async () => {
  const { h, o } = firstInstall();
  const inner = h.fetch;
  o.fetch = (async (input, init) => {
    const response = await inner(input, init);
    if (new URL(String(input)).pathname.endsWith(base) && init?.method === 'PUT') {
      h.active = { id: 'foreign-deployment', versions: [{ version_id: NEWEST, percentage: 100 }] };
      throw new Error(TOKEN);
    }
    return response;
  }) as typeof fetch;
  expect((await deploy(o)).output.error?.code).toBe('outcome_unknown');
  expect((await deploy(o)).output.error?.code).toBe('configuration_conflict');
  expect(h.calls.filter((c) => c.path === base && c.method === 'PUT')).toHaveLength(1);
  expect(h.calls.some((c) => c.path === base + '/versions' && c.method === 'POST')).toBe(false);
});
it('uses the session completion JWT without uploading when documented buckets are empty', async () => {
  const { h, o } = firstInstall();
  const inner = h.fetch;
  o.fetch = (async (input, init) =>
    new URL(String(input)).pathname.endsWith('/assets-upload-session')
      ? new Response(JSON.stringify(documented.assetsCached))
      : inner(input, init)) as typeof fetch;
  expect((await deploy(o)).output.error).toBeNull();
  expect(h.calls.some((c) => c.path === '/workers/assets/upload')).toBe(false);
});
it.each([
  { jwt: '', buckets: [] },
  { jwt: 'SESSION_SENTINEL' },
  { jwt: 'SESSION_SENTINEL', buckets: [null] },
  { jwt: 'SESSION_SENTINEL', buckets: [['unknown-hash']] },
])('refuses malformed asset sessions before script creation: %j', async (result) => {
  const { h, o } = firstInstall();
  const inner = h.fetch;
  o.fetch = (async (input, init) =>
    new URL(String(input)).pathname.endsWith('/assets-upload-session')
      ? ok(result)
      : inner(input, init)) as typeof fetch;
  expect((await deploy(o)).exitCode).not.toBe(0);
  expect(h.calls.some((c) => c.path === base && c.method === 'PUT')).toBe(false);
});
it.each([{}, { jwt: '' }, { jwt: 123 }])(
  'refuses an asset upload without a valid final completion token: %j',
  async (result) => {
    const { h, o } = firstInstall();
    const inner = h.fetch;
    o.fetch = (async (input, init) =>
      new URL(String(input)).pathname.endsWith('/assets/upload')
        ? ok(result)
        : inner(input, init)) as typeof fetch;
    expect((await deploy(o)).exitCode).not.toBe(0);
    expect(h.calls.some((c) => c.path === base && c.method === 'PUT')).toBe(false);
  },
);
it('does not re-create a script after losing the create acknowledgement', async () => {
  const { h, o } = firstInstall();
  const inner = h.fetch;
  let lost = false;
  o.fetch = (async (input, init) => {
    const response = await inner(input, init);
    if (!lost && new URL(String(input)).pathname.endsWith(base) && init?.method === 'PUT') {
      lost = true;
      throw new Error(TOKEN);
    }
    return response;
  }) as typeof fetch;
  expect((await deploy(o)).output.error?.code).toBe('outcome_unknown');
  expect(h.endpoints).toEqual({ enabled: false, previews_enabled: false });
  const rerun = await deploy(o);
  expect(rerun.output.error).toBeNull();
  expect(rerun.output.previous_version_id).toBeNull();
  expect(h.calls.filter((c) => c.path === base && c.method === 'PUT')).toHaveLength(1);
});
it('refuses changed secrets after losing the script create acknowledgement', async () => {
  const { h, o } = firstInstall();
  o.secret = ['PB_MASTER_KEY', 'PB_IDP_TEST_CLIENT_SECRET'];
  const inner = h.fetch;
  o.fetch = (async (input, init) => {
    const response = await inner(input, init);
    if (new URL(String(input)).pathname.endsWith(base) && init?.method === 'PUT')
      throw new Error(TOKEN);
    return response;
  }) as typeof fetch;
  expect((await deploy(o)).output.error?.code).toBe('outcome_unknown');
  expect((await store.read())!.deployment!.attempt).toMatchObject({
    phase: 'preparing_upload',
    script_creation: { state: 'pending' },
  });
  const count = mutations(h).length;
  o.env = { ...o.env, PB_IDP_TEST_CLIENT_SECRET: 'CHANGED_IDP_SENTINEL' };
  const rerun = await deploy(o);
  expect(rerun.exitCode).not.toBe(0);
  expect(rerun.output.status).not.toBe('ok');
  expect(rerun.output.error?.code).toBe('configuration_conflict');
  expect(rerun.output.checks).toContainEqual({
    name: 'bindings:secret_text',
    status: 'configuration_conflict',
  });
  expect(mutations(h)).toHaveLength(count);
  expect(h.endpoints).toEqual({ enabled: false, previews_enabled: false });
  expect(JSON.stringify(rerun.output)).not.toContain('CHANGED_IDP_SENTINEL');
});
it.each([{}, { id: 'different-script' }])(
  'refuses unexpected script create acknowledgements: %j',
  async (result) => {
    const { h, o } = firstInstall();
    const inner = h.fetch;
    o.fetch = (async (input, init) => {
      const response = await inner(input, init);
      return new URL(String(input)).pathname.endsWith(base) && init?.method === 'PUT'
        ? ok(result)
        : response;
    }) as typeof fetch;
    expect((await deploy(o)).exitCode).not.toBe(0);
    expect(h.calls.some((c) => c.path === base + '/versions' && c.method === 'POST')).toBe(false);
  },
);
it('does not require inheritance when the first install has no installed secrets', async () => {
  const { o } = firstInstall();
  o.contract = { ...cloudflareDeployContract, secretInheritance: false };
  expect((await deploy(o)).output.error).toBeNull();
});
it('the production contract builds the candidate version URL for a gradual rollout', async () => {
  const h = harness();
  const o = options(h, { rollout: 25 });
  delete o.contract;
  delete o.domain;
  const result = await deploy(o);
  expect(result.output.error).toBeNull();
  expect(result.exitCode).toBe(0);
  expect((await store.read())!.deployment!.attempt.candidate_probe_url).toBe(
    `https://${CANDIDATE.slice(0, 8)}-${script}.${h.subdomain}.workers.dev`,
  );
  expect(h.calls).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: `${base}/versions/${CANDIDATE}`, method: 'GET' }),
    ]),
  );
  expect(h.active.versions).toEqual([
    { version_id: OLD, percentage: 75 },
    { version_id: CANDIDATE, percentage: 25 },
  ]);
  const probe = vi.fn(async () => true);
  await withCandidatePreview(api(h), store, (await store.read())!, cloudflareDeployContract, probe);
  expect(probe).toHaveBeenCalledWith(
    `https://${CANDIDATE.slice(0, 8)}-${script}.${h.subdomain}.workers.dev`,
  );
});
it.each([
  `https://${CANDIDATE.slice(0, 8)}-${script}.other.workers.dev`,
  `https://${CANDIDATE}-${script}.account.workers.dev`,
  `https://${CANDIDATE.slice(0, 8)}-another-worker.account.workers.dev`,
])('refuses a contract preview with a different exact hostname: %s', async (url) => {
  const h = harness();
  const result = await deploy(
    options(h, {
      rollout: 25,
      contract: {
        ...fixtureContract,
        preview: async () => ({ version_id: CANDIDATE, url, bindings_verified: true }),
      },
    }),
  );
  expect(result.output.error?.code).toBe('configuration_conflict');
  expect(result.output.checks).toContainEqual({
    name: 'preview',
    status: 'configuration_conflict',
  });
  expect(h.active.versions).toEqual([{ version_id: OLD, percentage: 100 }]);
});
it('the production contract retains installed secret bindings for an existing Worker', async () => {
  const h = harness();
  const o = options(h);
  delete o.contract;
  delete o.domain;
  expect((await deploy(o)).output.error).toBeNull();
  expect(h.calls.some((c) => c.path === base && c.method === 'PUT')).toBe(false);
  expect(h.metadata!.keep_bindings).toEqual(['secret_text']);
});
it.each([{}, { active: null }, { deployments: null }, { deployments: [{}] }])(
  'refuses undocumented deployment shapes before writes: %j',
  async (result) => {
    const h = harness();
    const inner = h.fetch;
    const o = options(h);
    o.fetch = (async (input, init) =>
      new URL(String(input)).pathname.endsWith('/deployments')
        ? ok(result)
        : inner(input, init)) as typeof fetch;
    expect((await deploy(o)).exitCode).not.toBe(0);
    expect(mutations(h)).toEqual([]);
  },
);

it('consumes T811 bytes and descriptor, hashes independently and excludes absolute relocation paths', async () => {
  const a = await validateDeploymentArtifact(out);
  const relocated = join(project, 'relocated');
  await mkdir(relocated);
  const { cp } = await import('node:fs/promises');
  await cp(out, relocated, { recursive: true });
  expect((await validateDeploymentArtifact(relocated)).artifactHash).toBe(a.artifactHash);
  await writeFile(join(relocated, 'worker.js'), 'different');
  expect((await validateDeploymentArtifact(relocated)).artifactHash).not.toBe(a.artifactHash);
});
it.each([
  'worker.js',
  'build-info.json',
  'generated/manifest.json',
  'assets.json',
  'assets/manifest.json',
  'assets/app.1234.js',
])('refuses missing %s before any API request', async (name) => {
  await rm(join(out, name));
  const h = harness(),
    result = await deploy(options(h));
  expect(result.exitCode).toBe(2);
  expect(h.calls).toHaveLength(0);
});
it.each(['digest', 'bytes', 'escape', 'descriptor', 'target', 'inventory', 'routes'])(
  'rejects invalid %s before any API request',
  async (change) => {
    if (change === 'digest')
      await writeFile(join(out, 'assets/app.1234.js'), Buffer.from([1, 2, 3, 4]));
    if (change === 'bytes') await writeFile(join(out, 'assets/app.1234.js'), 'bad');
    if (change === 'escape') {
      await rm(join(out, 'assets/app.1234.js'));
      await symlink(join(out, 'worker.js'), join(out, 'assets/app.1234.js'));
    }
    if (change === 'descriptor') {
      const file = join(out, 'assets.json'),
        v = JSON.parse(await readFile(file, 'utf8'));
      v.descriptor.run_worker_first = false;
      await writeFile(file, JSON.stringify(v));
    }
    if (change === 'target') {
      const file = join(out, 'build-info.json'),
        v = JSON.parse(await readFile(file, 'utf8'));
      v.target = 'node';
      await writeFile(file, JSON.stringify(v));
    }
    if (change === 'inventory') await rm(store.path);
    if (change === 'routes') {
      const file = join(out, 'generated/manifest.json'),
        v = JSON.parse(await readFile(file, 'utf8'));
      delete v.routes;
      await writeFile(file, JSON.stringify(v));
    }
    const h = harness(),
      result = await deploy(options(h));
    expect(result.exitCode).toBe(2);
    expect(h.calls).toHaveLength(0);
  },
);
it('uploads multipart modules, completes native assets, inherits keys, configures queue units and cron, disables both alternate endpoints', async () => {
  const h = harness();
  const result = await deploy(
    options(h, {
      secret: ['PB_MASTER_KEY', 'PB_MASTER_KEY_PREVIOUS', 'PB_IDP_TEST_CLIENT_SECRET'],
    }),
  );
  expect(result.output.error).toBeNull();
  expect(result.exitCode).toBe(0);
  expect(result.output).toMatchObject({
    version_id: CANDIDATE,
    previous_version_id: OLD,
    build_info: { target: 'cloudflare' },
  });
  const validated = await validateDeploymentArtifact(out);
  const multipart = h.calls.find((c) => c.path === base + '/versions' && c.method === 'POST')!
    .body as FormData;
  expect(Buffer.from(await (multipart.get('worker.js') as Blob).arrayBuffer())).toEqual(
    validated.module,
  );
  const upload = h.calls.find((c) => c.path === '/workers/assets/upload')!.body as FormData;
  for (const f of validated.assets) {
    const hash = sha(f.content);
    expect(h.sessionManifest[`/${f.name}`]).toEqual({ hash, size: f.content.length });
    expect(Buffer.from(await (upload.get(hash) as Blob).text(), 'base64')).toEqual(f.content);
  }
  expect(h.metadata).toMatchObject({
    main_module: 'worker.js',
    keep_bindings: ['secret_text'],
    assets: {
      jwt: 'COMPLETION_SENTINEL',
      config: { run_worker_first: true, html_handling: 'none', not_found_handling: 'none' },
    },
  });
  const b = h.metadata!.bindings as Record<string, unknown>[];
  expect(b).toContainEqual({ type: 'd1', name: 'DB', id: DB });
  expect(b).toContainEqual({
    type: 'secret_text',
    name: 'PB_IDP_TEST_CLIENT_SECRET',
    text: 'IDP_SENTINEL',
  });
  expect(b.some((x) => x.name === 'PB_MASTER_KEY')).toBe(false);
  expect(b.some((x) => x.name === 'PB_MASTER_KEY_PREVIOUS')).toBe(false);
  expect(h.consumer).toMatchObject({
    batch_size: 1,
    max_wait_time_ms: 1000,
    max_retries: 4,
    max_concurrency: 2,
    dead_letter_queue: `${script}-jobs-dlq`,
  });
  expect(h.schedules).toEqual(['* * * * *']);
  expect(h.endpoints).toEqual({ enabled: false, previews_enabled: false });
  expect(h.calls.filter((c) => c.path === '/workers/assets/upload')[0]?.auth).toBe(
    'Bearer SESSION_SENTINEL',
  );
  expect(
    h.calls
      .filter((c) => c.path !== '/workers/assets/upload')
      .every((c) => c.auth === `Bearer ${TOKEN}`),
  ).toBe(true);
  expect(
    h.calls.findIndex((c) => c.path === base + '/subdomain' && c.method === 'POST'),
  ).toBeLessThan(h.calls.findIndex((c) => c.path === base + '/deployments' && c.method === 'POST'));
  for (const secret of [
    KEY,
    PREVIOUS,
    TOKEN,
    'SESSION_SENTINEL',
    'COMPLETION_SENTINEL',
    'IDP_SENTINEL',
  ]) {
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(await readFile(store.path, 'utf8')).not.toContain(secret);
  }
  expect((await readdir(store.directory)).filter((n) => !n.startsWith('inventory.'))).toEqual([]);
});
it('dry run sends only reads and writes no journal, lock, asset session, secret or activation', async () => {
  const before = await readFile(store.path),
    h = harness();
  const r = await deploy(options(h, { dryRun: true }));
  expect(r.exitCode).toBe(0);
  expect(r.output.status).toBe('planned');
  expect(mutations(h)).toEqual([]);
  expect(await readFile(store.path)).toEqual(before);
});
it('reads Worker scripts, installed secrets and domains as documented snapshots', async () => {
  const h = harness();
  const urls: string[] = [];
  const inner = h.fetch;
  h.fetch = (async (input: unknown, init?: RequestInit) => {
    urls.push(String(input));
    const response = await inner(input as never, init);
    if (new URL(String(input)).pathname.endsWith('/workers/domains')) {
      const body = (await response.json()) as Record<string, unknown>;
      delete body.result_info;
      return Response.json(body);
    }
    return response;
  }) as typeof fetch;
  expect((await deploy(options(h, { dryRun: true }))).exitCode).toBe(0);
  for (const path of ['/workers/scripts', `${base}/secrets`, '/workers/domains']) {
    const reads = urls.filter((u) => new URL(u).pathname.endsWith(path));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((u) => !u.includes('?'))).toBe(true);
  }
});
it('refuses a Worker scripts snapshot that advertises more pages', async () => {
  const h = harness();
  const inner = h.fetch;
  h.fetch = (async (input: unknown, init?: RequestInit) =>
    new URL(String(input)).pathname.endsWith('/workers/scripts')
      ? new Response(JSON.stringify({ success: true, result: [], result_info: { total_pages: 2 } }))
      : inner(input as never, init)) as typeof fetch;
  const r = await deploy(options(h, { dryRun: true }));
  expect(r.exitCode).not.toBe(0);
  expect(mutations(h)).toEqual([]);
});
it('first install records no prior and requires 100 percent', async () => {
  const h = harness();
  h.exists = false;
  h.active = { id: null, versions: [] };
  h.installed = [];
  h.endpoints = { enabled: false, previews_enabled: false };
  expect((await deploy(options(h, { rollout: 25, secret: ['PB_MASTER_KEY'] }))).exitCode).toBe(2);
  expect(mutations(h)).toHaveLength(0);
  const r = await deploy(options(h, { secret: ['PB_MASTER_KEY'] }));
  expect(r.output.error).toBeNull();
  expect(r.output.previous_version_id).toBeNull();
  expect(r.output.version_id).toBe(CANDIDATE);
});
it('requires verified provider facilities and refuses unknown inheritance or asset hashing before writes', async () => {
  for (const contract of [
    { ...fixtureContract, secretInheritance: false },
    { versionsCreateScript: true, secretInheritance: true },
  ]) {
    const h = harness();
    const r = await deploy(
      options(h, { contract: contract as DeployProviderContract, rollout: 20 }),
    );
    expect(r.output.error?.code).toBe('capability_unknown');
    expect(mutations(h)).toHaveLength(0);
  }
});
it.each(['enabled', 'previews_enabled'])(
  'rejects a non-boolean %s in the provider subdomain response',
  async (flag) => {
    const h = harness();
    const inner = h.fetch;
    h.fetch = (async (input, init) =>
      new URL(String(input)).pathname.endsWith(base + '/subdomain')
        ? ok({ ...h.endpoints, [flag]: 'true' })
        : inner(input, init)) as typeof fetch;
    const result = await deploy(options(h));
    expect(result.output.error?.code).toBe('provider_failure');
    expect(mutations(h)).toHaveLength(0);
  },
);
it('uses only the registered account subdomain and never auto-registers one', async () => {
  const h = harness();
  h.subdomain = null;
  const noDomain = { ...options(h) };
  delete noDomain.domain;
  expect((await deploy(noDomain)).output.error?.code).toBe('workers_dev_subdomain_missing');
  expect(mutations(h)).toHaveLength(0);
  h.subdomain = 'account';
  const r = await deploy(noDomain);
  expect(r.exitCode).toBe(0);
  expect(r.output.worker_url).toBe(`https://${script}.account.workers.dev`);
  expect(h.endpoints).toEqual({ enabled: true, previews_enabled: false });
});
it.each(['PB_TOKEN_PEPPER', 'DB', 'PB_PUBLIC_URL', 'PB_MASTER_KEY\nBAD', 'credential-value'])(
  'refuses an invalid or colliding secret selection %s',
  async (name) => {
    const h = harness();
    const r = await deploy(options(h, { secret: [name] }));
    expect(r.exitCode).toBe(2);
    expect(mutations(h)).toHaveLength(0);
  },
);
it('keeps an upload intent on lost responses and reconciles exact operation without duplicate upload', async () => {
  const h = harness();
  h.uploadLost = true;
  const first = await deploy(options(h));
  expect(first.exitCode).not.toBe(0);
  expect((await store.read())!.deployment!.attempt.phase).toBe('upload_pending');
  const second = await deploy(options(h));
  expect(second.output.error).toBeNull();
  expect(second.exitCode).toBe(0);
  expect(h.calls.filter((c) => c.path === base + '/versions' && c.method === 'POST')).toHaveLength(
    1,
  );
});
it('does not resend a timed out upload when authoritative listings cannot identify its candidate', async () => {
  const h = harness();
  h.uploadLost = true;
  h.uploadAbsent = true;
  await deploy(options(h));
  const r = await deploy(options(h));
  expect(r.exitCode).toBe(6);
  expect(h.calls.filter((c) => c.path === base + '/versions' && c.method === 'POST')).toHaveLength(
    1,
  );
});
it('reconciles lost activation success and journals unknown activation without blind retry', async () => {
  const h = harness();
  h.activationLost = true;
  expect((await deploy(options(h))).exitCode).toBe(0);
  const j = (await store.read())!;
  j.deployment = null;
  await store.write(j);
  h.consumer = null;
  h.schedules = [];
  h.domain = null;
  h.active = { id: 'prior', versions: [{ version_id: OLD, percentage: 100 }] };
  h.activationAbsent = true;
  const first = await deploy(options(h));
  expect(first.exitCode).toBe(6);
  const count = mutations(h).length;
  expect((await deploy(options(h))).exitCode).toBe(6);
  expect(mutations(h)).toHaveLength(count);
});
it('refuses gradual active distributions, foreign consumers and deployment drift', async () => {
  const h = harness();
  h.active.versions = [
    { version_id: OLD, percentage: 90 },
    { version_id: NEWEST, percentage: 10 },
  ];
  expect((await deploy(options(h))).exitCode).toBe(8);
  expect(mutations(h)).toHaveLength(0);
  h.active.versions = [{ version_id: OLD, percentage: 100 }];
  h.drift = true;
  const r = await deploy(options(h));
  expect(r.exitCode).toBe(8);
  expect(h.calls.some((c) => c.path === base + '/deployments' && c.method === 'POST')).toBe(false);
});
it('restores safe prior endpoints and retains first-install attachments on a configuration failure', async () => {
  const h = harness();
  h.configFail = true;
  const r = await deploy(options(h));
  expect(r.exitCode).not.toBe(0);
  expect(h.endpoints).toEqual({ enabled: false, previews_enabled: false });
  expect(r.output.checks).toContainEqual({
    name: 'configuration_restoration',
    status: 'incomplete_attachments_retained',
  });
});
it('uploads no new version for an identical verified receipt, but mutable secret updates bypass it', async () => {
  const h = harness();
  expect((await deploy(options(h))).exitCode).toBe(0);
  const j = (await store.read())!;
  j.deployment!.attempt.phase = 'verified';
  j.deployment!.attempt.smoke = 'passed';
  await store.write(j);
  const count = mutations(h).length,
    r = await deploy(options(h, { secret: ['PB_MASTER_KEY'] }));
  expect(r.output.error).toBeNull();
  expect(r.output.plan).toContainEqual({ stage: 'deploy', action: 'unchanged' });
  expect(mutations(h)).toHaveLength(count);
  expect((await deploy(options(h, { secret: ['PB_IDP_TEST_CLIENT_SECRET'] }))).exitCode).toBe(0);
  expect(h.calls.filter((c) => c.path === base + '/versions' && c.method === 'POST')).toHaveLength(
    2,
  );
});
it('journals every uploaded version across successive deployments', async () => {
  const h = harness();
  expect((await deploy(options(h))).exitCode).toBe(0);
  const j = (await store.read())!;
  j.deployment!.attempt.phase = 'verified';
  j.deployment!.attempt.smoke = 'passed';
  await store.write(j);
  expect((await deploy(options(h, { secret: ['PB_IDP_TEST_CLIENT_SECRET'] }))).exitCode).toBe(0);
  const history = (await store.read())!.deployment!.history!;
  expect(history.version_ids).toEqual([CANDIDATE, NEWEST]);
  expect(history.plain_bindings).toEqual([
    { name: 'PB_AUTH_LOCAL', texts: ['enabled'] },
    { name: 'PB_PUBLIC_URL', texts: ['https://broker.example.test'] },
  ]);
});
it('journals the telemetry endpoint binding it uploads', async () => {
  const file = join(out, 'generated/manifest.json'),
    manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.platformPorts.observability.endpointEnv = 'OTEL_ENDPOINT';
  await writeFile(file, JSON.stringify(manifest));
  const h = harness(),
    o = options(h);
  o.env = { ...o.env, OTEL_ENDPOINT: 'https://telemetry.example.test' };
  expect((await deploy(o)).exitCode).toBe(0);
  expect((await store.read())!.deployment!.history).toEqual({
    version_ids: [CANDIDATE],
    plain_bindings: [
      { name: 'PB_AUTH_LOCAL', texts: ['enabled'] },
      { name: 'OTEL_ENDPOINT', texts: ['https://telemetry.example.test'] },
      { name: 'PB_PUBLIC_URL', texts: ['https://broker.example.test'] },
    ],
  });
});
it.each(['success', 'failure', 'timeout', 'interruption'])(
  'smoke preview finally disables exposure after %s',
  async (mode) => {
    const h = harness();
    const result = await deploy(options(h, { rollout: 25 }));
    expect(result.output.error).toBeNull();
    const j = (await store.read())!,
      api = new CloudflareApi({
        accountId: ACCOUNT,
        apiToken: TOKEN,
        fetch: h.fetch,
        now: h.now,
        sleep: h.sleep,
      });
    const p = withCandidatePreview(api, store, j, fixtureContract, async (url) => {
      expect(url).toBe(
        `https://${CANDIDATE.slice(0, 8).toLowerCase()}-${script}.account.workers.dev`,
      );
      expect(h.endpoints).toEqual({ enabled: false, previews_enabled: true });
      if (mode === 'timeout') await h.sleep(600_001);
      if (mode !== 'success') throw new Error(mode);
      return true;
    });
    if (mode === 'success') expect(await p).toBe(true);
    else await expect(p).rejects.toThrow(mode);
    expect(h.endpoints).toEqual({ enabled: false, previews_enabled: false });
    expect((await store.read())!.deployment!.attempt.preview).toBe('disabled');
  },
);
it('fails cleanup safely, journals interruption and reconciles previews before later activation', async () => {
  const h = harness();
  expect((await deploy(options(h, { rollout: 25 }))).exitCode).toBe(0);
  const j = (await store.read())!;
  const api = new CloudflareApi({
    accountId: ACCOUNT,
    apiToken: TOKEN,
    fetch: h.fetch,
    now: h.now,
    sleep: h.sleep,
  });
  await expect(
    withCandidatePreview(api, store, j, fixtureContract, async () => {
      h.cleanupFail = true;
      return true;
    }),
  ).rejects.toThrow();
  expect((await store.read())!.deployment!.attempt.preview).toBe('cleanup_pending');
  h.cleanupFail = false;
  const count = h.calls.filter(
    (c) => c.path === base + '/deployments' && c.method === 'POST',
  ).length;
  await deploy(options(h, { rollout: 25 }));
  expect(h.endpoints).toEqual({ enabled: false, previews_enabled: false });
  expect(
    h.calls.filter((c) => c.path === base + '/deployments' && c.method === 'POST'),
  ).toHaveLength(count);
});
it('uses zone routes at the zone API and requires a canonical matching public origin', async () => {
  const h = harness();
  const bad = await deploy(
    options(h, {
      publicUrl: 'https://wrong.example.test',
      routes: `${ZONE}:broker.example.test/*`,
    }),
  );
  expect(bad.exitCode).toBe(2);
  expect(h.calls).toHaveLength(0);
  const r = await deploy(
    options(h, {
      publicUrl: 'https://broker.example.test',
      routes: `${ZONE}:broker.example.test/*`,
    }),
  );
  expect(r.output.error).toBeNull();
  expect(h.routes).toEqual([{ id: 'managed-route', pattern: 'broker.example.test/*', script }]);
  expect(h.endpoints).toEqual({ enabled: false, previews_enabled: false });
});

it('refuses configuration drift immediately before activation and missing inherited keys on the candidate', async () => {
  const h = harness();
  h.bindingDrift = true;
  expect((await deploy(options(h))).exitCode).toBe(8);
  expect(h.calls.some((c) => c.path === base + '/deployments' && c.method === 'POST')).toBe(false);
  const j = (await store.read())!;
  j.deployment = null;
  await store.write(j);
  const erased = harness();
  erased.secretErased = true;
  expect((await deploy(options(erased))).exitCode).toBe(8);
  expect(erased.calls.some((c) => c.path === base + '/deployments' && c.method === 'POST')).toBe(
    false,
  );
});
it('refuses a maintenance shell as a prior release', async () => {
  const h = harness();
  h.versions.set(OLD, {
    id: OLD,
    annotations: { 'pb-maintenance-shell': 'true' },
    resources: { bindings: [] },
  });
  const r = await deploy(options(h));
  expect(r.output.previous_version_id).toBeNull();
  expect(r.exitCode).not.toBe(0);
  expect(mutations(h)).toHaveLength(0);
});
it('refuses existing unmanaged consumers and overlapping foreign routes before uploads', async () => {
  const h = harness();
  h.consumer = {
    consumer_id: 'foreign',
    script_name: 'other-worker',
    batch_size: 1,
    max_wait_time_ms: 1000,
    max_retries: 4,
    max_concurrency: 2,
    dead_letter_queue: `${script}-jobs-dlq`,
  };
  expect((await deploy(options(h))).exitCode).toBe(8);
  expect(mutations(h)).toHaveLength(0);
  h.consumer = null;
  h.routes = [{ id: 'foreign', pattern: '*.example.test/*', script: 'other-worker' }];
  expect(
    (
      await deploy(
        options(h, {
          routes: `${ZONE}:broker.example.test/*`,
          publicUrl: 'https://broker.example.test',
        }),
      )
    ).exitCode,
  ).toBe(8);
  expect(mutations(h)).toHaveLength(0);
});
it('rolls back exactly the captured active version and preserves custom-origin endpoint policy', async () => {
  const h = harness();
  expect((await deploy(options(h))).exitCode).toBe(0);
  const j = (await store.read())!,
    api = new CloudflareApi({
      accountId: ACCOUNT,
      apiToken: TOKEN,
      fetch: h.fetch,
      now: h.now,
      sleep: h.sleep,
    });
  h.activationLost = true;
  expect(await rollbackDeployment(api, store, j)).toBe('succeeded');
  expect(h.active.versions).toEqual([{ version_id: OLD, percentage: 100 }]);
  expect(h.endpoints).toEqual({ enabled: false, previews_enabled: false });
  expect(j.deployment!.attempt.rollback).toBe('succeeded');
});
it('refuses rollback on drift or a contract migration, and never blindly repeats unknown rollback', async () => {
  const h = harness();
  expect((await deploy(options(h))).exitCode).toBe(0);
  const j = (await store.read())!,
    api = new CloudflareApi({
      accountId: ACCOUNT,
      apiToken: TOKEN,
      fetch: h.fetch,
      now: h.now,
      sleep: h.sleep,
    });
  j.migrations.rollback_compatible = false;
  await expect(rollbackDeployment(api, store, j)).rejects.toMatchObject({ exitCode: 11 });
  j.migrations.rollback_compatible = true;
  h.active = { id: 'foreign', versions: [{ version_id: NEWEST, percentage: 100 }] };
  await expect(rollbackDeployment(api, store, j)).rejects.toMatchObject({ exitCode: 8 });
  h.active = { id: 'candidate-active', versions: [{ version_id: CANDIDATE, percentage: 100 }] };
  h.activationAbsent = true;
  h.activationLost = true;
  expect(await rollbackDeployment(api, store, j)).toBe('unknown');
  const count = mutations(h).length;
  expect(await rollbackDeployment(api, store, j)).toBe('unknown');
  expect(mutations(h)).toHaveLength(count);
});
it('rejects extra receipt fields, credential-bearing URLs and corrupted prior distributions', async () => {
  const h = harness();
  expect((await deploy(options(h))).exitCode).toBe(0);
  const j = (await store.read())!;
  await expect(
    store.write({
      ...j,
      deployment: {
        ...j.deployment!,
        attempt: { ...j.deployment!.attempt, secret: 'SENTINEL' } as never,
      },
    }),
  ).rejects.toMatchObject({ code: 'invalid_inventory' });
  const copy = structuredClone(j);
  copy.deployment!.attempt.candidate_probe_url = 'https://user:secret@example.test';
  await expect(store.write(copy)).rejects.toMatchObject({ code: 'invalid_inventory' });
  copy.deployment!.attempt.candidate_probe_url = null;
  copy.deployment!.attempt.previous_distribution = [];
  await expect(store.write(copy)).rejects.toMatchObject({ code: 'invalid_inventory' });
});

it('never reads installed master-key source values and emits only safe JSON on lost upload', async () => {
  const h = harness(),
    o = options(h, { json: true, secret: ['PB_MASTER_KEY', 'PB_MASTER_KEY_PREVIOUS'] });
  const env = { ...o.env };
  for (const name of ['PB_MASTER_KEY', 'PB_MASTER_KEY_PREVIOUS'])
    Object.defineProperty(env, name, {
      get: () => {
        throw new Error('installed key source must not be read');
      },
    });
  h.uploadLost = true;
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined),
    error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await runCloudflareDeploy({ ...o, env })).toBe(6);
  expect(log).toHaveBeenCalledTimes(1);
  expect(error).not.toHaveBeenCalled();
  expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
    command: 'deploy',
    error: { code: 'outcome_unknown' },
  });
  for (const secret of [KEY, PREVIOUS, TOKEN, 'SESSION_SENTINEL', 'COMPLETION_SENTINEL'])
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
});
it('retains pending candidate secret names without requiring source values on reconciliation', async () => {
  const h = harness();
  h.uploadLost = true;
  expect((await deploy(options(h, { secret: ['PB_IDP_TEST_CLIENT_SECRET'] }))).exitCode).toBe(6);
  const r = await deploy(options(h));
  expect(r.output.error).toBeNull();
  expect(h.calls.filter((c) => c.path === base + '/versions' && c.method === 'POST')).toHaveLength(
    1,
  );
  expect((await store.read())!.deployment!.attempt.secret_names).toContain(
    'PB_IDP_TEST_CLIENT_SECRET',
  );
});
it('retains the most recently verified receipt while a later attempt has an unknown outcome', async () => {
  const h = harness();
  expect((await deploy(options(h))).exitCode).toBe(0);
  const j = (await store.read())!,
    a = j.deployment!.attempt;
  a.phase = 'verified';
  a.smoke = 'passed';
  j.deployment!.last_verified = {
    ...structuredClone(a),
    operation_id: 'older-operation',
    version_id: OLD,
  };
  await store.write(j);
  await writeFile(
    join(out, 'worker.js'),
    'export default {fetch(){return new Response("changed")}}',
  );
  h.uploadLost = true;
  const r = await deploy(options(h));
  expect(r.exitCode).toBe(6);
  const persisted = (await store.read())!;
  expect(persisted.deployment!.last_verified!.operation_id).toBe(a.operation_id);
  expect(persisted.deployment!.attempt.operation_id).not.toBe(a.operation_id);
  expect(persisted.deployment!.attempt.previous_version_id).toBe(CANDIDATE);
});

it('restores safe managed settings after a definitive activation refusal', async () => {
  const h = harness();
  h.activationReject = true;
  const r = await deploy(options(h));
  expect(r.exitCode).toBe(1);
  expect(r.output.error?.code).toBe('permission_denied');
  expect((await store.read())!.deployment!.attempt.phase).toBe('failed');
  expect(h.active.versions).toEqual([{ version_id: OLD, percentage: 100 }]);
  expect(h.endpoints).toEqual({ enabled: false, previews_enabled: false });
  expect(r.output.checks).toContainEqual({
    name: 'configuration_restoration',
    status: 'incomplete_attachments_retained',
  });
});

it('R1 previews are journalled disabled and read back before the version upload', async () => {
  const h = harness(),
    send = h.fetch;
  let inspected = false;
  h.fetch = vi.fn(async (input, init) => {
    if (String(input).endsWith(base + '/versions') && init?.method === 'POST') {
      inspected = true;
      expect(h.endpoints).toEqual({ enabled: false, previews_enabled: false });
      const a = (await store.read())!.deployment!.attempt;
      expect(a.changes).toContainEqual({
        kind: 'endpoints',
        state: 'applied',
        restoration: 'not_needed',
      });
      const restriction = h.calls.findIndex(
        (c) => c.path === base + '/subdomain' && c.method === 'POST',
      );
      expect(
        h.calls
          .slice(restriction + 1)
          .some((c) => c.path === base + '/subdomain' && c.method === 'GET'),
      ).toBe(true);
    }
    return send(input, init);
  });
  expect((await deploy(options(h))).exitCode).toBe(0);
  expect(inspected).toBe(true);
});
it('R1 previews that cannot be restricted prevent version submission', async () => {
  const h = harness();
  h.cleanupFail = true;
  expect((await deploy(options(h))).exitCode).not.toBe(0);
  expect(h.calls.filter((c) => c.path === base + '/versions' && c.method === 'POST')).toHaveLength(
    0,
  );
});
it('R1 workers.dev remains disabled when configuration fails', async () => {
  const h = harness();
  h.endpoints = { enabled: false, previews_enabled: false };
  h.configFail = true;
  const o = options(h);
  delete o.domain;
  expect((await deploy(o)).exitCode).not.toBe(0);
  expect(h.endpoints).toEqual({ enabled: false, previews_enabled: false });
  expect(
    h.calls.some(
      (c) =>
        c.path === base + '/subdomain' &&
        c.method === 'POST' &&
        (c.body as { enabled: boolean }).enabled,
    ),
  ).toBe(false);
});
it('R1 workers.dev is enabled only after consumer and cron checks succeed', async () => {
  const h = harness(),
    send = h.fetch;
  h.endpoints = { enabled: false, previews_enabled: true };
  let enabled = false;
  h.fetch = vi.fn(async (input, init) => {
    if (
      String(input).endsWith(base + '/subdomain') &&
      init?.method === 'POST' &&
      JSON.parse(String(init.body)).enabled
    ) {
      enabled = true;
      expect(h.consumer).toMatchObject({ script_name: script, max_wait_time_ms: 1000 });
      expect(h.schedules).toEqual(['* * * * *']);
      expect(
        h.calls.some(
          (c) =>
            c.path === base + '/schedules' &&
            c.method === 'GET' &&
            h.calls.indexOf(c) >
              h.calls.findIndex((x) => x.path === base + '/schedules' && x.method === 'PUT'),
        ),
      ).toBe(true);
    }
    return send(input, init);
  });
  const o = options(h);
  delete o.domain;
  expect((await deploy(o)).exitCode).toBe(0);
  expect(enabled).toBe(true);
});
it.each([false, true])(
  'R1 rollback restricts endpoints before restoration can fail (%s)',
  async (failRestoration) => {
    const h = harness();
    expect((await deploy(options(h))).exitCode).toBe(0);
    const j = (await store.read())!,
      send = h.fetch;
    h.endpoints = { enabled: true, previews_enabled: true };
    let policyAtRestoration: unknown;
    h.fetch = vi.fn(async (input, init) => {
      if (
        String(input).endsWith(base + '/schedules') &&
        (!init?.method || init.method === 'GET') &&
        h.active.versions[0]?.version_id === OLD
      ) {
        policyAtRestoration = { ...h.endpoints };
        if (failRestoration) return new Response(TOKEN, { status: 403 });
      }
      return send(input, init);
    });
    const api = new CloudflareApi({
      accountId: ACCOUNT,
      apiToken: TOKEN,
      fetch: h.fetch,
      now: h.now,
      sleep: h.sleep,
    });
    const result = await rollbackDeployment(api, store, j);
    expect(policyAtRestoration).toEqual({ enabled: false, previews_enabled: false });
    expect(h.endpoints).toEqual({ enabled: false, previews_enabled: false });
    expect(result).toBe(failRestoration ? 'failed' : 'succeeded');
  },
);
it.each(['session', 'assets'])(
  'R1 pre-submission %s failure allows a safe repaired retry',
  async (stage) => {
    const h = harness(),
      send = h.fetch;
    let fail = true;
    h.fetch = vi.fn(async (input, init) => {
      if (
        fail &&
        new URL(String(input)).pathname.endsWith(
          stage === 'session' ? base + '/assets-upload-session' : '/workers/assets/upload',
        )
      )
        return new Response(TOKEN, { status: 403 });
      return send(input, init);
    });
    expect((await deploy(options(h))).exitCode).not.toBe(0);
    expect(
      h.calls.filter((c) => c.path === base + '/versions' && c.method === 'POST'),
    ).toHaveLength(0);
    fail = false;
    expect((await deploy(options(h))).exitCode).toBe(0);
    expect(
      h.calls.filter((c) => c.path === base + '/versions' && c.method === 'POST'),
    ).toHaveLength(1);
  },
);
async function interruptedActivation(h: ReturnType<typeof harness>) {
  h.activationAbsent = true;
  expect((await deploy(options(h))).exitCode).toBe(6);
  const j = (await store.read())!;
  expect(j.deployment!.attempt.phase).toBe('activation_pending');
  h.active = {
    id: 'accepted-before-interruption',
    versions: [{ version_id: CANDIDATE, percentage: 100 }],
  };
  h.activationAbsent = false;
}
it.each(['cron', 'consumer'])('R1 recovered activation refuses missing %s', async (missing) => {
  const h = harness();
  await interruptedActivation(h);
  if (missing === 'cron') h.schedules = [];
  else h.consumer = null;
  const count = mutations(h).length;
  expect((await deploy(options(h))).exitCode).toBe(8);
  expect((await store.read())!.deployment!.attempt.phase).toBe('activation_pending');
  expect(mutations(h)).toHaveLength(count);
});
it('R1 recovered activation finalizes worker analytics and secret-delivery receipts', async () => {
  const h = harness();
  await interruptedActivation(h);
  const count = mutations(h).length;
  expect((await deploy(options(h))).exitCode).toBe(0);
  const j = (await store.read())!,
    a = j.deployment!.attempt;
  expect(a.phase).toBe('active');
  expect(a.activated_at).not.toBeNull();
  expect(j.resources.worker).toMatchObject({
    id: script,
    state: 'complete',
    evidence: { source: 'worker_binding', verified_at: a.activated_at },
  });
  expect(j.resources.analytics).toMatchObject({
    state: 'bound',
    evidence: { source: 'worker_binding', verified_at: a.activated_at },
  });
  expect(j.secret_delivery.master_key).toBe('installed');
  expect(mutations(h)).toHaveLength(count);
});
it('R1 verified gradual deployment reaches unchanged without writes', async () => {
  const h = harness();
  expect((await deploy(options(h, { rollout: 25 }))).exitCode).toBe(0);
  const j = (await store.read())!;
  j.deployment!.attempt.phase = 'verified';
  j.deployment!.attempt.smoke = 'passed';
  await store.write(j);
  const send = h.fetch;
  h.fetch = vi.fn(async (input, init) =>
    String(input).endsWith(base + '/settings')
      ? ok({
          tags: ['pb-install-v1', `pb-owner-${identity.owner_digest}`],
          bindings: (h.versions.get(CANDIDATE)!.resources as { bindings: unknown[] }).bindings,
        })
      : send(input, init),
  );
  const count = mutations(h).length;
  const result = await deploy(options(h, { rollout: 25 }));
  expect(result.exitCode).toBe(0);
  expect(result.output.plan).toContainEqual({ stage: 'deploy', action: 'unchanged' });
  expect(mutations(h)).toHaveLength(count);
  h.active.versions = [
    { version_id: OLD, percentage: 75 },
    { version_id: NEWEST, percentage: 25 },
  ];
  expect((await deploy(options(h, { rollout: 25 }))).exitCode).toBe(8);
  expect(mutations(h)).toHaveLength(count);
});
it('R1 dry-run reports the proposed artifact identity alongside historical version IDs', async () => {
  const h = harness();
  expect((await deploy(options(h))).exitCode).toBe(0);
  await writeFile(
    join(out, 'worker.js'),
    'export default {fetch(){return new Response("round one")}}',
  );
  const info = JSON.parse(await readFile(join(out, 'build-info.json'), 'utf8'));
  info.core = '2.0.1';
  await writeFile(join(out, 'build-info.json'), JSON.stringify(info));
  const proposed = await validateDeploymentArtifact(out),
    before = await readFile(store.path),
    count = mutations(h).length;
  const result = await deploy(options(h, { dryRun: true }));
  expect(result.exitCode).toBe(0);
  expect(result.output.plan).toContainEqual({ stage: 'deploy', action: 'upload_activate' });
  expect(result.output.artifact_sha256).toBe(proposed.artifactHash);
  expect(result.output.build_info).toEqual(proposed.info);
  expect(result.output.version_id).toBe(CANDIDATE);
  expect(result.output.previous_version_id).toBe(CANDIDATE);
  expect(await readFile(store.path)).toEqual(before);
  expect(mutations(h)).toHaveLength(count);
});
it.each(['missing', 'unselected', 'installed', 'selected'])(
  'R1 telemetry headers must be installed or selected (%s)',
  async (mode) => {
    const file = join(out, 'generated/manifest.json'),
      manifest = JSON.parse(await readFile(file, 'utf8'));
    manifest.platformPorts.observability.endpointEnv = 'OTEL_ENDPOINT';
    manifest.platformPorts.observability.headersEnv = 'OTEL_HEADERS';
    await writeFile(file, JSON.stringify(manifest));
    const h = harness(),
      o = options(h);
    o.env = {
      ...o.env,
      OTEL_ENDPOINT: 'https://telemetry.example.test',
      ...(mode === 'unselected' || mode === 'selected'
        ? { OTEL_HEADERS: JSON.stringify({ authorization: 'HEADERS_SENTINEL' }) }
        : {}),
    };
    if (mode === 'installed') h.installed.push('OTEL_HEADERS');
    if (mode === 'selected') o.secret = ['OTEL_HEADERS'];
    const result = await deploy(o);
    expect(result.exitCode).toBe(mode === 'missing' || mode === 'unselected' ? 2 : 0);
    if (result.exitCode !== 0) expect(mutations(h)).toHaveLength(0);
    else expect((await store.read())!.deployment!.attempt.secret_names).toContain('OTEL_HEADERS');
    expect(JSON.stringify(result)).not.toContain('HEADERS_SENTINEL');
    expect(await readFile(store.path, 'utf8')).not.toContain('HEADERS_SENTINEL');
  },
);
it.each(['rollback', 'probe'])(
  'R1 pending-preview %s cleanup verifies ownership before mutation',
  async (caller) => {
    const h = harness();
    expect((await deploy(options(h, { rollout: 25 }))).exitCode).toBe(0);
    const j = (await store.read())!;
    j.deployment!.attempt.preview = 'cleanup_pending';
    await store.write(j);
    h.endpoints = { enabled: false, previews_enabled: true };
    const send = h.fetch,
      count = mutations(h).length;
    h.fetch = vi.fn(async (input, init) =>
      String(input).endsWith(base + '/settings')
        ? ok({ tags: [], bindings: [] })
        : send(input, init),
    );
    const api = new CloudflareApi({
      accountId: ACCOUNT,
      apiToken: TOKEN,
      fetch: h.fetch,
      now: h.now,
      sleep: h.sleep,
    });
    const probe = vi.fn(async () => true);
    await expect(
      caller === 'rollback'
        ? rollbackDeployment(api, store, j)
        : withCandidatePreview(api, store, j, fixtureContract, probe),
    ).rejects.toMatchObject({ code: 'ownership_conflict' });
    expect(mutations(h)).toHaveLength(count);
    expect(h.endpoints).toEqual({ enabled: false, previews_enabled: true });
    expect(probe).not.toHaveBeenCalled();
  },
);

it('R1 pre-submission retry can resupply selected secret values', async () => {
  const h = harness(),
    send = h.fetch;
  let fail = true;
  h.fetch = vi.fn(async (input, init) =>
    fail && String(input).endsWith(base + '/assets-upload-session')
      ? new Response(TOKEN, { status: 403 })
      : send(input, init),
  );
  const o = options(h, { secret: ['PB_IDP_TEST_CLIENT_SECRET'] });
  expect((await deploy(o)).exitCode).not.toBe(0);
  fail = false;
  expect((await deploy(o)).exitCode).toBe(0);
  expect(h.metadata!.bindings).toContainEqual({
    type: 'secret_text',
    name: 'PB_IDP_TEST_CLIENT_SECRET',
    text: 'IDP_SENTINEL',
  });
  expect(h.calls.filter((c) => c.path === base + '/versions' && c.method === 'POST')).toHaveLength(
    1,
  );
});

it.each(['success', 'configuration failure', 'candidate read failure'])(
  'R2 first creation restricts endpoints immediately (%s)',
  async (mode) => {
    const h = harness();
    h.exists = false;
    h.active = { id: null, versions: [] };
    h.installed = [];
    h.configFail = mode === 'configuration failure';
    const send = h.fetch;
    h.fetch = vi.fn(async (input, init) => {
      if (mode === 'candidate read failure' && String(input).endsWith(`/versions/${CANDIDATE}`))
        return new Response(TOKEN, { status: 403 });
      return send(input, init);
    });
    const result = await deploy(options(h, { secret: ['PB_MASTER_KEY'] }));
    expect(h.endpoints).toEqual({ enabled: false, previews_enabled: false });
    const upload = h.calls.findIndex((c) => c.path === base + '/versions' && c.method === 'POST');
    expect(
      h.calls.slice(upload + 1, upload + 5).map(({ path, method }) => ({ path, method })),
    ).toEqual([
      { path: base + '/settings', method: 'GET' },
      { path: base + '/subdomain', method: 'GET' },
      { path: base + '/subdomain', method: 'POST' },
      { path: base + '/subdomain', method: 'GET' },
    ]);
    expect((await store.read())!.deployment!.attempt.changes).toContainEqual(
      expect.objectContaining({ kind: 'endpoints', state: 'applied' }),
    );
    expect(result.exitCode === 0).toBe(mode === 'success');
    if (mode !== 'success')
      expect(h.calls.some((c) => c.path === base + '/deployments' && c.method === 'POST')).toBe(
        false,
      );
  },
);

it('R2 changed requested rollout refuses unchanged on a verified gradual receipt', async () => {
  const h = harness();
  expect((await deploy(options(h, { rollout: 25 }))).exitCode).toBe(0);
  const j = (await store.read())!;
  j.deployment!.attempt.phase = 'verified';
  j.deployment!.attempt.smoke = 'passed';
  await store.write(j);
  const send = h.fetch;
  h.fetch = vi.fn(async (input, init) =>
    String(input).endsWith(base + '/settings')
      ? ok({
          tags: ['pb-install-v1', `pb-owner-${identity.owner_digest}`],
          bindings: (h.versions.get(CANDIDATE)!.resources as { bindings: unknown[] }).bindings,
        })
      : send(input, init),
  );
  const before = await readFile(store.path),
    count = mutations(h).length;
  const result = await deploy(options(h, { rollout: 100 }));
  expect(result.exitCode).toBe(8);
  expect(result.output.error?.code).toBe('configuration_conflict');
  expect(result.output.plan).not.toContainEqual({ stage: 'deploy', action: 'unchanged' });
  expect(mutations(h)).toHaveLength(count);
  expect(await readFile(store.path)).toEqual(before);
  expect(h.active.versions).toContainEqual({ version_id: CANDIDATE, percentage: 25 });
});

it('R2 definitively rejected upload can retry after permission repair', async () => {
  const h = harness(),
    send = h.fetch;
  let reject = true,
    submissions = 0;
  h.fetch = vi.fn(async (input, init) => {
    if (String(input).endsWith(base + '/versions') && init?.method === 'POST') {
      submissions++;
      if (reject) return new Response(TOKEN, { status: 403 });
    }
    return send(input, init);
  });
  const o = options(h, { secret: ['PB_IDP_TEST_CLIENT_SECRET'] });
  expect((await deploy(o)).output.error?.code).toBe('permission_denied');
  expect((await store.read())!.deployment!.attempt.phase).toBe('preparing_upload');
  reject = false;
  expect((await deploy(o)).exitCode).toBe(0);
  expect(submissions).toBe(2);
  expect(h.versions.has(CANDIDATE)).toBe(true);
});

it.each([false, true])(
  'R2 retained attachments recover a failed configuration (prior managed consumer %s)',
  async (priorConsumer) => {
    const h = harness();
    if (priorConsumer) {
      expect((await deploy(options(h))).exitCode).toBe(0);
      const j = (await store.read())!;
      j.deployment!.attempt.phase = 'verified';
      j.deployment!.attempt.smoke = 'passed';
      j.deployment!.attempt.prior_settings.schedules = [];
      j.deployment!.attempt.intended_settings.schedules = [];
      j.deployment!.attempt.prior_settings.consumer = { ...h.consumer!, batch_size: 2 };
      j.deployment!.attempt.intended_settings.consumer!.batch_size = 2;
      h.consumer!.batch_size = 2;
      h.schedules = [];
      await store.write(j);
      await writeFile(
        join(out, 'worker.js'),
        'export default {fetch(){return new Response("retry")}}',
      );
    }
    h.configFail = true;
    expect((await deploy(options(h))).exitCode).not.toBe(0);
    const failed = (await store.read())!.deployment!.attempt;
    expect(failed.phase).toBe('failed');
    expect(h.consumer).not.toBeNull();
    expect(h.schedules).toEqual([]);
    expect(failed.changes).toContainEqual(
      expect.objectContaining({
        kind: 'consumer',
        restoration: priorConsumer ? 'restored' : 'retained_first_install',
      }),
    );
    h.configFail = false;
    const consumerWrites = h.calls.filter(
      (c) => c.path.startsWith(`/queues/${JOBS}/consumers`) && c.method !== 'GET',
    ).length;
    expect((await deploy(options(h))).exitCode).toBe(0);
    expect(h.schedules).toEqual(['* * * * *']);
    expect(
      h.calls.filter((c) => c.path.startsWith(`/queues/${JOBS}/consumers`) && c.method !== 'GET'),
    ).toHaveLength(consumerWrites + (priorConsumer ? 1 : 0));
    expect(h.calls.some((c) => c.method === 'DELETE')).toBe(false);
  },
);

it('R2 retained attachments still refuse drift after failed configuration', async () => {
  const h = harness();
  h.configFail = true;
  expect((await deploy(options(h))).exitCode).not.toBe(0);
  h.configFail = false;
  h.consumer!.max_retries = 99;
  const count = mutations(h).length;
  expect((await deploy(options(h))).output.error?.code).toBe('configuration_conflict');
  expect(mutations(h)).toHaveLength(count);
});

it('R2 definitively rejected rollback can retry after permission repair', async () => {
  const h = harness();
  expect((await deploy(options(h))).exitCode).toBe(0);
  const api = new CloudflareApi({
    accountId: ACCOUNT,
    apiToken: TOKEN,
    fetch: h.fetch,
    now: h.now,
    sleep: h.sleep,
  });
  const j = (await store.read())!;
  h.activationReject = true;
  const count = mutations(h).length;
  expect(await rollbackDeployment(api, store, j)).toBe('failed');
  const rejected = (await store.read())!;
  expect(rejected.deployment!.attempt.phase).toBe('active');
  expect(rejected.deployment!.attempt.rollback).toBe('failed');
  expect(h.active.versions).toEqual([{ version_id: CANDIDATE, percentage: 100 }]);
  h.activationReject = false;
  expect(await rollbackDeployment(api, store, rejected)).toBe('succeeded');
  expect(
    mutations(h)
      .slice(count)
      .filter((c) => c.path === base + '/deployments'),
  ).toHaveLength(2);
  expect(h.active.versions).toEqual([{ version_id: OLD, percentage: 100 }]);
});

async function telemetryArtifact() {
  const file = join(out, 'generated/manifest.json'),
    manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.platformPorts.observability.endpointEnv = 'OTEL_ENDPOINT';
  manifest.platformPorts.observability.headersEnv = 'OTEL_HEADERS';
  await writeFile(file, JSON.stringify(manifest));
}
it.each(['not-json', 'null', '[]', '"text"', '{"authorization":123}'])(
  'R2 supplied telemetry headers reject runtime-invalid JSON (%s)',
  async (headers) => {
    await telemetryArtifact();
    const h = harness(),
      o = options(h, { secret: ['OTEL_HEADERS'] });
    o.env = { ...o.env, OTEL_ENDPOINT: 'https://collector.example.test', OTEL_HEADERS: headers };
    const before = await readFile(store.path),
      result = await deploy(o);
    expect(result.exitCode).toBe(2);
    expect(result.output.error?.code).toBe('invalid_input');
    expect(mutations(h)).toHaveLength(0);
    expect(await readFile(store.path)).toEqual(before);
    expect(result.output.error?.message).toBe(
      'Invalid input or incomplete Cloudflare build; build the selected configuration first.',
    );
  },
);
it('R2 inherited telemetry headers remain name-only', async () => {
  await telemetryArtifact();
  const h = harness(),
    o = options(h);
  h.installed.push('OTEL_HEADERS');
  o.env = { ...o.env, OTEL_ENDPOINT: 'https://collector.example.test' };
  Object.defineProperty(o.env, 'OTEL_HEADERS', {
    get: () => {
      throw new Error('must not read installed headers');
    },
  });
  expect((await deploy(o)).exitCode).toBe(0);
});
it.each([
  'https://collector.example.test/otlp',
  'https://collector.example.test:4318/otlp/',
  'http://127.0.0.1:4318/otlp',
])('R2 exporter-compatible telemetry endpoint deploys (%s)', async (endpoint) => {
  await telemetryArtifact();
  const h = harness(),
    o = options(h, { secret: ['OTEL_HEADERS'] });
  o.env = {
    ...o.env,
    OTEL_ENDPOINT: endpoint,
    OTEL_HEADERS: '{"authorization":"HEADERS_SENTINEL"}',
  };
  expect((await deploy(o)).exitCode).toBe(0);
  expect(h.metadata!.bindings).toContainEqual({
    type: 'plain_text',
    name: 'OTEL_ENDPOINT',
    text: endpoint,
  });
  expect(await readFile(store.path, 'utf8')).not.toContain('HEADERS_SENTINEL');
});
it.each([
  'https://user:password@collector.example.test/otlp',
  'https://collector.example.test/otlp?token=SENTINEL',
  'https://collector.example.test/otlp#SENTINEL',
  'http://collector.example.test:4318/otlp',
])('R2 unsafe telemetry endpoint refuses mutation (%s)', async (endpoint) => {
  await telemetryArtifact();
  const h = harness(),
    o = options(h);
  h.installed.push('OTEL_HEADERS');
  o.env = { ...o.env, OTEL_ENDPOINT: endpoint };
  const result = await deploy(o);
  expect(result.exitCode).toBe(2);
  expect(mutations(h)).toHaveLength(0);
  expect(JSON.stringify(result)).not.toContain(endpoint);
});
it.each(['missing descriptor', 'null provider', 'array record', 'null manifest', 'null migration'])(
  'R2 malformed local artifact objects are invalid input (%s)',
  async (mode) => {
    const file = join(
      out,
      mode.includes('manifest') || mode.includes('migration')
        ? 'generated/manifest.json'
        : 'assets.json',
    );
    let value = JSON.parse(await readFile(file, 'utf8'));
    if (mode === 'missing descriptor') delete value.descriptor;
    if (mode === 'null provider') value.provider = null;
    if (mode === 'array record') value = [];
    if (mode === 'null manifest') value = null;
    if (mode === 'null migration') value.migrations = [null];
    await writeFile(file, JSON.stringify(value));
    const h = harness(),
      result = await deploy(options(h));
    expect(result.exitCode).toBe(2);
    expect(result.output.error?.code).toBe('invalid_input');
    expect(h.calls).toHaveLength(0);
  },
);

it('R2 first creation restricts endpoints even after a lost upload response', async () => {
  const h = harness();
  h.exists = false;
  h.active = { id: null, versions: [] };
  h.installed = [];
  h.uploadLost = true;
  const result = await deploy(options(h, { secret: ['PB_MASTER_KEY'] }));
  expect(result.exitCode).toBe(6);
  expect(h.endpoints).toEqual({ enabled: false, previews_enabled: false });
  expect((await store.read())!.deployment!.attempt.phase).toBe('upload_pending');
  expect(h.calls.filter((c) => c.path === base + '/versions' && c.method === 'POST')).toHaveLength(
    1,
  );
});

it('R2 supplied telemetry headers validate before interrupted preview cleanup', async () => {
  const h = harness();
  expect((await deploy(options(h, { rollout: 25 }))).exitCode).toBe(0);
  const j = (await store.read())!;
  j.deployment!.attempt.preview = 'cleanup_pending';
  await store.write(j);
  h.endpoints = { enabled: false, previews_enabled: true };
  await telemetryArtifact();
  const o = options(h, { secret: ['OTEL_HEADERS'] });
  o.env = { ...o.env, OTEL_ENDPOINT: 'https://collector.example.test', OTEL_HEADERS: 'not-json' };
  const before = await readFile(store.path),
    count = mutations(h).length;
  expect((await deploy(o)).exitCode).toBe(2);
  expect(mutations(h)).toHaveLength(count);
  expect(await readFile(store.path)).toEqual(before);
});

it('R2 first creation retries a refused endpoint restriction without another upload', async () => {
  const h = harness();
  h.exists = false;
  h.active = { id: null, versions: [] };
  h.installed = [];
  h.cleanupFail = true;
  const o = options(h, { secret: ['PB_MASTER_KEY'] });
  expect((await deploy(o)).exitCode).not.toBe(0);
  expect((await store.read())!.deployment!.attempt.phase).toBe('upload_pending');
  expect(h.calls.some((c) => c.path === base + '/deployments' && c.method === 'POST')).toBe(false);
  h.cleanupFail = false;
  expect((await deploy(o)).exitCode).toBe(0);
  expect(h.endpoints).toEqual({ enabled: false, previews_enabled: false });
  expect(h.calls.filter((c) => c.path === base + '/versions' && c.method === 'POST')).toHaveLength(
    1,
  );
});

const CLOSED = { enabled: false, previews_enabled: false };
const pathOf = (input: unknown) =>
  new URL(String(input)).pathname
    .replace(`/client/v4/accounts/${ACCOUNT}`, '')
    .replace('/client/v4', '');
type Fault = '403' | 'timeout' | 'unknown';
/** Fails the at-th mutation once; every attempted request is logged, including refused ones. */
function inject(h: ReturnType<typeof harness>, at: number, fault: Fault) {
  const send = h.fetch,
    log: { path: string; method: string }[] = [];
  let n = 0;
  const state = { faulted: null as { path: string; method: string } | null, log };
  h.fetch = vi.fn(async (input, init) => {
    const method = init?.method ?? 'GET',
      path = pathOf(input);
    log.push({ path, method });
    if (method !== 'GET' && ++n === at) {
      state.faulted = { path, method };
      if (fault === '403') return new Response(TOKEN, { status: 403 });
      if (fault === 'timeout') {
        await h.sleep(35_000);
        throw new Error(TOKEN);
      }
      await send(input, init);
      throw new Error(TOKEN);
    }
    return send(input, init);
  }) as typeof fetch;
  return state;
}
function api(h: ReturnType<typeof harness>) {
  return new CloudflareApi({
    accountId: ACCOUNT,
    apiToken: TOKEN,
    fetch: h.fetch,
    now: h.now,
    sleep: h.sleep,
  });
}
/** Every endpoint-flag mutation is preceded by its own Worker ownership read. */
function ownershipPrecedesEndpointWrites(log: { path: string; method: string }[]) {
  let owned = false;
  for (const c of log) {
    if (c.path === base + '/settings' && c.method === 'GET') owned = true;
    if (c.path === base + '/subdomain' && c.method !== 'GET') {
      expect(owned).toBe(true);
      owned = false;
    }
  }
}
const scenarios = {
  'existing custom origin': (h: ReturnType<typeof harness>) => {
    h.endpoints = { enabled: true, previews_enabled: true };
    return {};
  },
  'first-install custom origin': (h: ReturnType<typeof harness>) => {
    h.exists = false;
    h.active = { id: null, versions: [] };
    h.installed = [];
    return { secret: ['PB_MASTER_KEY'] };
  },
  'existing workers.dev': (h: ReturnType<typeof harness>) => {
    h.endpoints = { enabled: false, previews_enabled: true };
    return {};
  },
};
function scenarioOptions(
  h: ReturnType<typeof harness>,
  name: keyof typeof scenarios,
  extra: Partial<DeployOptions>,
) {
  const o = options(h, extra);
  if (name === 'existing workers.dev') delete o.domain;
  return o;
}
function mutationCount(name: keyof typeof scenarios) {
  void name;
  return 8;
}
const matrix = (Object.keys(scenarios) as (keyof typeof scenarios)[]).flatMap((name) =>
  Array.from({ length: mutationCount(name) }, (_, i) =>
    (['403', 'timeout', 'unknown'] as const).map((fault) => [name, i + 1, fault] as const),
  ).flat(),
);
it.each(Object.keys(scenarios) as (keyof typeof scenarios)[])(
  'R3 fault matrix enumerates every mutation of a successful %s deploy',
  async (name) => {
    const h = harness();
    const extra = scenarios[name](h);
    const state = inject(h, Number.MAX_SAFE_INTEGER, '403');
    expect((await deploy(scenarioOptions(h, name, extra))).exitCode).toBe(0);
    expect(state.log.filter((c) => c.method !== 'GET')).toHaveLength(mutationCount(name));
  },
);
it.each(matrix)(
  'R3 invariants hold after %s deploy with mutation %i failing by %s, and on the repaired rerun',
  async (name, at, fault) => {
    const h = harness();
    const extra = scenarios[name](h);
    const custom = name !== 'existing workers.dev';
    const state = inject(h, at, fault);
    const first = await deploy(scenarioOptions(h, name, extra));
    const j1 = (await store.read())!;
    const a1 = j1.deployment?.attempt;
    const safe = (exitCode: number) => {
      expect(h.calls.some((c) => c.method === 'DELETE')).toBe(false);
      if (h.exists)
        expect(h.endpoints).toEqual(
          custom || exitCode !== 0 ? CLOSED : { enabled: true, previews_enabled: false },
        );
    };
    safe(first.exitCode);
    ownershipPrecedesEndpointWrites(state.log);
    if (a1) {
      expect(first.output.version_id).toBe(a1.version_id);
      expect(first.output.previous_version_id).toBe(name.startsWith('first') ? null : OLD);
      expect(a1.previous_version_id).toBe(name.startsWith('first') ? null : OLD);
    }
    if (first.exitCode !== 0 && h.exists && a1)
      expect(first.output.checks).toContainEqual({ name: 'endpoint_policy', status: 'verified' });
    for (const secret of [KEY, PREVIOUS, TOKEN, 'SESSION_SENTINEL', 'COMPLETION_SENTINEL']) {
      expect(JSON.stringify(first)).not.toContain(secret);
      expect(await readFile(store.path, 'utf8')).not.toContain(secret);
    }
    const versionPosts = () =>
      state.log.filter((c) => c.path === base + '/versions' && c.method === 'POST').length;
    const activations = () =>
      state.log.filter((c) => c.path === base + '/deployments' && c.method === 'POST').length;
    const [uploadsBefore, activationsBefore] = [versionPosts(), activations()];
    const freshAllowed =
      !a1 ||
      !['upload_pending', 'uploaded', 'configuring', 'activation_pending'].includes(a1.phase);
    const second = await deploy(scenarioOptions(h, name, extra));
    safe(second.exitCode);
    ownershipPrecedesEndpointWrites(state.log);
    expect(versionPosts() - uploadsBefore).toBeLessThanOrEqual(freshAllowed ? 1 : 0);
    if (second.exitCode === 6) expect(activations()).toBe(activationsBefore);
    else expect(second.exitCode).toBe(0);
  },
);

it('R3 activation-time endpoint exposure is restricted before the failure returns, then recovers', async () => {
  const h = harness(),
    send = h.fetch;
  h.fetch = vi.fn(async (input, init) => {
    const r = await send(input, init);
    if (pathOf(input) === base + '/deployments' && init?.method === 'POST')
      h.endpoints = { enabled: true, previews_enabled: true };
    return r;
  }) as typeof fetch;
  const first = await deploy(options(h));
  expect(first.exitCode).toBe(8);
  expect(h.endpoints).toEqual(CLOSED);
  expect(first.output.checks).toContainEqual({ name: 'endpoint_policy', status: 'verified' });
  h.fetch = send;
  const activations = mutations(h).filter((c) => c.path === base + '/deployments').length;
  expect((await deploy(options(h))).exitCode).toBe(0);
  expect(h.endpoints).toEqual(CLOSED);
  expect(mutations(h).filter((c) => c.path === base + '/deployments')).toHaveLength(activations);
});

it.each(['rejected', 'unknown'])(
  'R3 rollback %s outcome still restricts exposed endpoints',
  async (mode) => {
    const h = harness();
    expect((await deploy(options(h))).exitCode).toBe(0);
    const j = (await store.read())!;
    h.endpoints = { enabled: true, previews_enabled: true };
    if (mode === 'rejected') h.activationReject = true;
    else {
      h.activationLost = true;
      h.activationAbsent = true;
    }
    expect(await rollbackDeployment(api(h), store, j)).toBe(
      mode === 'rejected' ? 'failed' : 'unknown',
    );
    expect(h.endpoints).toEqual(CLOSED);
    ownershipPrecedesEndpointWrites(h.calls);
  },
);

it.each([
  ['403', 1],
  ['403', 2],
  ['timeout', 1],
  ['timeout', 2],
  ['unknown', 1],
  ['unknown', 2],
] as const)('R3 rollback with %s at mutation %i leaves endpoints closed', async (fault, at) => {
  const h = harness();
  expect((await deploy(options(h))).exitCode).toBe(0);
  const j = (await store.read())!;
  h.endpoints = { enabled: true, previews_enabled: true };
  const state = inject(h, at, fault);
  const outcome = await rollbackDeployment(api(h), store, j).catch(() => 'threw');
  expect(h.endpoints).toEqual(CLOSED);
  ownershipPrecedesEndpointWrites(state.log);
  if (outcome === 'succeeded')
    expect(h.active.versions).toEqual([{ version_id: OLD, percentage: 100 }]);
});

it.each(['success', 'probe failure', 'enable 403', 'cleanup 403'])(
  'R3 preview journal resumes safely after %s',
  async (mode) => {
    const h = harness();
    expect((await deploy(options(h, { rollout: 25 }))).exitCode).toBe(0);
    const j = (await store.read())!;
    const send = h.fetch;
    let probed = false;
    h.fetch = vi.fn(async (input, init) => {
      if (
        pathOf(input) === base + '/subdomain' &&
        init?.method === 'POST' &&
        JSON.parse(String(init.body)).previews_enabled === (mode === 'enable 403')
      )
        if (mode === 'enable 403' || (mode === 'cleanup 403' && probed))
          return new Response(TOKEN, { status: 403 });
      return send(input, init);
    }) as typeof fetch;
    await withCandidatePreview(api(h), store, j, fixtureContract, async () => {
      probed = true;
      if (mode !== 'success') throw new Error('probe');
      return true;
    }).catch(() => undefined);
    const journalled = (await store.read())!.deployment!.attempt.preview;
    expect(h.endpoints.enabled).toBe(false);
    if (h.endpoints.previews_enabled) expect(journalled).not.toBe('disabled');
    h.fetch = send;
    const activations = mutations(h).filter((c) => c.path === base + '/deployments').length;
    await deploy(options(h, { rollout: 25 }));
    expect(h.endpoints).toEqual(CLOSED);
    expect((await store.read())!.deployment!.attempt.preview).toBe('disabled');
    expect(mutations(h).filter((c) => c.path === base + '/deployments')).toHaveLength(activations);
  },
);

it('R3 preview cleanup keeps its mutation reserve after a slow ownership read', async () => {
  const h = harness();
  expect((await deploy(options(h, { rollout: 25 }))).exitCode).toBe(0);
  const j = (await store.read())!,
    send = h.fetch;
  let slow = false;
  h.fetch = vi.fn(async (input, init) => {
    if (slow && pathOf(input) === base + '/settings') await h.sleep(11_000);
    return send(input, init);
  }) as typeof fetch;
  await expect(
    withCandidatePreview(api(h), store, j, fixtureContract, async () => {
      slow = true;
      throw new Error('probe');
    }),
  ).rejects.toThrow('probe');
  expect(h.endpoints).toEqual(CLOSED);
  expect(j.deployment!.attempt.preview).toBe('disabled');
});

it('R3 rollback keeps a mutation reserve for endpoint restriction after slow reads', async () => {
  const h = harness();
  expect((await deploy(options(h))).exitCode).toBe(0);
  const j = (await store.read())!,
    send = h.fetch;
  h.endpoints = { enabled: true, previews_enabled: true };
  h.fetch = vi.fn(async (input, init) => {
    if ((init?.method ?? 'GET') === 'GET') await h.sleep(3_000);
    return send(input, init);
  }) as typeof fetch;
  expect(await rollbackDeployment(api(h), store, j)).toBe('succeeded');
  expect(h.active.versions).toEqual([{ version_id: OLD, percentage: 100 }]);
  expect(h.endpoints).toEqual(CLOSED);
});

it('R3 deploy recovery reserves its own budget after the main budget is exhausted', async () => {
  const h = harness(),
    send = h.fetch;
  h.endpoints = CLOSED;
  let started: number | undefined;
  h.fetch = vi.fn(async (input, init) => {
    started ??= h.now();
    if (pathOf(input) === base + '/deployments' && init?.method === 'POST') {
      await h.sleep(started + 600_000 - 14_000 - h.now());
      return new Response(TOKEN, { status: 403 });
    }
    return send(input, init);
  }) as typeof fetch;
  const o = options(h);
  delete o.domain;
  const r = await deploy(o);
  expect(r.output.error?.code).toBe('permission_denied');
  expect(h.endpoints).toEqual(CLOSED);
  expect(r.output.checks).toContainEqual({ name: 'endpoint_policy', status: 'verified' });
  expect((await store.read())!.deployment!.attempt.phase).toBe('failed');
});

it('R3 recovery never mutates endpoints of a Worker whose ownership changed', async () => {
  const h = harness(),
    send = h.fetch;
  h.endpoints = CLOSED;
  let foreign = false;
  h.fetch = vi.fn(async (input, init) => {
    const path = pathOf(input);
    if (path === base + '/deployments' && init?.method === 'POST') {
      foreign = true;
      return new Response(TOKEN, { status: 403 });
    }
    if (foreign && path === base + '/settings') return ok({ tags: [], bindings: [] });
    return send(input, init);
  }) as typeof fetch;
  const o = options(h);
  delete o.domain;
  const r = await deploy(o);
  expect(r.exitCode).not.toBe(0);
  expect(r.output.checks).toContainEqual({ name: 'endpoint_policy', status: 'ownership_conflict' });
  const enabledAt = h.calls.findIndex(
    (c) =>
      c.path === base + '/subdomain' &&
      c.method === 'POST' &&
      (c.body as { enabled: boolean }).enabled,
  );
  expect(h.calls.slice(enabledAt + 1).filter((c) => c.method !== 'GET')).toEqual([]);
});

it('R3 a completed rollback is recognised as restored managed settings', async () => {
  const h = harness();
  expect((await deploy(options(h))).exitCode).toBe(0);
  const j = (await store.read())!;
  j.deployment!.attempt.phase = 'verified';
  j.deployment!.attempt.smoke = 'passed';
  j.deployment!.attempt.prior_settings.schedules = [];
  j.deployment!.attempt.intended_settings.schedules = [];
  j.deployment!.attempt.prior_settings.consumer = { ...h.consumer!, batch_size: 2 };
  j.deployment!.attempt.intended_settings.consumer!.batch_size = 2;
  h.consumer!.batch_size = 2;
  h.schedules = [];
  await store.write(j);
  await writeFile(join(out, 'worker.js'), 'export default {fetch(){return new Response("r3")}}');
  expect((await deploy(options(h))).exitCode).toBe(0);
  expect(h.consumer!.batch_size).toBe(1);
  const second = (await store.read())!;
  expect(await rollbackDeployment(api(h), store, second)).toBe('succeeded');
  expect(h.consumer!.batch_size).toBe(2);
  const r = await deploy(options(h));
  expect(r.output.error).toBeNull();
  expect(r.exitCode).toBe(0);
  expect(h.calls.some((c) => c.method === 'DELETE')).toBe(false);
});

it('R3 a partially created route collection is retained and completed after repair', async () => {
  const h = harness(),
    send = h.fetch;
  let posts = 0,
    reject = true;
  h.fetch = vi.fn(async (input, init) => {
    const path = pathOf(input),
      method = init?.method ?? 'GET';
    if (path.startsWith(`/zones/${ZONE}/workers/routes`) && method !== 'GET') {
      h.calls.push({ path, method, body: JSON.parse(String(init!.body)), auth: null });
      const body = JSON.parse(String(init!.body));
      if (method === 'POST') {
        if (++posts === 2 && reject) return new Response(TOKEN, { status: 403 });
        h.routes.push({ ...body, id: `route-${posts}` });
      } else {
        const id = path.split('/').at(-1);
        h.routes = h.routes.map((r) => (r.id === id ? { ...body, id } : r));
      }
      return ok({});
    }
    return send(input, init);
  }) as typeof fetch;
  const o = options(h, {
    publicUrl: 'https://broker.example.test',
    routes: `${ZONE}:broker.example.test/*\n${ZONE}:broker.example.test/api/*`,
  });
  delete o.domain;
  expect((await deploy(o)).output.error?.code).toBe('permission_denied');
  expect(h.routes).toHaveLength(1);
  reject = false;
  const r = await deploy(o);
  expect(r.output.error).toBeNull();
  expect(h.routes.map((x) => x.pattern).sort()).toEqual([
    'broker.example.test/*',
    'broker.example.test/api/*',
  ]);
  expect(h.endpoints).toEqual(CLOSED);
  expect(h.calls.some((c) => c.method === 'DELETE')).toBe(false);
});

it.each([true, false])(
  'R3 first install inspects independent attachments before writes (dry run %s)',
  async (dryRun) => {
    const h = harness();
    h.exists = false;
    h.active = { id: null, versions: [] };
    h.installed = [];
    h.consumer = {
      consumer_id: 'foreign',
      script_name: 'other-worker',
      batch_size: 1,
      max_wait_time_ms: 1000,
      max_retries: 4,
      max_concurrency: 2,
      dead_letter_queue: `${script}-jobs-dlq`,
    };
    const r = await deploy(options(h, { dryRun, secret: ['PB_MASTER_KEY'] }));
    expect(r.exitCode).toBe(8);
    expect(mutations(h)).toEqual([]);
  },
);

it.each(['PB_PUBLIC_URL', 'DB', 'JOBS', 'ASSETS', 'PB_AUTH_LOCAL'])(
  'R3 telemetry endpoint name colliding with generated binding %s refuses before requests',
  async (name) => {
    const file = join(out, 'generated/manifest.json'),
      manifest = JSON.parse(await readFile(file, 'utf8'));
    manifest.platformPorts.observability.endpointEnv = name;
    await writeFile(file, JSON.stringify(manifest));
    const h = harness(),
      o = options(h);
    o.env = { ...o.env, [name]: 'https://collector.example.test' };
    const r = await deploy(o);
    expect(r.exitCode).toBe(2);
    expect(h.calls).toHaveLength(0);
  },
);

it('R3 an unregistered account subdomain (404) is the guided refusal', async () => {
  const h = harness(),
    send = h.fetch;
  h.fetch = vi.fn(async (input, init) =>
    pathOf(input) === '/workers/subdomain'
      ? new Response(TOKEN, { status: 404 })
      : send(input, init),
  ) as typeof fetch;
  const o = options(h);
  delete o.domain;
  const r = await deploy(o);
  expect(r.exitCode).toBe(2);
  expect(r.output.error?.code).toBe('workers_dev_subdomain_missing');
  expect(mutations(h)).toEqual([]);
});

it('R3 reconciliation dry run keeps the journalled prior version', async () => {
  const h = harness();
  await interruptedActivation(h);
  const before = await readFile(store.path);
  const r = await deploy(options(h, { dryRun: true }));
  expect(r.exitCode).toBe(0);
  expect(r.output.plan).toContainEqual({ stage: 'deploy', action: 'reconcile' });
  expect(r.output.version_id).toBe(CANDIDATE);
  expect(r.output.previous_version_id).toBe(OLD);
  expect(await readFile(store.path)).toEqual(before);
});

/** Leaves 40 s of the 600 s deploy budget once `trigger` sees its request: below the 50 s mutation reserve. */
function exhaustBudgetAt(
  h: ReturnType<typeof harness>,
  trigger: (path: string, method: string, seen: { path: string; method: string }[]) => boolean,
) {
  const send = h.fetch,
    seen: { path: string; method: string }[] = [];
  let started: number | undefined,
    fired = false;
  h.fetch = vi.fn(async (input, init) => {
    started ??= h.now();
    const path = pathOf(input),
      method = init?.method ?? 'GET';
    seen.push({ path, method });
    const response = await send(input, init);
    if (!fired && trigger(path, method, seen)) {
      fired = true;
      await h.sleep(started + 600_000 - 40_000 - h.now());
    }
    return response;
  }) as typeof fetch;
  return { seen, restore: () => (h.fetch = send) };
}
it('R4 an upload rejected locally by the mutation budget stays retryable', async () => {
  const h = harness();
  const run = exhaustBudgetAt(h, (path) => path === '/workers/assets/upload');
  const first = await deploy(options(h));
  expect(first.output.error?.code).toBe('deadline_exceeded');
  expect(run.seen.filter((c) => c.path === base + '/versions' && c.method === 'POST')).toEqual([]);
  expect((await store.read())!.deployment!.attempt.phase).toBe('preparing_upload');
  run.restore();
  const second = await deploy(options(h));
  expect(second.output.error).toBeNull();
  expect(h.calls.filter((c) => c.path === base + '/versions' && c.method === 'POST')).toHaveLength(
    1,
  );
});
it('R4 an activation rejected locally by the mutation budget stays retryable', async () => {
  const h = harness();
  const run = exhaustBudgetAt(h, (path, method, seen) => {
    const configured = seen.findIndex((c) => c.path === '/workers/domains' && c.method === 'PUT');
    const reads = seen.filter(
      (c, i) => i > configured && c.path === base + '/deployments' && c.method === 'GET',
    );
    return (
      configured >= 0 && path === base + '/deployments' && method === 'GET' && reads.length === 2
    );
  });
  const first = await deploy(options(h));
  expect(first.output.error?.code).toBe('deadline_exceeded');
  expect(run.seen.filter((c) => c.path === base + '/deployments' && c.method === 'POST')).toEqual(
    [],
  );
  expect((await store.read())!.deployment!.attempt.phase).not.toBe('activation_pending');
  run.restore();
  const second = await deploy(options(h));
  expect(second.output.error).toBeNull();
  expect(h.active.versions[0]?.version_id).not.toBe(OLD);
});
it.each([false, true])(
  'R4 a refused activation is journalled before a failing read-back (restoration read fails too: %s)',
  async (persistent) => {
    const h = harness(),
      send = h.fetch;
    h.activationReject = true;
    let refused = false,
      failures = 0;
    h.fetch = vi.fn(async (input, init) => {
      const path = pathOf(input),
        method = init?.method ?? 'GET';
      if (path === base + '/deployments' && method === 'POST') refused = true;
      else if (
        refused &&
        path === base + '/deployments' &&
        method === 'GET' &&
        (persistent || failures === 0)
      ) {
        failures++;
        return new Response(TOKEN, { status: 403 });
      }
      return send(input, init);
    }) as typeof fetch;
    expect((await deploy(options(h))).exitCode).not.toBe(0);
    expect((await store.read())!.deployment!.attempt.phase).not.toBe('activation_pending');
    h.fetch = send;
    h.activationReject = false;
    const second = await deploy(options(h));
    expect(second.output.error).toBeNull();
    expect(h.endpoints).toEqual(CLOSED);
  },
);
it('R4 a refused rollback is journalled before a failing read-back and can retry', async () => {
  const h = harness();
  expect((await deploy(options(h))).exitCode).toBe(0);
  const j = (await store.read())!,
    send = h.fetch;
  h.activationReject = true;
  let refused = false;
  h.fetch = vi.fn(async (input, init) => {
    const path = pathOf(input),
      method = init?.method ?? 'GET';
    if (path === base + '/deployments' && method === 'POST') refused = true;
    else if (refused && path === base + '/deployments' && method === 'GET') {
      refused = false;
      return new Response(TOKEN, { status: 403 });
    }
    return send(input, init);
  }) as typeof fetch;
  await expect(rollbackDeployment(api(h), store, j)).rejects.toMatchObject({
    code: 'permission_denied',
  });
  const after = (await store.read())!.deployment!.attempt;
  expect(after.phase).toBe('active');
  expect(after.rollback).toBe('failed');
  h.fetch = send;
  h.activationReject = false;
  expect(await rollbackDeployment(api(h), store, (await store.read())!)).toBe('succeeded');
  expect(h.active.versions).toEqual([{ version_id: OLD, percentage: 100 }]);
});
it('R4 routes in previously managed zones stay visible and refuse silent removal', async () => {
  const h = harness();
  const routed = options(h, {
    publicUrl: 'https://broker.example.test',
    routes: `${ZONE}:broker.example.test/*`,
  });
  delete routed.domain;
  expect((await deploy(routed)).output.error).toBeNull();
  const j = (await store.read())!;
  j.deployment!.attempt.phase = 'verified';
  j.deployment!.attempt.smoke = 'passed';
  await store.write(j);
  const count = mutations(h).length,
    before = await readFile(store.path);
  const plain = options(h);
  delete plain.domain;
  const r = await deploy(plain);
  expect(r.exitCode).toBe(8);
  expect(mutations(h)).toHaveLength(count);
  expect(await readFile(store.path)).toEqual(before);
  expect(h.routes).toHaveLength(1);
  expect(h.endpoints).toEqual(CLOSED);
});
it('R4 a managed hostname reassigned to another environment is not unchanged', async () => {
  const h = harness();
  expect((await deploy(options(h))).exitCode).toBe(0);
  const j = (await store.read())!;
  j.deployment!.attempt.phase = 'verified';
  j.deployment!.attempt.smoke = 'passed';
  await store.write(j);
  const count = mutations(h).length;
  expect((await deploy(options(h))).output.plan).toContainEqual({
    stage: 'deploy',
    action: 'unchanged',
  });
  h.domain = { ...h.domain!, environment: 'staging' };
  const r = await deploy(options(h));
  expect(r.exitCode).toBe(8);
  expect(r.output.plan).not.toContainEqual({ stage: 'deploy', action: 'unchanged' });
  expect(mutations(h)).toHaveLength(count);
});
it('R4 rollback verifies managed settings the candidate left unchanged', async () => {
  const h = harness();
  expect((await deploy(options(h))).exitCode).toBe(0);
  const j = (await store.read())!;
  j.deployment!.attempt.phase = 'verified';
  j.deployment!.attempt.smoke = 'passed';
  await store.write(j);
  await writeFile(join(out, 'worker.js'), 'export default {fetch(){return new Response("r4")}}');
  expect((await deploy(options(h))).exitCode).toBe(0);
  const second = (await store.read())!;
  expect(second.deployment!.attempt.changes).toEqual([]);
  h.schedules = [];
  expect(await rollbackDeployment(api(h), store, second)).toBe('failed');
  expect(second.deployment!.attempt.rollback).toBe('failed');
  expect(h.endpoints).toEqual(CLOSED);
});

function lifecycleHarness() {
  const h = harness();
  h.installed = ['PB_MASTER_KEY'];
  h.endpoints = { enabled: false, previews_enabled: false };
  h.exists = false;
  h.active = { id: null, versions: [] };
  h.versions.clear();
  const provider = h.fetch;
  const transport: typeof fetch = vi.fn(async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== 'https://api.cloudflare.com') {
      if (url.pathname === '/health/ready') return Response.json({ status: 'ready' });
      return envelopeResponse(
        401,
        'unauthorized',
        'fixed message',
        'request-1',
        undefined,
        url.pathname.endsWith('/npm/-/ping') ? 'npm' : 'nested',
      );
    }
    const path = url.pathname
      .replace(`/client/v4/accounts/${ACCOUNT}`, '')
      .replace('/client/v4', '');
    if (init?.method === 'DELETE') {
      h.calls.push({ path, method: 'DELETE', body: undefined, auth: null });
      if (path === base) {
        h.exists = false;
        h.versions.clear();
      }
      if (path.endsWith('/consumers/managed-consumer')) h.consumer = null;
      if (path.endsWith('/domains/managed-domain')) h.domain = null;
      return ok(null);
    }
    if (path === '/workers/domains/managed-domain') return ok(h.domain);
    if (path === '/zones') return ok([]);
    if (path === '/queues')
      return ok([
        { queue_id: JOBS, queue_name: `${script}-jobs` },
        { queue_id: DLQ, queue_name: `${script}-jobs-dlq` },
      ]);
    if (path === '/r2/buckets') return ok({ buckets: [] });
    if (path.endsWith('/configuration')) return ok({ queues: [] });
    if (path.endsWith('/objects')) return ok([], { is_truncated: false });
    if (path.endsWith('/domains/custom')) return ok({ domains: [] });
    if (/\/(?:cors|lifecycle|lock)$/.test(path)) return ok({ rules: [] });
    if (/\/(?:domains\/managed|sippy)$/.test(path)) return ok({ enabled: false });
    return provider(input, init);
  });
  h.fetch = transport;
  return h;
}

it('smokes the adopted script-create version with its create annotation and enabled workers.dev', async () => {
  const h = lifecycleHarness();
  const o = options(h, { secret: ['PB_MASTER_KEY'] });
  delete o.contract;
  delete o.domain;
  const deployed = await deploy(o);
  expect(deployed.output.error).toBeNull();
  expect(deployed.output.version_id).toBe(CREATED);
  const checked = await smoke({
    workerName: 'broker',
    projectRoot: project,
    env: o.env,
    fetch: h.fetch,
    now: h.now,
    sleep: h.sleep,
  });
  expect(checked.output.error).toBeNull();
  expect(checked.exitCode).toBe(0);
  expect((await store.read())!.deployment!.attempt.phase).toBe('verified');
  expect(h.calls.filter((c) => c.path === base + '/versions' && c.method === 'POST')).toEqual([]);
  expect(h.endpoints).toEqual({ enabled: true, previews_enabled: false });
});

it.each([false, true])(
  'chains three real deploy/smoke cycles into teardown with foreign version=%s',
  async (foreign) => {
    const h = lifecycleHarness();
    for (let cycle = 0; cycle < 3; cycle++) {
      await writeFile(
        join(out, 'worker.js'),
        `export default { fetch() { return new Response("cycle ${cycle}") } };`,
      );
      const deployed = await deploy(options(h, { secret: ['PB_MASTER_KEY'] }));
      expect(deployed.output.error).toBeNull();
      expect(deployed.exitCode).toBe(0);
      const checked = await smoke({
        workerName: 'broker',
        projectRoot: project,
        env: options(h).env,
        fetch: h.fetch,
        now: h.now,
        sleep: h.sleep,
      });
      expect(checked.output.error).toBeNull();
      expect(checked.exitCode).toBe(0);
    }
    const j = (await store.read())!;
    expect(j.deployment!.history!.version_ids).toEqual([CANDIDATE, NEWEST, THIRD]);
    expect(j.deployment!.last_verified!.version_id).toBe(THIRD);
    if (foreign)
      h.versions.set('foreign-version', { id: 'foreign-version', resources: { bindings: [] } });
    const before = h.calls.length;
    const result = await teardown({
      project,
      inventory: store.path,
      env: options(h).env,
      fetch: h.fetch,
      now: h.now,
      sleep: h.sleep,
      inventoryId: identity.owner_digest,
      iUnderstandThisDeletes: true,
    });
    expect(result.exitCode).toBe(foreign ? 8 : 0);
    if (foreign) expect(h.calls.slice(before).every((call) => call.method === 'GET')).toBe(true);
    else {
      expect(h.exists).toBe(false);
      expect(h.versions.size).toBe(0);
      expect(result.output.checks).toContainEqual({ name: 'r2', status: 'deleted' });
    }
  },
);

it.each([false, true])(
  'chains telemetry deploys with a changed endpoint into teardown with drift=%s',
  async (drift) => {
    const file = join(out, 'generated/manifest.json');
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    manifest.platformPorts.observability.endpointEnv = 'OTEL_ENDPOINT';
    await writeFile(file, JSON.stringify(manifest));
    const h = lifecycleHarness();
    for (const endpoint of [
      'https://telemetry.example.test/v1',
      'https://telemetry.example.test/v2',
    ]) {
      const o = options(h, { secret: ['PB_MASTER_KEY'] });
      o.env = { ...o.env, OTEL_ENDPOINT: endpoint };
      expect((await deploy(o)).exitCode).toBe(0);
      expect(
        (
          await smoke({
            workerName: 'broker',
            projectRoot: project,
            env: o.env,
            fetch: h.fetch,
            now: h.now,
            sleep: h.sleep,
          })
        ).exitCode,
      ).toBe(0);
    }
    expect((await store.read())!.deployment!.history!.plain_bindings).toEqual([
      { name: 'PB_AUTH_LOCAL', texts: ['enabled'] },
      {
        name: 'OTEL_ENDPOINT',
        texts: ['https://telemetry.example.test/v1', 'https://telemetry.example.test/v2'],
      },
      { name: 'PB_PUBLIC_URL', texts: ['https://broker.example.test'] },
    ]);
    if (drift) {
      const version = h.versions.get(CANDIDATE)!;
      (version.resources as { bindings: unknown[] }).bindings.push({
        type: 'plain_text',
        name: 'OTEL_ENDPOINT',
        text: 'https://foreign.example.test',
      });
    }
    const before = h.calls.length;
    const result = await teardown({
      project,
      inventory: store.path,
      env: options(h).env,
      fetch: h.fetch,
      now: h.now,
      sleep: h.sleep,
      inventoryId: identity.owner_digest,
      iUnderstandThisDeletes: true,
    });
    expect(result.exitCode).toBe(drift ? 8 : 0);
    if (drift) expect(h.calls.slice(before).every((call) => call.method === 'GET')).toBe(true);
  },
);

it.each([false, true])(
  'chains three public origins into teardown with historical URL drift=%s',
  async (drift) => {
    const h = lifecycleHarness();
    const origins = [
      'https://first.example.test',
      'https://second.example.test',
      'https://third.example.test',
    ];
    for (const origin of origins) {
      const o = options(h, { publicUrl: origin, secret: ['PB_MASTER_KEY'] });
      delete o.domain;
      const deployed = await deploy(o);
      expect(deployed.output.error).toBeNull();
      expect(deployed.exitCode).toBe(0);
      const checked = await smoke({
        workerName: 'broker',
        projectRoot: project,
        env: o.env,
        fetch: h.fetch,
        now: h.now,
        sleep: h.sleep,
      });
      expect(checked.output.error).toBeNull();
      expect(checked.exitCode).toBe(0);
    }
    if (drift) {
      const bindings = h.versions.get(CANDIDATE)!.resources as {
        bindings: { name: string; text?: string }[];
      };
      bindings.bindings.find((binding) => binding.name === 'PB_PUBLIC_URL')!.text =
        'https://foreign.example.test';
    }
    const before = h.calls.length;
    const result = await teardown({
      project,
      inventory: store.path,
      env: options(h).env,
      fetch: h.fetch,
      now: h.now,
      sleep: h.sleep,
      inventoryId: identity.owner_digest,
      iUnderstandThisDeletes: true,
    });
    expect(result.exitCode).toBe(drift ? 8 : 0);
    if (drift) expect(h.calls.slice(before).every((call) => call.method === 'GET')).toBe(true);
    expect((await store.read())!.deployment!.history!.plain_bindings).toContainEqual({
      name: 'PB_PUBLIC_URL',
      texts: origins,
    });
  },
);

it.each(['versions', 'plainValues'] as const)(
  'refuses history %s exhaustion before any deployment mutation',
  async (limit) => {
    const h = harness();
    expect((await deploy(options(h, { secret: ['PB_MASTER_KEY'] }))).exitCode).toBe(0);
    const j = (await store.read())!;
    j.deployment!.attempt.phase = 'verified';
    j.deployment!.attempt.smoke = 'passed';
    if (limit === 'versions') {
      j.deployment!.history!.version_ids = [
        CANDIDATE,
        ...Array.from({ length: 9999 }, (_, i) => `version-${i}`),
      ];
    } else {
      j.deployment!.history!.plain_bindings = [
        {
          name: 'OTEL_ENDPOINT',
          texts: Array.from({ length: 64 }, (_, i) => `https://telemetry.example.test/${i}`),
        },
      ];
      const file = join(out, 'generated/manifest.json');
      const manifest = JSON.parse(await readFile(file, 'utf8'));
      manifest.platformPorts.observability.endpointEnv = 'OTEL_ENDPOINT';
      await writeFile(file, JSON.stringify(manifest));
    }
    await store.write(j);
    const count = mutations(h).length;
    const o = options(h, { secret: ['PB_IDP_TEST_CLIENT_SECRET'] });
    o.env = { ...o.env, OTEL_ENDPOINT: 'https://telemetry.example.test/new' };
    const result = await deploy(o);
    expect(result.exitCode).toBe(2);
    expect(result.output.error?.code).toBe('capacity_exceeded');
    expect(result.output.error?.message).toContain('Deployment history capacity reached');
    expect(mutations(h)).toHaveLength(count);
    expect((await store.read())!.deployment!.history).toEqual(j.deployment!.history);
  },
);

it.each(['default', 'worker_id'] as const)(
  'looks up versions with the %s provider listing',
  async (listing) => {
    const { h, o } = firstInstall();
    if (listing === 'default') providerReadback(h, o);
    else providerReadback(h, o, listing);
    const inner = o.fetch!;
    const fullPaths: string[] = [];
    let loseCreate = true;
    o.fetch = (async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.includes('/workers/workers/')) fullPaths.push(path);
      const response = await inner(input, init);
      if (loseCreate && path.endsWith(base) && init?.method === 'PUT') {
        loseCreate = false;
        throw new Error('create acknowledgement lost');
      }
      return response;
    }) as typeof fetch;
    expect((await deploy(o)).output.error?.code).toBe('outcome_unknown');
    const result = await deploy(o);
    expect(result.output.error).toBeNull();
    expect(result.output.version_id).toBe(CREATED);
    expect(fullPaths.length).toBeGreaterThan(0);
    const lookup =
      listing === 'default' ? script : providerFixtures.workerWithId.result[0]!.worker_id;
    for (const path of fullPaths) expect(path).toContain(`/workers/workers/${lookup}/versions/`);
  },
);

it('refuses an unsafe Worker identity for version lookup', async () => {
  const { h, o } = firstInstall();
  providerReadback(h, o);
  const inner = o.fetch!;
  let fullReads = 0;
  o.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.includes('/workers/workers/')) fullReads++;
    const response = await inner(input, init);
    if (!path.endsWith('/workers/scripts')) return response;
    const envelope = object(await response.json());
    for (const worker of envelope.result as Record<string, unknown>[]) {
      worker.worker_id = '../foreign';
    }
    return Response.json(envelope);
  }) as typeof fetch;
  const result = await deploy(o);
  expect(result.output.error?.code).toBe('configuration_conflict');
  expect(result.output.checks).toContainEqual({
    name: 'worker:identity',
    status: 'configuration_conflict',
  });
  expect(fullReads).toBe(0);
  expect(h.endpoints.enabled).toBe(false);
});

it.each([true, false, null, undefined])(
  'preserves supported dirty provenance (%s) in deployment receipts',
  async (dirty) => {
    const file = join(out, 'build-info.json');
    const info = JSON.parse(await readFile(file, 'utf8'));
    info.dirty = dirty;
    info.gitSha = 'd'.repeat(40);
    await writeFile(file, JSON.stringify(info));
    const h = harness();
    expect((await deploy(options(h))).exitCode).toBe(0);
    expect((await store.read())!.deployment!.attempt.build_info).toEqual(info);
  },
);

it.each(['SENTINEL', 1, {}, []])(
  'rejects invalid dirty provenance (%j) before provider requests',
  async (dirty) => {
    const file = join(out, 'build-info.json');
    const info = JSON.parse(await readFile(file, 'utf8'));
    info.dirty = dirty;
    await writeFile(file, JSON.stringify(info));
    const h = harness();
    const result = await deploy(options(h));
    expect(result.output.error?.code).toBe('invalid_input');
    expect(h.calls).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain('SENTINEL');
  },
);

it.each([
  [undefined, undefined],
  [{ enabled: true }, { enabled: true }],
  [{ enabled: false }, { enabled: false }],
  [
    { enabled: true, headSamplingRate: 0.05, destinations: ['collector'], persist: false },
    { enabled: true, head_sampling_rate: 0.05, destinations: ['collector'], persist: false },
  ],
])('uploads only configured automatic tracing fields: %j', async (traces, expected) => {
  const manifestPath = join(out, 'generated/manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (traces !== undefined) manifest.platformPorts.observability.traces = traces;
  await writeFile(manifestPath, JSON.stringify(manifest));
  const { h, o } = firstInstall();
  expect((await deploy(o)).output.error).toBeNull();
  const uploads = h.calls.filter(
    (call) => call.body instanceof FormData && call.body.has('metadata'),
  );
  expect(uploads.length).toBeGreaterThan(0);
  for (const upload of uploads) {
    const metadata = JSON.parse(String((upload.body as FormData).get('metadata')));
    expect(metadata.observability).toEqual({
      enabled: true,
      logs: { invocation_logs: false },
      ...(expected === undefined ? {} : { traces: expected }),
    });
    if (expected === undefined) expect(metadata.observability).not.toHaveProperty('traces');
  }
});

it.each([
  [undefined, undefined],
  [{ enabled: true }, { enabled: true }],
  [{ enabled: false }, { enabled: false }],
  [
    { enabled: true, headSamplingRate: 0.05, destinations: ['collector'], persist: false },
    { enabled: true, head_sampling_rate: 0.05, destinations: ['collector'], persist: false },
  ],
])('maps configured trace metadata without changing the input: %j', (traces, expected) => {
  const original = structuredClone(traces);
  expect(tracesMetadata(traces)).toEqual(expected);
  expect(traces).toEqual(original);
});

it('resolves a first-install custom domain through the production contract', async () => {
  const { h, o } = firstInstall();
  o.domain = 'example.com';
  const send = h.fetch;
  o.fetch = vi.fn(async (input, init) =>
    new URL(String(input)).pathname === '/client/v4/zones'
      ? new Response(JSON.stringify(providerFixtures.zonesApex))
      : send(input, init),
  );
  const result = await deploy(o);
  expect(result.output.error).toBeNull();
  expect(h.calls).toContainEqual(
    expect.objectContaining({
      path: '/workers/domains',
      method: 'PUT',
      body: expect.objectContaining({ zone_id: '1'.repeat(32), hostname: 'example.com' }),
    }),
  );
  expect(
    vi.mocked(o.fetch).mock.calls.some(([url]) => String(url).includes('/zones?name=example.com&')),
  ).toBe(true);
});
it.each(['domain', 'publicUrl'] as const)(
  'requires account registration before gradual rollout writes with %s',
  async (option) => {
    const h = harness();
    h.subdomain = null;
    const o = options(h, { rollout: 25 });
    if (option === 'publicUrl') {
      delete o.domain;
      o.publicUrl = 'https://broker.example.test';
    }
    expect((await deploy(o)).output.error?.code).toBe('workers_dev_subdomain_missing');
    expect(mutations(h)).toEqual([]);
  },
);

it.each(['domain_zone_not_found', 'domain_zone_ambiguous'] as const)(
  'preserves resolver error %s before writes',
  async (code) => {
    const { h, o } = firstInstall();
    o.domain = 'example.com';
    o.contract = {
      ...cloudflareDeployContract,
      domainZone: async () => {
        throw new CloudflareError(code, 1, false, 'deploy');
      },
    };
    expect((await deploy(o)).output.error).toMatchObject({ code, stage: 'deploy' });
    expect(mutations(h)).toEqual([]);
  },
);
it('treats a malformed contract zone id as provider failure before writes', async () => {
  const { h, o } = firstInstall();
  o.domain = 'example.com';
  o.contract = { ...cloudflareDeployContract, domainZone: async () => 'invalid' };
  expect((await deploy(o)).output.error).toMatchObject({
    code: 'provider_failure',
    stage: 'deploy',
  });
  expect(mutations(h)).toEqual([]);
});

const routeFlags = {
  publicUrl: 'https://broker.example.test',
  routes: `${ZONE}:broker.example.test/*`,
};
const routeChecks = (output: Awaited<ReturnType<typeof deploy>>['output']) =>
  output.checks.filter((check) => check.name === 'routes' || check.name.startsWith('routes:'));
const conflictChecks = (...names: string[]) =>
  names.map((name) => ({ name, status: 'configuration_conflict' }));
const routeMutations = (h: ReturnType<typeof harness>) =>
  mutations(h).filter((call) => call.path.includes('/workers/routes'));

function routedFirstInstall() {
  const { h, o } = firstInstall();
  Object.assign(o, routeFlags);
  const send = h.fetch;
  h.fetch = vi.fn(async (input, init) => {
    if (pathOf(input) === `/zones/${ZONE}/workers/routes` && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      h.calls.push({ path: pathOf(input), method: 'POST', body, auth: null });
      const route = { ...body, id: '8'.repeat(32) };
      h.routes.push(route);
      return ok(route);
    }
    return send(input, init);
  }) as typeof fetch;
  o.fetch = h.fetch;
  return { h, o };
}

it('installs routes in an empty zone on the recorded snapshot shape', async () => {
  const { h, o } = routedFirstInstall();
  const result = await deploy(o);
  expect(result.output.error).toBeNull();
  expect(result.exitCode).toBe(0);
  expect(h.routes).toEqual([{ id: '8'.repeat(32), pattern: 'broker.example.test/*', script }]);
  expect(routeMutations(h).map(({ method }) => method)).toEqual(['POST']);
});

it('leaves a foreign sibling host route untouched', async () => {
  const { h, o } = routedFirstInstall();
  const foreign = {
    ...providerFixtures.zoneRoutesForeign.result[0],
    pattern: 'shop.example.test/*',
  };
  h.routes = [foreign];
  const result = await deploy(o);
  expect(result.output.error).toBeNull();
  expect(result.exitCode).toBe(0);
  expect(h.routes).toEqual([
    foreign,
    { id: '8'.repeat(32), pattern: 'broker.example.test/*', script },
  ]);
  expect(routeMutations(h).map(({ method }) => method)).toEqual(['POST']);
});

it('redeploys the same routes without route mutations', async () => {
  const { h, o } = routedFirstInstall();
  expect((await deploy(o)).exitCode).toBe(0);
  const route = { id: '8'.repeat(32), pattern: 'broker.example.test/*', script };
  expect(h.routes).toEqual([route]);
  const j = (await store.read())!;
  j.deployment!.attempt.phase = 'verified';
  j.deployment!.attempt.smoke = 'passed';
  await store.write(j);
  const before = routeMutations(h).length;
  const result = await deploy(o);
  expect(result.output.error).toBeNull();
  expect(result.exitCode).toBe(0);
  expect(routeMutations(h).slice(before)).toEqual([]);
  expect(h.routes).toEqual([route]);
  expect((await store.read())!.deployment!.attempt.intended_settings.routes).toEqual([
    { ...route, zone_id: ZONE },
  ]);
});

it.each(['*.example.test/*', 'broker.example.test/api/*'])(
  'refuses a foreign overlap %s with exact safe checks',
  async (pattern) => {
    const { h, o } = routedFirstInstall();
    const id = '7'.repeat(32);
    h.routes = [{ id, pattern, script: 'other-worker' }];
    const result = await deploy(o);
    expect(result.exitCode).toBe(8);
    expect(result.output.error?.code).toBe('configuration_conflict');
    expect(routeChecks(result.output)).toEqual(
      conflictChecks('routes', 'routes:overlap', `routes:route_id:${id}`),
    );
    expect(mutations(h)).toEqual([]);
  },
);

it('fails closed on route pagination metadata', async () => {
  const { h, o } = routedFirstInstall();
  const send = o.fetch!;
  o.fetch = async (input, init) =>
    pathOf(input) === `/zones/${ZONE}/workers/routes` && (init?.method ?? 'GET') === 'GET'
      ? ok([], { total_pages: 2 })
      : send(input, init);
  const result = await deploy(o);
  expect(result.output.error?.code).toBe('capability_unknown');
  expect(result.exitCode).toBe(1);
  expect(mutations(h)).toEqual([]);
});

it.each([
  ['foreign_owner', '7'.repeat(32), 'broker.example.test/*', 'other-worker'],
  ['overlap', 'PRIVATE_ROUTE_ID!', '*.example.test/private-pattern/*', 'other-worker'],
  ['own_invalid', 'invalid route id', 'broker.example.test/*', script],
  ['unmanaged_own', '7'.repeat(32), 'broker.example.test/unmanaged/*', script],
])('pins route conflict fields for %s', async (reason, id, pattern, owner) => {
  const { h, o } = routedFirstInstall();
  h.routes = [{ id, pattern, script: owner }];
  const result = await deploy(o);
  expect(result.exitCode).toBe(8);
  expect(result.output.error?.code).toBe('configuration_conflict');
  expect(routeChecks(result.output)).toEqual(
    conflictChecks(
      'routes',
      `routes:${reason}`,
      ...(reason === 'foreign_owner' ? [`routes:route_id:${id}`] : []),
    ),
  );
  expect(mutations(h)).toEqual([]);
  if (reason === 'overlap') {
    expect(JSON.stringify(result.output)).not.toContain(id);
    expect(JSON.stringify(result.output)).not.toContain(pattern);
    expect(JSON.stringify(result.output)).not.toContain('*.example.test');
    expect(JSON.stringify(result.output)).not.toContain('private-pattern');
  }
});

it('pins route drift during reconciliation after failed configuration', async () => {
  const h = harness();
  const o = options(h, routeFlags);
  delete o.domain;
  h.configFail = true;
  expect((await deploy(o)).exitCode).not.toBe(0);
  h.configFail = false;
  const send = h.fetch;
  let reads = 0;
  o.fetch = async (input, init) => {
    if (pathOf(input) === `/zones/${ZONE}/workers/routes` && ++reads === 2)
      h.routes = [{ id: '7'.repeat(32), pattern: 'broker.example.test/drift/*', script }];
    return send(input, init);
  };
  const count = routeMutations(h).length;
  const result = await deploy(o);
  expect(result.exitCode).toBe(8);
  expect(result.output.error?.code).toBe('configuration_conflict');
  expect(routeChecks(result.output)).toEqual(conflictChecks('routes', 'routes:drift'));
  expect(routeMutations(h)).toHaveLength(count);
});

const compiledIdentity = { id: 'corp', kind: 'oidc', anchor: 'oidc:https://idp.example.com' };
const accessIdentity = {
  id: 'access',
  kind: 'cloudflare-access',
  anchor: `access:team.example.com/${'a'.repeat(64)}`,
};
async function writeIdentity(identity: unknown) {
  const file = join(out, 'generated/manifest.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.identity = identity;
  await writeFile(file, JSON.stringify(manifest));
}
it.each([true, false])(
  'reads a valid identity descriptor (runtimeProviders: %s)',
  async (runtimeProviders) => {
    const identity = { runtimeProviders, compiled: [compiledIdentity, accessIdentity] };
    await writeIdentity(identity);
    const parsed = (await validateDeploymentArtifact(out)).identity;
    expect(parsed).toEqual(identity);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed?.compiled)).toBe(true);
    expect(parsed?.compiled.every(Object.isFrozen)).toBe(true);
  },
);
it('reads an absent identity descriptor as legacy null', async () => {
  expect((await validateDeploymentArtifact(out)).identity).toBeNull();
});
it('accepts the identity descriptor at the 64-provider boundary', async () => {
  const identity = {
    runtimeProviders: true,
    compiled: Array.from({ length: 64 }, (_, i) => ({
      id: `p${i}`,
      kind: 'oidc',
      anchor: `oidc:https://idp${i}.example.com`,
    })),
  };
  await writeIdentity(identity);
  expect((await validateDeploymentArtifact(out)).identity).toEqual(identity);
});
it.each([
  ['null', null],
  ['array', []],
  ['string', 'identity'],
  ['extra key', { runtimeProviders: true, compiled: [], extra: true }],
  ['missing flag', { compiled: [] }],
  ['wrong flag type', { runtimeProviders: 'true', compiled: [] }],
  ['missing compiled', { runtimeProviders: true }],
  ['wrong compiled type', { runtimeProviders: true, compiled: {} }],
  [
    '65 entries',
    {
      runtimeProviders: true,
      compiled: Array.from({ length: 65 }, (_, i) => ({
        id: `p${i}`,
        kind: 'oidc',
        anchor: `oidc:https://idp${i}.example.com`,
      })),
    },
  ],
  ...[
    ['null entry', null],
    ['array entry', []],
    ['entry extra key', { ...compiledIdentity, extra: true }],
    ['missing id', { kind: 'oidc', anchor: compiledIdentity.anchor }],
    ['wrong id type', { ...compiledIdentity, id: 1 }],
    ['invalid id', { ...compiledIdentity, id: 'BAD_ID' }],
    ['reserved id', { ...compiledIdentity, id: 'local' }],
    ['bad kind', { ...compiledIdentity, kind: 'saml' }],
    ['wrong kind type', { ...compiledIdentity, kind: null }],
    ['wrong anchor type', { ...compiledIdentity, anchor: 1 }],
    ['bad anchor', { ...compiledIdentity, anchor: 'oidc:https://user:pass@idp.example.com' }],
    ['mismatched oidc anchor', { ...compiledIdentity, anchor: accessIdentity.anchor }],
    ['mismatched access anchor', { ...accessIdentity, anchor: compiledIdentity.anchor }],
  ].map(([name, entry]): [unknown, unknown] => [
    name,
    { runtimeProviders: true, compiled: [entry] },
  ]),
  [
    'duplicate id',
    {
      runtimeProviders: true,
      compiled: [
        compiledIdentity,
        {
          ...compiledIdentity,
          anchor: 'oidc:https://other.example.com',
        },
      ],
    },
  ],
  [
    'duplicate canonical anchor',
    {
      runtimeProviders: true,
      compiled: [
        compiledIdentity,
        {
          ...compiledIdentity,
          id: 'other',
          anchor: 'oidc:https://IDP.example.com:443/',
        },
      ],
    },
  ],
])('rejects malformed identity metadata: %s', async (_name, identity) => {
  await writeIdentity(identity);
  await expect(validateDeploymentArtifact(out)).rejects.toMatchObject({ code: 'invalid_input' });
});

const providersSentinel = 'PROVIDERS_DISPLAY_SENTINEL';
const providersValue = JSON.stringify([
  {
    id: 'test',
    kind: 'oidc',
    displayName: providersSentinel,
    issuer: 'https://idp.example.test',
    clientId: 'broker',
    policy: { verifiedDomains: ['example.test'], autoJoin: false },
  },
]);
function liveProviders(h: ReturnType<typeof harness>, text: unknown, type = 'plain_text') {
  h.versions.get(OLD)!.resources = {
    bindings: [
      { type: 'd1', name: 'DB', id: DB },
      { type, name: 'PB_IDP_PROVIDERS', text },
    ],
  };
}
const providerUploads = (h: ReturnType<typeof harness>) =>
  h.calls.filter((c) => c.path === base + '/versions' && c.method === 'POST');
const uploadedProviders = (h: ReturnType<typeof harness>) =>
  (h.metadata!.bindings as Record<string, unknown>[]).filter((b) => b.name === 'PB_IDP_PROVIDERS');

function providerHarness() {
  const h = harness();
  h.installed.push('PB_IDP_TEST_CLIENT_SECRET');
  return h;
}

it('sets compact providers, journals only their hash, and changes versions only when needed', async () => {
  await writeIdentity({ runtimeProviders: true, compiled: [] });
  const h = providerHarness();
  const o = options(h, { providers: { kind: 'set', value: providersValue, ids: ['test'] } });
  const success = await deploy(o);
  expect(success.exitCode).toBe(0);
  expect(JSON.stringify(success.output)).not.toContain(providersSentinel);
  expect(uploadedProviders(h)).toEqual([
    { type: 'plain_text', name: 'PB_IDP_PROVIDERS', text: providersValue },
  ]);
  expect((await store.read())!.deployment!.history!.hashed_bindings).toEqual([
    { name: 'PB_IDP_PROVIDERS', sha256: [digest(providersValue)] },
  ]);
  expect((await store.read())!.deployment!.attempt.providers_text).toBe(providersValue);
  expect(JSON.stringify((await store.read())!.deployment!.history)).not.toContain(
    providersSentinel,
  );
  expect((await store.read())!.deployment!.history!.plain_bindings).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'PB_IDP_PROVIDERS' })]),
  );
  const verified = (await store.read())!;
  verified.deployment!.attempt.phase = 'verified';
  verified.deployment!.attempt.smoke = 'passed';
  await store.write(verified);
  expect((await deploy(o)).exitCode).toBe(0);
  expect(providerUploads(h)).toHaveLength(1);
  o.providers = { kind: 'set', value: '[]', ids: [] };
  expect((await deploy(o)).exitCode).toBe(0);
  expect(providerUploads(h)).toHaveLength(2);
  expect(uploadedProviders(h)[0]!.text).toBe('[]');
});

it.each(['remove', 'absent'] as const)(
  'uploads no providers for %s with nothing live',
  async (kind) => {
    const h = harness();
    expect((await deploy(options(h, { providers: { kind } }))).exitCode).toBe(0);
    expect(uploadedProviders(h)).toEqual([]);
    expect((await store.read())!.deployment!.history!.hashed_bindings).toBeUndefined();
  },
);

it('removes live providers through the exact uploaded binding set', async () => {
  const h = harness();
  liveProviders(h, providersValue);
  expect((await deploy(options(h, { providers: { kind: 'remove' } }))).exitCode).toBe(0);
  expect(uploadedProviders(h)).toEqual([]);
  const candidate = h.versions.get(CANDIDATE)!.resources as { bindings: { name: string }[] };
  expect(candidate.bindings.some((b) => b.name === 'PB_IDP_PROVIDERS')).toBe(false);
  expect((await store.read())!.deployment!.history!.hashed_bindings).toBeUndefined();
});

it('preserves valid live providers byte for byte on a legacy artifact', async () => {
  const h = providerHarness();
  const value = ` \n${providersValue}\n `;
  liveProviders(h, value);
  expect((await deploy(options(h))).exitCode).toBe(0);
  expect(uploadedProviders(h)[0]!.text).toBe(value);
  expect((await store.read())!.deployment!.history!.hashed_bindings).toEqual([
    { name: 'PB_IDP_PROVIDERS', sha256: [digest(value)] },
  ]);
});

it.each<[string, unknown]>([
  ['secret_text', undefined],
  ['plain_text', 3],
  ['plain_text', '{' + providersSentinel],
  ['plain_text', JSON.stringify([{ displayName: providersSentinel }])],
  ['json', providersValue],
])('refuses invalid live providers (%s) without leaking values', async (type, value) => {
  const h = harness();
  liveProviders(h, value, type);
  const result = await deploy(options(h));
  expect(result.output.error).toMatchObject({
    code: 'invalid_input',
    message:
      type === 'secret_text'
        ? 'Remove the secret first: wrangler secret delete PB_IDP_PROVIDERS'
        : 'live PB_IDP_PROVIDERS is not valid; pass --providers <file> or --providers none',
  });
  expect(providerUploads(h)).toHaveLength(0);
  expect(JSON.stringify(result.output)).not.toContain(providersSentinel);
});

it.each(['legacy', 'disabled'])('refuses set providers for a %s artifact', async (mode) => {
  if (mode === 'disabled') await writeIdentity({ runtimeProviders: false, compiled: [] });
  const h = harness();
  const result = await deploy(
    options(h, {
      providers: { kind: 'set', value: providersValue, ids: ['test'] },
    }),
  );
  expect(result.output.error).toMatchObject({
    code: 'invalid_input',
    message: expect.stringContaining(mode === 'legacy' ? 'legacy' : 'runtimeProviders'),
  });
  expect(JSON.stringify(result)).not.toContain(providersSentinel);
  expect(providerUploads(h)).toHaveLength(0);
});

it('resumes a lost upload with frozen providers after live providers become invalid', async () => {
  const h = providerHarness();
  liveProviders(h, providersValue);
  h.uploadLost = true;
  const first = await deploy(options(h));
  expect(first.exitCode).not.toBe(0);
  expect(JSON.stringify(first)).not.toContain(providersSentinel);
  expect((await store.read())!.deployment!.attempt.phase).toBe('upload_pending');
  liveProviders(h, 'invalid changed live value');
  const second = await deploy(options(h));
  expect(second.exitCode).toBe(0);
  expect(JSON.stringify(second)).not.toContain(providersSentinel);
  expect(providerUploads(h)).toHaveLength(1);
  expect(uploadedProviders(h)[0]!.text).toBe(providersValue);
});

async function pendingProviders(h: ReturnType<typeof harness>, value = providersValue) {
  liveProviders(h, value);
  const send = h.fetch;
  h.fetch = vi.fn(async (input, init) =>
    String(input).endsWith('/assets-upload-session')
      ? new Response('', { status: 403 })
      : send(input, init),
  );
  expect((await deploy(options(h))).exitCode).not.toBe(0);
  h.fetch = send;
  const attempt = (await store.read())!.deployment!.attempt;
  expect(attempt.phase).toBe('preparing_upload');
  expect(attempt.providers_text).toBe(value);
  return attempt;
}

it.each(['changed', 'remove', 'same', 'absent'])(
  'checks explicit providers on resume before upload: %s',
  async (mode) => {
    await writeIdentity({ runtimeProviders: true, compiled: [] });
    const h = providerHarness();
    await pendingProviders(h);
    expect(providerUploads(h)).toHaveLength(0);
    liveProviders(h, 'changed invalid live value');
    const providers: DeployOptions['providers'] =
      mode === 'remove'
        ? { kind: 'remove' }
        : mode === 'absent'
          ? { kind: 'absent' }
          : { kind: 'set', value: mode === 'same' ? providersValue : '[]', ids: [] };
    const result = await deploy(options(h, { providers }));
    if (mode === 'changed' || mode === 'remove') {
      expect(result.output.error?.code).toBe('configuration_conflict');
      expect(result.output.checks).toContainEqual({
        name: 'settings_sha256',
        status: 'configuration_conflict',
      });
      expect(providerUploads(h)).toHaveLength(0);
    } else {
      expect(result.exitCode).toBe(0);
      expect(providerUploads(h)).toHaveLength(1);
      expect(uploadedProviders(h)[0]!.text).toBe(providersValue);
      expect(JSON.stringify(result.output)).not.toContain(providersSentinel);
    }
  },
);

it.each(['missing', 'mismatch'])(
  'refuses an unusable frozen provider attempt field: %s',
  async (mode) => {
    const h = providerHarness();
    await pendingProviders(h);
    const journal = (await store.read())!;
    if (mode === 'missing') delete journal.deployment!.attempt.providers_text;
    else journal.deployment!.attempt.providers_text = '[]';
    await store.write(journal);
    const result = await deploy(options(h));
    expect(result.output.error?.code).toBe('configuration_conflict');
    expect(result.output.checks).toContainEqual({
      name: 'providers',
      status: 'configuration_conflict',
    });
    expect(providerUploads(h)).toHaveLength(0);
  },
);

it.each(['verified', 'failed', 'rolled_back'] as const)(
  'removes frozen provider text atomically when inventory reaches %s',
  async (phase) => {
    const h = providerHarness();
    liveProviders(h, providersValue);
    expect((await deploy(options(h))).exitCode).toBe(0);
    const journal = (await store.read())!;
    const attempt = journal.deployment!.attempt;
    expect(attempt.providers_text).toBe(providersValue);
    attempt.phase = phase;
    if (phase === 'verified') attempt.smoke = 'passed';
    await store.write(journal);
    const stored = (await store.read())!.deployment!;
    expect(stored.attempt).not.toHaveProperty('providers_text');
    expect(stored.attempt.providers_sha256).toBe(digest(providersValue));
    expect(JSON.stringify(stored.history)).not.toContain(providersSentinel);
    expect(await readFile(store.path, 'utf8')).not.toContain(providersSentinel);
  },
);

it('rejects oversized UTF-8 provider text in inventory reads and writes', async () => {
  const h = providerHarness();
  await pendingProviders(h);
  const journal = (await store.read())!;
  journal.deployment!.attempt.providers_text = 'é'.repeat(2561);
  await expect(store.write(journal)).rejects.toMatchObject({ code: 'invalid_inventory' });
  await writeFile(store.path, JSON.stringify(journal));
  await expect(store.read()).rejects.toMatchObject({ code: 'invalid_inventory' });
});

it.each(['set', 'remove', 'absent'] as const)(
  'refuses an installed provider secret for %s',
  async (kind) => {
    await writeIdentity({ runtimeProviders: true, compiled: [] });
    const h = harness();
    h.installed.push('PB_IDP_PROVIDERS');
    const result = await deploy(
      options(h, {
        providers: kind === 'set' ? { kind, value: providersValue, ids: ['test'] } : { kind },
      }),
    );
    expect(result.output.error).toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining('wrangler secret delete PB_IDP_PROVIDERS'),
    });
    expect(providerUploads(h)).toHaveLength(0);
  },
);

it.each(['set', 'remove', 'absent'] as const)(
  'refuses selecting the provider secret for %s',
  async (kind) => {
    await writeIdentity({ runtimeProviders: true, compiled: [] });
    for (const selection of [{ secret: ['PB_IDP_PROVIDERS'] }, { secrets: 'PB_IDP_PROVIDERS' }]) {
      const h = harness();
      const result = await deploy(
        options(h, {
          ...selection,
          providers: kind === 'set' ? { kind, value: providersValue, ids: ['test'] } : { kind },
        }),
      );
      expect(result.output.error?.code).toBe('invalid_input');
      expect(mutations(h)).toHaveLength(0);
    }
  },
);

it('preserves active providers when script settings show a different version', async () => {
  const h = providerHarness();
  liveProviders(h, providersValue);
  h.settingsVersion = NEWEST;
  h.versions.get(NEWEST)!.resources = {
    bindings: [
      { type: 'd1', name: 'DB', id: DB },
      { type: 'plain_text', name: 'PB_IDP_PROVIDERS', text: '[]' },
    ],
  };
  expect((await deploy(options(h))).exitCode).toBe(0);
  expect(uploadedProviders(h)[0]!.text).toBe(providersValue);
});

it.each(['equal', 'different', 'absent'])(
  'handles providers in a managed split deployment: %s',
  async (mode) => {
    const full = providerHarness();
    liveProviders(full, providersValue);
    const verified = await verifiedIdentityDeploy(full);
    verified.deployment!.attempt.version_id = OLD;
    verified.deployment!.attempt.previous_version_id = null;
    verified.deployment!.attempt.previous_deployment_id = null;
    verified.deployment!.attempt.previous_distribution = [];
    await store.write(verified);
    const h = providerHarness();
    h.versions.set(OLD, { ...full.versions.get(CANDIDATE)!, id: OLD });
    h.endpoints = full.endpoints;
    h.schedules = full.schedules;
    h.consumer = full.consumer;
    h.domain = full.domain;
    expect((await deploy(options(h, { rollout: 25 }))).exitCode).toBe(0);
    const journal = (await store.read())!;
    journal.deployment!.attempt.phase = 'verified';
    journal.deployment!.attempt.smoke = 'passed';
    await store.write(journal);
    h.settingsVersion = CANDIDATE;
    if (mode === 'different') liveProviders(h, '[]');
    if (mode === 'absent') h.versions.get(OLD)!.resources = { bindings: [] };
    const result = await deploy(options(h, { rollout: 25 }));
    if (mode === 'equal') {
      expect(result.exitCode).toBe(0);
      expect(result.output.plan).toContainEqual({ stage: 'deploy', action: 'unchanged' });
    } else expect(result.output.error?.code).toBe('configuration_conflict');
    expect(providerUploads(h)).toHaveLength(1);
  },
);

it.each(['absent', 'remove'] as const)(
  'allows %s on a runtimeProviders false artifact',
  async (kind) => {
    await writeIdentity({ runtimeProviders: false, compiled: [] });
    const h = providerHarness();
    liveProviders(h, providersValue);
    expect((await deploy(options(h, { providers: { kind } }))).exitCode).toBe(0);
    expect(uploadedProviders(h)).toHaveLength(kind === 'absent' ? 1 : 0);
  },
);

it.each(['duplicate', 'duplicate-member', 'invalid-dry-run'])(
  'refuses invalid preserved providers: %s',
  async (mode) => {
    const h = harness();
    liveProviders(
      h,
      mode === 'duplicate-member'
        ? '[{"id":"a","id":"b"}]'
        : mode === 'invalid-dry-run'
          ? '{'
          : providersValue,
    );
    if (mode === 'duplicate') {
      const resources = h.versions.get(OLD)!.resources as { bindings: unknown[] };
      resources.bindings.push({
        type: 'plain_text',
        name: 'PB_IDP_PROVIDERS',
        text: providersValue,
      });
    }
    const result = await deploy(options(h, { dryRun: mode === 'invalid-dry-run' }));
    expect(result.output.error?.code).toBe('invalid_input');
    expect(providerUploads(h)).toHaveLength(0);
  },
);

it('absent preserves providers on a verified receipt without another upload', async () => {
  const h = providerHarness();
  liveProviders(h, providersValue);
  expect((await deploy(options(h))).exitCode).toBe(0);
  const journal = (await store.read())!;
  journal.deployment!.attempt.phase = 'verified';
  journal.deployment!.attempt.smoke = 'passed';
  await store.write(journal);
  const result = await deploy(options(h, { providers: { kind: 'absent' } }));
  expect(result.exitCode).toBe(0);
  expect(result.output.plan).toContainEqual({ stage: 'deploy', action: 'unchanged' });
  expect(JSON.stringify(result.output)).not.toContain(providersSentinel);
  expect(providerUploads(h)).toHaveLength(1);
});

it.each(['deployment', 'managed_settings'])(
  'reports %s conflict before invalid live providers',
  async (field) => {
    const h = harness();
    liveProviders(h, '{');
    if (field === 'deployment')
      h.active.versions = [
        { version_id: OLD, percentage: 50 },
        { version_id: NEWEST, percentage: 50 },
      ];
    else h.schedules = ['* * * * *'];
    const result = await deploy(options(h));
    expect(result.output.error?.code).toBe('configuration_conflict');
    expect(result.output.checks).toContainEqual({ name: field, status: 'configuration_conflict' });
    expect(providerUploads(h)).toHaveLength(0);
  },
);

it('refuses preserved provider documents padded beyond the runtime byte bound', async () => {
  const h = harness();
  liveProviders(h, `${providersValue}${' '.repeat(5121)}`);
  const result = await deploy(options(h));
  expect(result.output.error?.code).toBe('invalid_input');
  expect(providerUploads(h)).toHaveLength(0);
});

it('resumes with an explicit compact set equal to the frozen non-compact value', async () => {
  await writeIdentity({ runtimeProviders: true, compiled: [] });
  const h = providerHarness();
  const value = JSON.stringify(JSON.parse(providersValue), null, 2);
  await pendingProviders(h, value);
  liveProviders(h, 'changed live value');
  const result = await deploy(
    options(h, { providers: { kind: 'set', value: providersValue, ids: ['test'] } }),
  );
  expect(result.exitCode).toBe(0);
  expect(uploadedProviders(h)[0]!.text).toBe(value);
  expect(JSON.stringify(result.output)).not.toContain(providersSentinel);
});

it.each(['set', 'remove', 'absent'] as const)(
  'refuses an active-version provider secret for %s',
  async (kind) => {
    await writeIdentity({ runtimeProviders: true, compiled: [] });
    const h = harness();
    liveProviders(h, undefined, 'secret_text');
    h.settingsVersion = NEWEST;
    const result = await deploy(
      options(h, {
        providers: kind === 'set' ? { kind, value: providersValue, ids: ['test'] } : { kind },
      }),
    );
    expect(result.output.error).toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining('wrangler secret delete PB_IDP_PROVIDERS'),
    });
    expect(providerUploads(h)).toHaveLength(0);
  },
);

it.each([undefined, {}, { bindings: null }, { bindings: {} }])(
  'reports providers conflict for non-array version bindings: %j',
  async (resources) => {
    const h = harness();
    h.settingsVersion = NEWEST;
    h.versions.get(OLD)!.resources = resources;
    const result = await deploy(options(h));
    expect(result.output.error?.code).toBe('configuration_conflict');
    expect(result.output.checks).toContainEqual({
      name: 'providers',
      status: 'configuration_conflict',
    });
  },
);

it('fetches the single active version only once while preserving providers', async () => {
  const h = providerHarness();
  liveProviders(h, providersValue);
  expect((await deploy(options(h))).exitCode).toBe(0);
  expect(
    h.calls.filter((c) => c.path === `${base}/versions/${OLD}` && c.method === 'GET'),
  ).toHaveLength(1);
});

it.each(['artifact', 'rollout'])(
  'checks resumed %s before active provider bindings',
  async (field) => {
    const h = providerHarness();
    await pendingProviders(h);
    h.settingsVersion = NEWEST;
    h.versions.get(OLD)!.resources = { bindings: {} };
    if (field === 'artifact') await writeFile(join(out, 'worker.js'), 'export default {};');
    const result = await deploy(options(h, field === 'rollout' ? { rollout: 25 } : {}));
    expect(result.output.error?.code).toBe('configuration_conflict');
    expect(result.output.checks).toContainEqual({
      name: field === 'artifact' ? 'artifact_sha256' : 'requested_rollout',
      status: 'configuration_conflict',
    });
  },
);

it('keeps no-op ordering before managed reconciliation without providers involvement', async () => {
  const h = harness();
  expect((await deploy(options(h))).exitCode).toBe(0);
  const journal = (await store.read())!;
  journal.deployment!.attempt.phase = 'verified';
  journal.deployment!.attempt.smoke = 'passed';
  journal.deployment!.attempt.intended_settings.schedules = [];
  await store.write(journal);
  const result = await deploy(options(h));
  expect(result.exitCode).toBe(0);
  expect(result.output.plan).toContainEqual({ stage: 'deploy', action: 'unchanged' });
  expect(providerUploads(h)).toHaveLength(1);
});

it('replaces in-flight provider text without copying it into history', async () => {
  await writeIdentity({ runtimeProviders: true, compiled: [] });
  const h = providerHarness();
  expect(
    (await deploy(options(h, { providers: { kind: 'set', value: providersValue, ids: ['test'] } })))
      .exitCode,
  ).toBe(0);
  expect(
    (await deploy(options(h, { providers: { kind: 'set', value: '[]', ids: [] } }))).exitCode,
  ).toBe(0);
  const journal = (await store.read())!.deployment!;
  expect(journal.attempt.providers_text).toBe('[]');
  expect(journal.history!.hashed_bindings).toContainEqual({
    name: 'PB_IDP_PROVIDERS',
    sha256: [digest(providersValue), digest('[]')],
  });
  expect(await readFile(store.path, 'utf8')).not.toContain(providersSentinel);
});

const corpProviders = JSON.stringify([{ ...JSON.parse(providersValue)[0], id: 'corp' }]);
it.each(['installed', 'secret', 'secrets'] as const)(
  'accepts an OIDC client secret %s with the deploy',
  async (delivery) => {
    await writeIdentity({ runtimeProviders: true, compiled: [] });
    const h = harness();
    const name = 'PB_IDP_CORP_CLIENT_SECRET';
    if (delivery === 'installed') h.installed.push(name);
    const o = options(h, {
      providers: { kind: 'set', value: corpProviders, ids: ['corp'] },
      ...(delivery === 'secret' ? { secret: [name] } : {}),
      ...(delivery === 'secrets' ? { secrets: name } : {}),
    });
    o.env = { ...o.env, [name]: 'CORP_SECRET_SENTINEL' };
    const result = await deploy(o);
    expect(result.exitCode).toBe(0);
    expect(result.output.checks).toContainEqual({ name: 'provider_secrets', status: 'verified' });
    expect(providerUploads(h)).toHaveLength(1);
    expect(JSON.stringify(result.output)).not.toContain('CORP_SECRET_SENTINEL');
  },
);
it.each([
  ['set', false, 'unselected'],
  ['preserved', false, 'unselected'],
  ['set', true, 'empty'],
  ['preserved', true, 'empty'],
] as const)(
  'refuses missing OIDC secrets for %s (dry-run %s, %s env)',
  async (mode, dryRun, env) => {
    await writeIdentity({ runtimeProviders: true, compiled: [] });
    const h = harness();
    if (mode === 'preserved') liveProviders(h, corpProviders);
    const o = options(h, {
      dryRun,
      ...(mode === 'set'
        ? { providers: { kind: 'set', value: corpProviders, ids: ['corp'] } }
        : {}),
      ...(env === 'empty' ? { secret: ['PB_IDP_CORP_CLIENT_SECRET'] } : {}),
    });
    o.env = { ...o.env, PB_IDP_CORP_CLIENT_SECRET: env === 'empty' ? '' : 'UNSELECTED_SECRET' };
    const result = await deploy(o);
    expect(result.exitCode).toBe(2);
    expect(result.output.error).toMatchObject({ code: 'invalid_input' });
    expect(result.output.error!.message).toContain('PB_IDP_CORP_CLIENT_SECRET');
    expect(result.output.error!.message).toContain('--secret');
    expect(JSON.stringify(result.output)).not.toContain(providersSentinel);
    expect(JSON.stringify(result.output)).not.toContain('idp.example.test');
    expect(JSON.stringify(result.output)).not.toContain('UNSELECTED_SECRET');
    expect(mutations(h)).toEqual([]);
  },
);
it('reports every missing OIDC secret name without provider values', async () => {
  await writeIdentity({ runtimeProviders: true, compiled: [] });
  const h = harness();
  const result = await deploy(
    options(h, {
      providers: {
        kind: 'set',
        value: JSON.stringify([
          ...JSON.parse(corpProviders),
          { ...JSON.parse(providersValue)[0], issuer: 'https://other.example.test' },
        ]),
        ids: ['corp', 'test'],
      },
    }),
  );
  expect(result.output.error).toMatchObject({ code: 'invalid_input' });
  expect(result.output.error!.message).toContain(
    'PB_IDP_CORP_CLIENT_SECRET, PB_IDP_TEST_CLIENT_SECRET',
  );
  expect(JSON.stringify(result.output)).not.toContain(providersSentinel);
  expect(mutations(h)).toEqual([]);
});
it.each([false, true])('accepts Access without a client secret (dry-run %s)', async (dryRun) => {
  await writeIdentity({ runtimeProviders: true, compiled: [] });
  const h = harness();
  const value = JSON.stringify([
    {
      id: 'corp',
      kind: 'cloudflare-access',
      teamDomain: 'corp.cloudflareaccess.com',
      audience: 'a'.repeat(64),
      trustEmailVerification: true,
      policy: { verifiedDomains: ['example.test'], autoJoin: false },
    },
  ]);
  const result = await deploy(
    options(h, { dryRun, providers: { kind: 'set', value, ids: ['corp'] } }),
  );
  expect(result.exitCode).toBe(0);
  expect(result.output.checks).toContainEqual({ name: 'provider_secrets', status: 'verified' });
  expect(providerUploads(h)).toHaveLength(dryRun ? 0 : 1);
});
it('checks and reports installed secrets for preserved OIDC during dry-run', async () => {
  const h = harness();
  liveProviders(h, corpProviders);
  h.installed.push('PB_IDP_CORP_CLIENT_SECRET');
  const result = await deploy(options(h, { dryRun: true }));
  expect(result.exitCode).toBe(0);
  expect(result.output.checks).toContainEqual({ name: 'provider_secrets', status: 'verified' });
  expect(mutations(h)).toEqual([]);
});
it.each([
  [64, false, 0],
  [65, false, 2],
  [65, true, 0],
  [128, true, 0],
  [129, true, 2],
] as const)(
  'checks %i variable names with workersPaid=%s',
  async (count, workersPaid, exitCode) => {
    const h = harness();
    h.installed.push(...Array.from({ length: count - 5 }, (_, i) => `ORPHAN_${i}`));
    const result = await deploy(options(h, { workersPaid }));
    expect(result.exitCode).toBe(exitCode);
    if (exitCode) {
      expect(result.output.error).toMatchObject({ code: 'invalid_input' });
      expect(result.output.error!.message).toContain(`${count}`);
      expect(result.output.error!.message).toContain(`${workersPaid ? 128 : 64}`);
      expect(mutations(h)).toEqual([]);
    } else {
      expect(result.output.checks).toContainEqual({
        name: 'variable_budget',
        status: 'verified',
      });
      expect(providerUploads(h)).toHaveLength(1);
      expect(h.metadata!.bindings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'd1' }),
          expect.objectContaining({ type: 'r2_bucket' }),
          expect.objectContaining({ type: 'queue' }),
          expect.objectContaining({ type: 'analytics_engine' }),
        ]),
      );
      expect(h.metadata).toHaveProperty('assets');
    }
  },
);
it.each([64, 65])(
  'counts providers, telemetry and delivered secret union at %i during dry-run',
  async (count) => {
    await writeIdentity({ runtimeProviders: true, compiled: [] });
    const file = join(out, 'generated/manifest.json');
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    manifest.platformPorts.observability.endpointEnv = 'OTEL_ENDPOINT';
    await writeFile(file, JSON.stringify(manifest));
    const h = harness();
    h.installed.push(
      'PB_IDP_CORP_CLIENT_SECRET',
      ...Array.from({ length: count - 9 }, (_, i) => `ORPHAN_${i}`),
    );
    const o = options(h, {
      dryRun: true,
      providers: { kind: 'set', value: corpProviders, ids: ['corp'] },
      secret: ['PB_IDP_CORP_CLIENT_SECRET', 'NEW_SECRET'],
    });
    o.env = {
      ...o.env,
      PB_IDP_CORP_CLIENT_SECRET: 'ROTATED_SENTINEL',
      NEW_SECRET: 'NEW_SENTINEL',
      OTEL_ENDPOINT: 'https://telemetry.example.test',
    };
    const result = await deploy(o);
    expect(result.exitCode).toBe(count === 64 ? 0 : 2);
    if (count === 64)
      expect(result.output.checks).toContainEqual({
        name: 'variable_budget',
        status: 'verified',
      });
    else
      expect(result.output.error).toMatchObject({
        code: 'invalid_input',
        message: 'Worker environment variable count 65 exceeds limit 64',
      });
    expect(mutations(h)).toEqual([]);
  },
);
it('counts orphaned installed provider secrets after providers are removed', async () => {
  const h = harness();
  liveProviders(h, corpProviders);
  h.installed.push(
    'PB_IDP_CORP_CLIENT_SECRET',
    ...Array.from({ length: 59 }, (_, i) => `ORPHAN_${i}`),
  );
  const result = await deploy(options(h, { providers: { kind: 'remove' } }));
  expect(result.exitCode).toBe(2);
  expect(result.output.error).toMatchObject({
    code: 'invalid_input',
    message: 'Worker environment variable count 65 exceeds limit 64',
  });
  expect(mutations(h)).toEqual([]);
});

it('includes pending secret names in the variable budget before reconciling a lost upload', async () => {
  const h = harness();
  h.uploadLost = true;
  const o = options(h, { secret: ['PENDING_SECRET'] });
  o.env = { ...o.env, PENDING_SECRET: 'PENDING_SENTINEL' };
  expect((await deploy(o)).exitCode).toBe(6);
  const uploads = providerUploads(h).length;
  h.installed.push(...Array.from({ length: 59 }, (_, i) => `ORPHAN_${i}`));
  const result = await deploy(options(h, { dryRun: true }));
  expect(result.exitCode).toBe(2);
  expect(result.output.error).toMatchObject({
    code: 'invalid_input',
    message: 'Worker environment variable count 65 exceeds limit 64',
  });
  expect(providerUploads(h)).toHaveLength(uploads);
  expect(JSON.stringify(result.output)).not.toContain('PENDING_SENTINEL');
});

it.each(['invalid-live', 'disabled-artifact', 'resume-conflict'] as const)(
  'keeps l1 sentinel redaction and no-upload guards effective with complete OIDC fixtures: %s',
  async (mode) => {
    const h = providerHarness();
    let o = options(h);
    if (mode === 'invalid-live') liveProviders(h, '{' + providersSentinel);
    else if (mode === 'disabled-artifact') {
      await writeIdentity({ runtimeProviders: false, compiled: [] });
      o = options(h, { providers: { kind: 'set', value: providersValue, ids: ['test'] } });
    } else {
      await writeIdentity({ runtimeProviders: true, compiled: [] });
      await pendingProviders(h);
      o = options(h, { providers: { kind: 'set', value: '[]', ids: [] } });
    }
    const result = await deploy(o);
    expect(h.installed).toContain('PB_IDP_TEST_CLIENT_SECRET');
    if (mode === 'invalid-live')
      expect(result.output.error).toMatchObject({
        code: 'invalid_input',
        message: 'live PB_IDP_PROVIDERS is not valid; pass --providers <file> or --providers none',
      });
    else if (mode === 'disabled-artifact')
      expect(result.output.error).toMatchObject({
        code: 'invalid_input',
        message: 'Cannot set providers: artifact runtimeProviders is false',
      });
    else {
      expect(result.output.error).toMatchObject({ code: 'configuration_conflict' });
      expect(result.output.checks).toContainEqual({
        name: 'settings_sha256',
        status: 'configuration_conflict',
      });
    }
    expect(JSON.stringify(result.output)).not.toContain(providersSentinel);
    expect(providerUploads(h)).toHaveLength(0);
  },
);

it('resumes a lost provider upload using the pending client secret without selecting it again', async () => {
  await writeIdentity({ runtimeProviders: true, compiled: [] });
  const file = join(project, 'corp.json');
  await writeFile(file, corpProviders);
  const h = harness();
  h.uploadLost = true;
  const firstOptions = options(h, {
    providers: await readProvidersOption(file),
    secret: ['PB_IDP_CORP_CLIENT_SECRET'],
  });
  firstOptions.env = { ...firstOptions.env, PB_IDP_CORP_CLIENT_SECRET: 'CORP_PENDING_SENTINEL' };
  const first = await deploy(firstOptions);
  expect(first.exitCode).toBe(6);
  expect((await store.read())!.deployment!.attempt).toMatchObject({
    phase: 'upload_pending',
    secret_names: expect.arrayContaining(['PB_IDP_CORP_CLIENT_SECRET']),
  });
  expect(h.installed).not.toContain('PB_IDP_CORP_CLIENT_SECRET');
  const resumed = await deploy(options(h));
  expect(resumed.exitCode).toBe(0);
  expect(resumed.output.checks).toContainEqual({ name: 'provider_secrets', status: 'verified' });
  expect(providerUploads(h)).toHaveLength(1);
  expect(uploadedProviders(h)[0]!.text).toBe(corpProviders);
  expect(JSON.stringify(resumed.output)).not.toContain('CORP_PENDING_SENTINEL');
  expect(JSON.stringify(resumed.output)).not.toContain(providersSentinel);
});

it.each([
  ['syntax', '{' + providersSentinel],
  ['not-array', JSON.stringify({ displayName: providersSentinel })],
  ['over-cap', JSON.stringify(Array.from({ length: 65 }, () => ({})))],
  [
    'rejected-entry',
    JSON.stringify([
      ...JSON.parse(providersValue),
      { ...JSON.parse(corpProviders)[0], issuer: providersSentinel },
    ]),
  ],
])('refuses invalid frozen providers before upload: %s', async (_mode, text) => {
  const h = providerHarness();
  await pendingProviders(h);
  const journal = (await store.read())!;
  journal.deployment!.attempt.providers_text = text;
  journal.deployment!.attempt.providers_sha256 = digest(text);
  await store.write(journal);
  const before = mutations(h).length;
  const result = await deploy(options(h));
  expect(result.exitCode).toBe(2);
  expect(result.output.error).toMatchObject({
    code: 'invalid_input',
    message: 'Frozen PB_IDP_PROVIDERS is not valid',
  });
  expect(JSON.stringify(result.output)).not.toContain(providersSentinel);
  expect(providerUploads(h)).toHaveLength(0);
  expect(mutations(h)).toHaveLength(before);
});

async function verifiedIdentityDeploy(h: ReturnType<typeof harness>) {
  expect((await deploy(options(h))).exitCode).toBe(0);
  const journal = (await store.read())!;
  journal.deployment!.attempt.phase = 'verified';
  journal.deployment!.attempt.smoke = 'passed';
  await store.write(journal);
  return journal;
}

it.each(['unchanged', 'providers', 'compiled', 'flag', 'removed'] as const)(
  'checks partial rollout identity configuration: %s',
  async (change) => {
    const descriptor = { runtimeProviders: true, compiled: [] as (typeof compiledIdentity)[] };
    await writeIdentity(descriptor);
    const h = providerHarness();
    liveProviders(h, providersValue);
    const journal = await verifiedIdentityDeploy(h);
    const expected = digest(
      JSON.stringify({
        descriptor: { compiled: [], runtimeProviders: true },
        providers: providersValue,
      }),
    );
    expect(journal.deployment!.attempt.identity_sha256).toBe(expected);
    if (change === 'compiled') await writeIdentity({ ...descriptor, compiled: [compiledIdentity] });
    if (change === 'flag') await writeIdentity({ ...descriptor, runtimeProviders: false });
    if (change === 'removed') {
      const file = join(out, 'generated/manifest.json');
      const manifest = JSON.parse(await readFile(file, 'utf8'));
      delete manifest.identity;
      await writeFile(file, JSON.stringify(manifest));
    }
    const before = await readFile(store.path, 'utf8');
    const uploads = providerUploads(h).length;
    const result = await deploy(
      options(h, {
        rollout: 25,
        ...(change === 'providers' ? { providers: { kind: 'set', value: '[]', ids: [] } } : {}),
      }),
    );
    if (change === 'unchanged') {
      expect(result.exitCode).toBe(0);
      expect(providerUploads(h)).toHaveLength(uploads + 1);
      const deployment = (await store.read())!.deployment!;
      expect(deployment.attempt.identity_sha256).toBe(expected);
      expect(deployment.last_verified!.identity_sha256).toBe(expected);
      expect(JSON.stringify(deployment.history)).not.toContain(expected);
      expect(JSON.stringify(deployment.history)).not.toContain('identity_sha256');
    } else {
      expect(result.output.error).toMatchObject({
        code: 'invalid_input',
        message:
          'partial rollout is not allowed when SSO provider configuration changes; deploy with --rollout 100 first',
      });
      expect(providerUploads(h)).toHaveLength(uploads);
      expect(await readFile(store.path, 'utf8')).toBe(before);
    }
  },
);

it.each(['null', 'descriptor', 'providers'] as const)(
  'loads a legacy receipt and checks a partial rollout with new %s identity',
  async (mode) => {
    const h = providerHarness();
    const journal = await verifiedIdentityDeploy(h);
    delete journal.deployment!.attempt.identity_sha256;
    await store.write(journal);
    expect((await store.read())!.deployment!.attempt).not.toHaveProperty('identity_sha256');
    if (mode === 'descriptor') await writeIdentity({ runtimeProviders: true, compiled: [] });
    if (mode === 'providers') {
      liveProviders(h, providersValue);
      h.versions.get(CANDIDATE)!.resources = h.versions.get(OLD)!.resources;
    }
    // Exercise the saved receipt path as well as the verified current attempt path.
    journal.deployment!.last_verified = structuredClone(journal.deployment!.attempt);
    journal.deployment!.attempt.phase = 'active';
    await store.write(journal);
    const before = await readFile(store.path, 'utf8');
    const result = await deploy(options(h, { rollout: 25 }));
    expect(result.exitCode).toBe(mode === 'null' ? 0 : 2);
    expect(providerUploads(h)).toHaveLength(mode === 'null' ? 2 : 1);
    if (mode === 'null')
      expect((await store.read())!.deployment!.attempt.identity_sha256).toBeNull();
    else {
      expect(result.output.error?.code).toBe('invalid_input');
      expect(await readFile(store.path, 'utf8')).toBe(before);
    }
  },
);

it('allows full rollout identity changes and retains the previous verified identity hash', async () => {
  await writeIdentity({ runtimeProviders: true, compiled: [] });
  const h = providerHarness();
  liveProviders(h, providersValue);
  const journal = await verifiedIdentityDeploy(h);
  const previous = journal.deployment!.attempt.identity_sha256;
  await writeIdentity({ runtimeProviders: false, compiled: [compiledIdentity] });
  expect((await deploy(options(h, { rollout: 100, providers: { kind: 'remove' } }))).exitCode).toBe(
    0,
  );
  const deployment = (await store.read())!.deployment!;
  expect(providerUploads(h)).toHaveLength(2);
  expect(deployment.attempt.identity_sha256).not.toBe(previous);
  expect(deployment.last_verified!.identity_sha256).toBe(previous);
});

it.each([null, 'a'.repeat(64), '', 'A'.repeat(64), 'a'.repeat(63), 1, {}])(
  'validates optional identity hashes on attempts and verified receipts: %j',
  async (value) => {
    const h = harness();
    const journal = await verifiedIdentityDeploy(h);
    journal.deployment!.last_verified = structuredClone(journal.deployment!.attempt);
    for (const field of ['attempt', 'last_verified'] as const) {
      const changed = structuredClone(journal);
      Object.assign(changed.deployment![field]!, { identity_sha256: value });
      await writeFile(store.path, JSON.stringify(changed));
      if (value === null || value === 'a'.repeat(64))
        expect((await store.read())!.deployment![field]!.identity_sha256).toBe(value);
      else await expect(store.read()).rejects.toMatchObject({ code: 'invalid_inventory' });
    }
  },
);

it('returns unchanged for an already verified split with a legacy identity receipt', async () => {
  const h = providerHarness();
  liveProviders(h, providersValue);
  await verifiedIdentityDeploy(h);
  expect((await deploy(options(h, { rollout: 25 }))).exitCode).toBe(0);
  const journal = (await store.read())!;
  journal.deployment!.attempt.phase = 'verified';
  journal.deployment!.attempt.smoke = 'passed';
  delete journal.deployment!.attempt.identity_sha256;
  await store.write(journal);
  h.settingsVersion = NEWEST;
  const before = await readFile(store.path, 'utf8');
  const result = await deploy(options(h, { rollout: 25 }));
  expect(result.exitCode).toBe(0);
  expect(result.output.plan).toContainEqual({ stage: 'deploy', action: 'unchanged' });
  expect(providerUploads(h)).toHaveLength(2);
  expect(await readFile(store.path, 'utf8')).toBe(before);
});

it.each(['modern', 'legacy'] as const)(
  'resumes an in-flight partial rollout with a %s identity attempt',
  async (mode) => {
    const h = providerHarness();
    liveProviders(h, providersValue);
    await verifiedIdentityDeploy(h);
    h.uploadLost = true;
    expect((await deploy(options(h, { rollout: 25 }))).exitCode).not.toBe(0);
    const journal = (await store.read())!;
    expect(journal.deployment!.attempt.phase).toBe('upload_pending');
    const expected = journal.deployment!.attempt.identity_sha256;
    delete journal.deployment!.last_verified!.identity_sha256;
    if (mode === 'legacy') delete journal.deployment!.attempt.identity_sha256;
    await store.write(journal);
    h.uploadLost = false;
    expect((await deploy(options(h, { rollout: 25 }))).exitCode).toBe(0);
    expect(providerUploads(h)).toHaveLength(2);
    expect((await store.read())!.deployment!.attempt.identity_sha256).toBe(expected);
  },
);

it.each(['active', 'rollback_pending'] as const)(
  'refuses a partial rollout against an older verified policy while the latest attempt is %s',
  async (phase) => {
    await writeIdentity({ runtimeProviders: true, compiled: [] });
    const h = providerHarness();
    liveProviders(h, '[]');
    await verifiedIdentityDeploy(h);
    liveProviders(h, providersValue);
    h.versions.get(CANDIDATE)!.resources = h.versions.get(OLD)!.resources;
    expect((await deploy(options(h))).exitCode).toBe(0);
    const journal = (await store.read())!;
    journal.deployment!.attempt.phase = phase;
    await store.write(journal);
    const before = await readFile(store.path, 'utf8');
    const result = await deploy(
      options(h, { rollout: 25, providers: { kind: 'set', value: '[]', ids: [] } }),
    );
    expect(result.output.error).toMatchObject({
      code: 'invalid_input',
      message:
        'partial rollout is not allowed when SSO provider configuration changes; deploy with --rollout 100 first',
    });
    expect(providerUploads(h)).toHaveLength(2);
    expect(await readFile(store.path, 'utf8')).toBe(before);
  },
);

it('refuses changed identity on partial dry-run without upload or journal writes', async () => {
  const h = providerHarness();
  liveProviders(h, providersValue);
  await verifiedIdentityDeploy(h);
  const before = await readFile(store.path, 'utf8');
  const result = await deploy(
    options(h, { dryRun: true, rollout: 25, providers: { kind: 'remove' } }),
  );
  expect(result.output.error).toMatchObject({
    code: 'invalid_input',
    message:
      'partial rollout is not allowed when SSO provider configuration changes; deploy with --rollout 100 first',
  });
  expect(providerUploads(h)).toHaveLength(1);
  expect(await readFile(store.path, 'utf8')).toBe(before);
});

it('copies the identity hash into last_verified through the real smoke path', async () => {
  await writeIdentity({ runtimeProviders: true, compiled: [] });
  const h = lifecycleHarness();
  const o = options(h, { secret: ['PB_MASTER_KEY'] });
  expect((await deploy(o)).exitCode).toBe(0);
  const expected = (await store.read())!.deployment!.attempt.identity_sha256;
  expect(expected).toMatch(/^[a-f0-9]{64}$/);
  const checked = await smoke({
    workerName: 'broker',
    projectRoot: project,
    env: o.env,
    fetch: h.fetch,
    now: h.now,
    sleep: h.sleep,
  });
  expect(checked.exitCode).toBe(0);
  const deployment = (await store.read())!.deployment!;
  expect(deployment.attempt.phase).toBe('verified');
  expect(deployment.attempt.identity_sha256).toBe(expected);
  expect(deployment.last_verified!.identity_sha256).toBe(expected);
});

const identityOf = (result: Awaited<ReturnType<typeof deploy>>) =>
  (result.output as Record<string, unknown>).identity;
const hexDigest = expect.stringMatching(/^[a-f0-9]{64}$/);
const identityLeaks = [
  'IDP_SENTINEL',
  providersSentinel,
  'idp.example.com',
  'idp.example.test',
  'old.example.test',
  'team.example.com',
  'a'.repeat(64),
  'oidc:',
  'access:',
];
function expectNoIdentityLeak(result: Awaited<ReturnType<typeof deploy>>) {
  const serialized = JSON.stringify(result.output);
  for (const value of identityLeaks) expect(serialized).not.toContain(value);
}
it('dry-run lists compiled providers without overrides or values', async () => {
  await writeIdentity({ runtimeProviders: true, compiled: [compiledIdentity, accessIdentity] });
  const h = harness();
  const result = await deploy(options(h, { dryRun: true }));
  expect(result.exitCode).toBe(0);
  expect(identityOf(result)).toEqual({
    providers: [
      { id: 'corp', type: 'oidc', source: 'compiled' },
      { id: 'access', type: 'cloudflare-access', source: 'compiled' },
    ],
    overrides: [],
    displaced: [],
    runtime_providers_applied: true,
    runtime_document_problem: null,
    providers_sha256: null,
    identity_sha256: hexDigest,
    skipped_checks: [],
  });
  expectNoIdentityLeak(result);
  expect(mutations(h)).toEqual([]);
});
it('dry-run reports a runtime entry that overrides a compiled id', async () => {
  await writeIdentity({
    runtimeProviders: true,
    compiled: [{ id: 'test', kind: 'oidc', anchor: 'oidc:https://old.example.test' }],
  });
  const h = providerHarness();
  const result = await deploy(
    options(h, {
      dryRun: true,
      secret: ['PB_IDP_TEST_CLIENT_SECRET'],
      providers: { kind: 'set', value: providersValue, ids: ['test'] },
    }),
  );
  expect(result.exitCode).toBe(0);
  expect(identityOf(result)).toEqual({
    providers: [{ id: 'test', type: 'oidc', source: 'runtime' }],
    overrides: ['test'],
    displaced: [],
    runtime_providers_applied: true,
    runtime_document_problem: null,
    providers_sha256: digest(providersValue),
    identity_sha256: hexDigest,
    skipped_checks: [],
  });
  expectNoIdentityLeak(result);
  expect(mutations(h)).toEqual([]);
});
it('dry-run reports a compiled entry displaced by a runtime anchor with its reason', async () => {
  await writeIdentity({ runtimeProviders: true, compiled: [compiledIdentity, accessIdentity] });
  const value = JSON.stringify([
    { ...JSON.parse(providersValue)[0], issuer: 'https://idp.example.com' },
  ]);
  const h = providerHarness();
  const result = await deploy(
    options(h, { dryRun: true, providers: { kind: 'set', value, ids: ['test'] } }),
  );
  expect(result.exitCode).toBe(0);
  expect(identityOf(result)).toEqual({
    providers: [
      { id: 'access', type: 'cloudflare-access', source: 'compiled' },
      { id: 'test', type: 'oidc', source: 'runtime' },
    ],
    overrides: [],
    displaced: [{ id: 'corp', reason: 'displaced', by: 'test' }],
    runtime_providers_applied: true,
    runtime_document_problem: null,
    providers_sha256: digest(value),
    identity_sha256: hexDigest,
    skipped_checks: [],
  });
  expectNoIdentityLeak(result);
});
it('dry-run with --providers none drops runtime entries and the providers digest', async () => {
  await writeIdentity({ runtimeProviders: true, compiled: [compiledIdentity] });
  const h = providerHarness();
  liveProviders(h, providersValue);
  const result = await deploy(options(h, { dryRun: true, providers: { kind: 'remove' } }));
  expect(result.exitCode).toBe(0);
  expect(identityOf(result)).toEqual({
    providers: [{ id: 'corp', type: 'oidc', source: 'compiled' }],
    overrides: [],
    displaced: [],
    runtime_providers_applied: true,
    runtime_document_problem: null,
    providers_sha256: null,
    identity_sha256: hexDigest,
    skipped_checks: [],
  });
  expectNoIdentityLeak(result);
});
it('dry-run plans compiled-only when the artifact ignores runtime providers', async () => {
  await writeIdentity({ runtimeProviders: false, compiled: [compiledIdentity] });
  const value = JSON.stringify([
    { ...JSON.parse(providersValue)[0], id: 'corp', issuer: 'https://idp.example.com' },
  ]);
  const h = harness();
  h.installed.push('PB_IDP_CORP_CLIENT_SECRET');
  liveProviders(h, value);
  const result = await deploy(options(h, { dryRun: true }));
  expect(result.exitCode).toBe(0);
  expect(identityOf(result)).toEqual({
    providers: [{ id: 'corp', type: 'oidc', source: 'compiled' }],
    overrides: [],
    displaced: [],
    runtime_providers_applied: false,
    runtime_document_problem: null,
    providers_sha256: digest(value),
    identity_sha256: hexDigest,
    skipped_checks: [],
  });
  expectNoIdentityLeak(result);
});
it.each([
  ['an explicit value', true],
  ['the preserved live value', false],
])('dry-run preview cleanup carries identity for %s', async (_name, explicit) => {
  const h = harness();
  expect((await deploy(options(h, { rollout: 25 }))).exitCode).toBe(0);
  await writeIdentity({ runtimeProviders: true, compiled: [compiledIdentity] });
  const j = (await store.read())!;
  j.deployment!.attempt.preview = 'cleanup_pending';
  await store.write(j);
  const before = mutations(h).length;
  const result = await deploy(
    options(h, {
      dryRun: true,
      ...(explicit
        ? { providers: { kind: 'set' as const, value: providersValue, ids: ['test'] } }
        : {}),
    }),
  );
  expect(result.exitCode).toBe(0);
  expect(result.output.plan).toContainEqual({
    stage: 'deploy',
    action: 'reconcile_preview_cleanup',
  });
  expect(identityOf(result)).toEqual({
    providers: explicit
      ? [
          { id: 'corp', type: 'oidc', source: 'compiled' },
          { id: 'test', type: 'oidc', source: 'runtime' },
        ]
      : [{ id: 'corp', type: 'oidc', source: 'compiled' }],
    overrides: [],
    displaced: [],
    runtime_providers_applied: true,
    runtime_document_problem: null,
    providers_sha256: explicit ? digest(providersValue) : null,
    identity_sha256: explicit ? hexDigest : null,
    skipped_checks: explicit ? [] : ['live_providers'],
  });
  expectNoIdentityLeak(result);
  expect(mutations(h)).toHaveLength(before);
});
it.each([
  ['{', 'syntax'],
  ['{}', 'not_array'],
] as const)(
  'reports a runtime document problem (%s) and keeps the compiled set',
  async (value, problem) => {
    const { dryRunIdentity } = await import('./deploy.js');
    const identity = dryRunIdentity(
      { runtimeProviders: true, compiled: [compiledIdentity as never] },
      value,
      null,
    );
    expect(identity).toMatchObject({
      providers: [{ id: 'corp', type: 'oidc', source: 'compiled' }],
      overrides: [],
      displaced: [],
      runtime_document_problem: problem,
    });
    expect(
      dryRunIdentity(
        { runtimeProviders: false, compiled: [compiledIdentity as never] },
        value,
        null,
      ),
    ).toMatchObject({ runtime_providers_applied: false, runtime_document_problem: null });
  },
);
it('dry-run reports identity null for a legacy artifact', async () => {
  const result = await deploy(options(harness(), { dryRun: true }));
  expect(result.exitCode).toBe(0);
  expect(result.output).toHaveProperty('identity', null);
  expectNoIdentityLeak(result);
});
it('a deploy that is not a dry run has no identity key', async () => {
  await writeIdentity({ runtimeProviders: true, compiled: [compiledIdentity] });
  const h = providerHarness();
  const result = await deploy(
    options(h, { providers: { kind: 'set', value: providersValue, ids: ['test'] } }),
  );
  expect(result.exitCode).toBe(0);
  expect(Object.hasOwn(result.output, 'identity')).toBe(false);
});

const ORG = 'org-anchor-preflight';
type D1Fake = {
  organization?: unknown[];
  bindings?: Record<string, unknown[]>;
  fail?: 'transport' | 'sql' | 'no_table';
};
function withD1(h: ReturnType<typeof harness>, fake: D1Fake) {
  const queried: { sql: string; params: unknown[] }[] = [];
  const upstream = h.fetch;
  h.fetch = (async (input: unknown, init?: RequestInit) => {
    if (!String(input).endsWith(`/accounts/${ACCOUNT}/d1/database/${DB}/query`))
      return upstream(input as string, init);
    const { sql, params } = JSON.parse(String(init?.body));
    queried.push({ sql, params });
    if (fake.fail === 'transport') throw new Error('connection reset');
    if (fake.fail === 'sql' || fake.fail === 'no_table')
      return new Response(
        JSON.stringify({
          success: false,
          errors: [
            {
              code: 7500,
              message:
                fake.fail === 'sql' ? 'no such table' : 'no such table: organization: SQLITE_ERROR',
            },
          ],
        }),
        { status: 400 },
      );
    const results = sql.includes('"identity_provider_binding"')
      ? (fake.bindings?.[params.at(-1)] ?? [])
      : (fake.organization ?? [{ id: ORG, slug: 'acme', name: 'Acme' }]);
    return new Response(
      JSON.stringify({ success: true, result: [{ success: true, results, meta: { changes: 0 } }] }),
    );
  }) as typeof fetch;
  return queried;
}
const bound = (anchor: unknown) => [{ anchor, created_at: '2026-10-01T00:00:00.000Z' }];
const queriedProviders = (queried: { sql: string; params: unknown[] }[]) =>
  queried.filter((q) => q.sql.includes('"identity_provider_binding"')).map((q) => q.params.at(-1));

it('anchor preflight lets a deploy through when the stored anchor is equal', async () => {
  await writeIdentity({ runtimeProviders: true, compiled: [compiledIdentity, accessIdentity] });
  const h = harness();
  const queried = withD1(h, {
    bindings: { corp: bound(compiledIdentity.anchor), access: bound(accessIdentity.anchor) },
  });
  const result = await deploy(options(h));
  expect(result.exitCode).toBe(0);
  expect(queriedProviders(queried)).toEqual(['corp', 'access']);
  expect(queried.every((q) => q.params.includes(ORG) || !q.sql.includes('binding'))).toBe(true);
  expect(providerUploads(h)).toHaveLength(1);
});

it.each([true, false])(
  'anchor preflight refuses a changed anchor for a bound id (dry run %s)',
  async (dryRun) => {
    await writeIdentity({ runtimeProviders: true, compiled: [compiledIdentity, accessIdentity] });
    const h = harness();
    withD1(h, { bindings: { corp: bound('oidc:https://stored.example.org') } });
    const result = await deploy(options(h, { dryRun }));
    expect(result.exitCode).toBe(2);
    expect(result.output.error).toMatchObject({
      code: 'provider_anchor_changed',
      stage: 'deploy',
      message: expect.stringContaining('corp'),
    });
    expect(result.output.error!.message).toContain('pb admin rebind-provider');
    const serialized = JSON.stringify(result.output);
    for (const value of ['stored.example.org', 'idp.example.com', accessIdentity.anchor])
      expect(serialized).not.toContain(value);
    expect(providerUploads(h)).toHaveLength(0);
    expect(mutations(h)).toEqual([]);
  },
);

it.each<[string, D1Fake]>([
  ['no organization', { organization: [] }],
  ['no binding for the id', { bindings: {} }],
])('anchor preflight passes a fresh install: %s', async (_name, fake) => {
  await writeIdentity({ runtimeProviders: true, compiled: [compiledIdentity] });
  const h = harness();
  const queried = withD1(h, fake);
  expect((await deploy(options(h))).exitCode).toBe(0);
  expect(queried.length).toBeGreaterThan(0);
  expect(providerUploads(h)).toHaveLength(1);
});

async function emptyLedger() {
  const j = (await store.read())!;
  j.migrations.ledger = [];
  await store.write(j);
}
it('dry-run lists anchor_preflight as skipped when D1 has no organization table', async () => {
  await writeIdentity({ runtimeProviders: true, compiled: [compiledIdentity] });
  await emptyLedger();
  const h = harness();
  const queried = withD1(h, { fail: 'no_table' });
  const result = await deploy(options(h, { dryRun: true }));
  expect(result.exitCode).toBe(0);
  expect(identityOf(result)).toMatchObject({ skipped_checks: ['anchor_preflight'] });
  expect(queried).toHaveLength(1);
  expect(mutations(h)).toEqual([]);
});

it.each<[string, D1Fake]>([
  ['a changed anchor', { bindings: { corp: bound('oidc:https://stored.example.org') } }],
  ['a transport failure', { fail: 'transport' }],
  ['another SQL error', { fail: 'sql' }],
])('dry-run with an empty ledger still reads D1 and refuses %s', async (name, fake) => {
  await writeIdentity({ runtimeProviders: true, compiled: [compiledIdentity] });
  await emptyLedger();
  const h = harness();
  withD1(h, fake);
  const result = await deploy(options(h, { dryRun: true }));
  expect(result.output.error?.code).toBe(
    name === 'a changed anchor' ? 'provider_anchor_changed' : 'provider_failure',
  );
  expect(mutations(h)).toEqual([]);
});

it('a non-dry-run deploy does not skip on a missing organization table', async () => {
  await writeIdentity({ runtimeProviders: true, compiled: [compiledIdentity] });
  const h = harness();
  withD1(h, { fail: 'no_table' });
  const result = await deploy(options(h));
  expect(result.output.error?.code).toBe('provider_failure');
  expect(providerUploads(h)).toHaveLength(0);
});

it('anchor preflight refuses an unchanged redeploy after the stored anchor changed', async () => {
  await writeIdentity({ runtimeProviders: true, compiled: [compiledIdentity] });
  const h = harness();
  const fake: D1Fake = { bindings: { corp: bound(compiledIdentity.anchor) } };
  withD1(h, fake);
  expect((await deploy(options(h))).exitCode).toBe(0);
  const verified = (await store.read())!;
  verified.deployment!.attempt.phase = 'verified';
  verified.deployment!.attempt.smoke = 'passed';
  await store.write(verified);
  const unchanged = await deploy(options(h));
  expect(unchanged.output.plan).toEqual([{ stage: 'deploy', action: 'unchanged' }]);
  fake.bindings = { corp: bound('oidc:https://stored.example.org') };
  const before = await readFile(store.path, 'utf8');
  const result = await deploy(options(h));
  expect(result.output.error?.code).toBe('provider_anchor_changed');
  expect(providerUploads(h)).toHaveLength(1);
  expect(await readFile(store.path, 'utf8')).toBe(before);
});

it.each<[string, D1Fake]>([
  ['transport failure', { fail: 'transport' }],
  ['sql error', { fail: 'sql' }],
  ['non-string anchor', { bindings: { corp: bound(7) } }],
  ['invalid anchor', { bindings: { corp: bound('not an anchor') } }],
  ['null row', { bindings: { corp: [null] } }],
  ['malformed organization row', { organization: [{ slug: 'acme' }] }],
])('anchor preflight fails closed on %s', async (_name, fake) => {
  await writeIdentity({ runtimeProviders: true, compiled: [compiledIdentity] });
  const h = harness();
  withD1(h, fake);
  const result = await deploy(options(h));
  expect(result.exitCode).toBe(1);
  expect(result.output.error).toMatchObject({ code: 'provider_failure', stage: 'deploy' });
  expect(providerUploads(h)).toHaveLength(0);
  expect(mutations(h)).toEqual([]);
});

it('anchor preflight does not check a provider removed from the effective set', async () => {
  await writeIdentity({ runtimeProviders: true, compiled: [compiledIdentity] });
  const value = JSON.stringify([
    { ...JSON.parse(providersValue)[0], issuer: 'https://idp.example.com' },
  ]);
  const h = providerHarness();
  const queried = withD1(h, {
    bindings: {
      corp: bound('oidc:https://stored.example.org'),
      test: bound('oidc:https://idp.example.com'),
    },
  });
  const result = await deploy(options(h, { providers: { kind: 'set', value, ids: ['test'] } }));
  expect(result.exitCode).toBe(0);
  expect(queriedProviders(queried)).toEqual(['test']);
});

it.each([
  [{ flag: 'private-value' }, 'auth_local_invalid'],
  [
    {
      sources: [
        { bindings: [{ name: 'PB_AUTH_LOCAL', type: 'plain_text', text: 'private-value' }] },
      ],
    },
    'Invalid live PB_AUTH_LOCAL binding',
  ],
  [{ flag: 'enabled', env: 'disabled' }, 'PB_AUTH_LOCAL conflicts with --local-auth'],
  [
    { secretNames: ['PB_AUTH_LOCAL'] },
    'Remove the secret first: wrangler secret delete PB_AUTH_LOCAL',
  ],
] as const)(
  'preserves local-auth input reason through deploy failure wrapping: %j',
  async (input, message) => {
    const h = harness();
    const result = await deploy(
      options(h, {
        contract: {
          ...fixtureContract,
          domainZone: async () => {
            resolveLocalAuth({ sources: null, ...input, stage: 'setup' });
            return ZONE;
          },
        },
      }),
    );
    expect(result.exitCode).toBe(2);
    expect(result.output.error).toMatchObject({ code: 'invalid_input', stage: 'deploy', message });
    expect(JSON.stringify(result.output)).not.toContain('private-value');
  },
);

it('reads legacy local-auth support as unknown and permits enabled mode', async () => {
  const artifact = await validateDeploymentArtifact(out);
  expect(artifact.localAuth).toBeNull();
  expect(() => assertLocalAuthAccepted('enabled', artifact.localAuth)).not.toThrow();
  expect(() => assertLocalAuthAccepted('disabled', artifact.localAuth)).toThrow(CloudflareError);
});

it('validates a supported local-auth capability for disabled mode', async () => {
  const file = join(out, 'generated/manifest.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  const legacyHash = (await validateDeploymentArtifact(out)).artifactHash;
  manifest.localAuth = { version: 1 };
  await writeFile(file, JSON.stringify(manifest));
  const artifact = await validateDeploymentArtifact(out);
  expect(artifact.localAuth).toEqual({ version: 1 });
  expect(Object.isFrozen(artifact.localAuth)).toBe(true);
  expect(artifact.artifactHash).not.toBe(legacyHash);
  expect(() => assertLocalAuthAccepted('disabled', artifact.localAuth)).not.toThrow();
});

it.each([
  null,
  [],
  'private-input',
  {},
  { version: 0 },
  { version: 2 },
  { version: '1' },
  { version: 1, extra: true },
])('rejects malformed or unsupported local-auth capability %j', async (localAuth) => {
  const file = join(out, 'generated/manifest.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.localAuth = localAuth;
  await writeFile(file, JSON.stringify(manifest));
  await expect(validateDeploymentArtifact(out)).rejects.toMatchObject({
    code: 'invalid_input',
    exitCode: 2,
  });
  try {
    assertLocalAuthAccepted('disabled', localAuth);
    expect.fail('disabled mode must be refused');
  } catch (error) {
    expect(error).toBeInstanceOf(CloudflareError);
    expect(error).toMatchObject({ code: 'invalid_input', exitCode: 2 });
    expect(String(error)).not.toContain('private-input');
  }
});

it.each([undefined, null, '', 'ENABLED', 'private-input', false, 0, {}, []])(
  'refuses an unknown local-auth mode with or without support: %j',
  (mode) => {
    const check = (capability: unknown) =>
      assertLocalAuthAccepted(mode as 'enabled' | 'disabled', capability);
    for (const capability of [undefined, null, {}, { version: 2 }, { version: 1 }]) {
      expect(() => check(capability)).toThrow(CloudflareError);
      try {
        check(capability);
      } catch (error) {
        expect(error).toMatchObject({ code: 'invalid_input', exitCode: 2 });
        expect(String(error)).not.toContain('private-input');
      }
    }
  },
);

async function localAuthArtifact(compiled: unknown[] = [accessIdentity]) {
  await writeIdentity({ runtimeProviders: true, compiled });
  const file = join(out, 'generated/manifest.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.localAuth = { version: 1 };
  await writeFile(file, JSON.stringify(manifest));
}
function liveLocalAuth(
  h: ReturnType<typeof harness>,
  text: unknown,
  id = OLD,
  type = 'plain_text',
) {
  const resources = h.versions.get(id)!.resources as { bindings: unknown[] };
  resources.bindings = [
    ...resources.bindings.filter((b) => object(b).name !== 'PB_AUTH_LOCAL'),
    { type, name: 'PB_AUTH_LOCAL', text },
  ];
}
const localBinding = (text: string) => ({ type: 'plain_text', name: 'PB_AUTH_LOCAL', text });

it.each(['enabled', 'disabled'] as const)(
  'first deploy freezes and receipts local auth %s',
  async (mode) => {
    await localAuthArtifact();
    const { h, o } = firstInstall();
    o.localAuth = mode;
    const result = await deploy(o);
    expect(result.output.error).toBeNull();
    const version = h.versions.get(CREATED)!;
    expect((version.resources as { bindings: unknown[] }).bindings).toContainEqual(
      localBinding(mode),
    );
    const journal = (await store.read())!;
    expect(journal.deployment!.attempt.local_auth).toBe(mode);
    expect(journal.deployment!.history!.plain_bindings).toContainEqual({
      name: 'PB_AUTH_LOCAL',
      texts: [mode],
    });
    expect(result.output.checks.some((c) => c.name === 'sso_artifact_upgrade')).toBe(false);
  },
);

it.each([false, true])(
  'preserves disabled and explicitly re-enables (dry-run %s)',
  async (dryRun) => {
    await localAuthArtifact();
    const h = harness();
    liveLocalAuth(h, 'disabled');
    const first = await deploy(options(h, { dryRun }));
    expect(first.output.error).toBeNull();
    expect(first.output.checks).toContainEqual({ name: 'local_auth', status: 'disabled' });
    if (!dryRun) {
      expect(h.metadata!.bindings).toContainEqual(localBinding('disabled'));
      const j = (await store.read())!;
      j.deployment!.attempt.phase = 'verified';
      j.deployment!.attempt.smoke = 'passed';
      await store.write(j);
    }
    const reenabled = await deploy(options(h, { dryRun, localAuth: 'enabled' }));
    expect(reenabled.output.error).toBeNull();
    expect(reenabled.output.checks).toContainEqual({ name: 'local_auth', status: 'enabled' });
    expect(reenabled.output.checks).toContainEqual(
      expect.objectContaining({
        name: 'local_auth_change',
        status: 'notice',
      }),
    );
    if (dryRun) expect(mutations(h)).toEqual([]);
    else expect(h.metadata!.bindings).toContainEqual(localBinding('enabled'));
  },
);

it.each([false, true])(
  'removes runtime providers with compiled fallback before disabling (dry-run %s)',
  async (dryRun) => {
    await localAuthArtifact();
    const h = providerHarness();
    liveProviders(h, providersValue);
    const result = await deploy(
      options(h, { dryRun, localAuth: 'disabled', providers: { kind: 'remove' } }),
    );
    expect(result.output.error).toBeNull();
    if (dryRun) {
      expect(identityOf(result)).toMatchObject({
        providers: [{ id: 'access', type: 'cloudflare-access', source: 'compiled' }],
      });
      expect(mutations(h)).toEqual([]);
    } else {
      expect(h.metadata!.bindings).toContainEqual(localBinding('disabled'));
      expect(uploadedProviders(h)).toEqual([]);
    }
  },
);

it.each([false, true])(
  'rejects unsafe local configurations with zero mutations (dry-run %s)',
  async (dryRun) => {
    for (const scenario of [
      'empty',
      'legacy',
      'compiled-secret',
      'runtime-secret',
      'secret-collision',
      'duplicate',
      'invalid',
      'env-conflict',
      'selected-secret',
    ] as const) {
      await artifact();
      await localAuthArtifact(
        scenario === 'compiled-secret'
          ? [compiledIdentity]
          : scenario === 'empty' || scenario === 'runtime-secret'
            ? []
            : [accessIdentity],
      );
      if (scenario === 'legacy') {
        const file = join(out, 'generated/manifest.json');
        const manifest = JSON.parse(await readFile(file, 'utf8'));
        delete manifest.localAuth;
        await writeFile(file, JSON.stringify(manifest));
      }
      const h = harness();
      const o = options(h, { dryRun, localAuth: 'disabled' });
      if (scenario === 'runtime-secret')
        o.providers = { kind: 'set', value: providersValue, ids: ['test'] };
      if (scenario === 'secret-collision') h.installed.push('PB_AUTH_LOCAL');
      if (scenario === 'selected-secret') o.secret = ['PB_AUTH_LOCAL'];
      if (scenario === 'env-conflict') o.env = { ...o.env, PB_AUTH_LOCAL: 'enabled' };
      if (scenario === 'invalid') {
        delete o.localAuth;
        liveLocalAuth(h, 'INVALID_SENTINEL');
      }
      if (scenario === 'duplicate') {
        liveLocalAuth(h, 'disabled');
        (h.versions.get(OLD)!.resources as { bindings: unknown[] }).bindings.push(
          localBinding('disabled'),
        );
      }
      const result = await deploy(o);
      expect(result.exitCode, scenario).toBe(2);
      expect(mutations(h), scenario).toEqual([]);
      expect(JSON.stringify(result)).not.toContain('INVALID_SENTINEL');
      expect(JSON.stringify(result)).not.toContain('IDP_SENTINEL');
    }
  },
);

it('freezes disabled over a lost upload and refuses conflicting resume before mutations', async () => {
  await localAuthArtifact();
  const h = harness();
  h.uploadLost = true;
  expect((await deploy(options(h, { localAuth: 'disabled' }))).exitCode).not.toBe(0);
  expect((await store.read())!.deployment!.attempt.local_auth).toBe('disabled');
  h.calls.length = 0;
  const conflict = await deploy(options(h, { localAuth: 'enabled' }));
  expect(conflict.output.error?.code).toBe('configuration_conflict');
  expect(mutations(h)).toEqual([]);
  h.uploadLost = false;
  const resumed = await deploy(options(h));
  expect(resumed.output.error).toBeNull();
  expect(providerUploads(h)).toHaveLength(0);
  expect((h.versions.get(CANDIDATE)!.resources as { bindings: unknown[] }).bindings).toContainEqual(
    localBinding('disabled'),
  );
});

it.each(['missing', 'wrong', 'secret'] as const)(
  'refuses resumed version with %s local binding before mutations',
  async (mode) => {
    await localAuthArtifact();
    const h = harness();
    h.uploadLost = true;
    expect((await deploy(options(h, { localAuth: 'disabled' }))).exitCode).not.toBe(0);
    const resources = h.versions.get(CANDIDATE)!.resources as { bindings: unknown[] };
    if (mode === 'missing')
      resources.bindings = resources.bindings.filter((b) => object(b).name !== 'PB_AUTH_LOCAL');
    else
      liveLocalAuth(
        h,
        mode === 'wrong' ? 'enabled' : undefined,
        CANDIDATE,
        mode === 'secret' ? 'secret_text' : 'plain_text',
      );
    h.calls.length = 0;
    const result = await deploy(options(h));
    expect(result.output.error?.code).toBe('configuration_conflict');
    expect(mutations(h)).toEqual([]);
  },
);

it('legacy frozen attempt without room for the binding refuses before mutation', async () => {
  const h = providerHarness();
  await pendingProviders(h);
  const j = (await store.read())!;
  delete j.deployment!.attempt.local_auth;
  j.deployment!.attempt.settings_sha256 = digest('legacy settings without PB_AUTH_LOCAL');
  await store.write(j);
  h.calls.length = 0;
  const result = await deploy(options(h));
  expect(result.output.error).toMatchObject({
    code: 'invalid_input',
    message:
      "This frozen deployment attempt predates local-auth support and cannot be resumed; finish it with the previous release's CLI, then deploy again",
  });
  expect(mutations(h)).toEqual([]);
});

it.each(['failed', 'partial', 'unknown-404', 'unexpected-success'] as const)(
  'never treats %s Worker read as a fresh installation',
  async (mode) => {
    await localAuthArtifact();
    const { h, o } = firstInstall();
    const original = h.fetch;
    o.fetch = vi.fn(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/settings')) {
        if (mode === 'failed') throw new Error('LIVE_READ_SENTINEL');
        if (mode === 'partial') return snap({});
        if (mode === 'unknown-404') return new Response('LIVE_READ_SENTINEL', { status: 404 });
        return snap({ bindings: [localBinding('disabled')] });
      }
      return original(input, init);
    });
    const result = await deploy(o);
    expect(result.exitCode).not.toBe(0);
    expect(mutations(h)).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('LIVE_READ_SENTINEL');
  },
);

it('refuses disagreement across active local modes before mutations', async () => {
  await localAuthArtifact();
  const h = harness();
  await verifiedIdentityDeploy(h);
  expect((await deploy(options(h, { rollout: 25 }))).exitCode).toBe(0);
  const j = (await store.read())!;
  j.deployment!.attempt.phase = 'verified';
  j.deployment!.attempt.smoke = 'passed';
  await store.write(j);
  liveLocalAuth(h, 'disabled', NEWEST);
  h.calls.length = 0;
  const result = await deploy(options(h, { rollout: 25 }));
  expect(result.output.error).toMatchObject({ code: 'configuration_conflict' });
  expect(mutations(h)).toEqual([]);
});

it.each(['redeploy', 'resume'] as const)(
  'checks legacy artifact capability on a preserved disabled %s',
  async (path) => {
    const h = providerHarness();
    if (path === 'resume') {
      await pendingProviders(h);
      const j = (await store.read())!;
      j.deployment!.attempt.local_auth = 'disabled';
      await store.write(j);
    }
    liveLocalAuth(h, 'disabled');
    h.calls.length = 0;
    const result = await deploy(options(h));
    expect(result.output.error).toMatchObject({
      code: 'invalid_input',
      message: 'Cannot disable local sign-in on an artifact without local-auth support',
    });
    expect(mutations(h)).toEqual([]);
  },
);

it('checks the verified Worker version before reporting unchanged', async () => {
  await localAuthArtifact();
  const h = harness();
  await verifiedIdentityDeploy(h);
  const saved = structuredClone(h.versions.get(CANDIDATE)!);
  h.versions.set(THIRD, { ...saved, id: THIRD });
  h.settingsVersion = THIRD;
  liveLocalAuth(h, 'disabled', CANDIDATE);
  h.calls.length = 0;
  const result = await deploy(options(h, { localAuth: 'enabled' }));
  expect(result.output.error?.code).toBe('configuration_conflict');
  expect(mutations(h)).toEqual([]);
});

it('refuses a partial active-version read before any mutation', async () => {
  await localAuthArtifact();
  const h = harness();
  const original = h.fetch;
  const result = await deploy(
    options(h, {
      fetch: async (input, init) =>
        String(input).endsWith(`/versions/${OLD}`)
          ? snap({ id: OLD, annotations: {}, resources: {} })
          : original(input, init),
    }),
  );
  expect(result.exitCode).not.toBe(0);
  expect(mutations(h)).toEqual([]);
});

it('retries a frozen preparing upload and writes its local binding', async () => {
  await localAuthArtifact();
  const h = providerHarness();
  const original = h.fetch;
  h.fetch = vi.fn(async (input, init) =>
    String(input).endsWith('/assets-upload-session')
      ? new Response('', { status: 403 })
      : original(input, init),
  );
  expect((await deploy(options(h, { localAuth: 'disabled' }))).exitCode).not.toBe(0);
  h.fetch = original;
  const resumed = await deploy(options(h));
  expect(resumed.output.error).toBeNull();
  expect(h.metadata!.bindings).toContainEqual(localBinding('disabled'));
});

it('restricts interrupted previews before refusing the next configuration', async () => {
  const h = harness();
  expect((await deploy(options(h, { rollout: 25 }))).exitCode).toBe(0);
  const j = (await store.read())!;
  j.deployment!.attempt.preview = 'cleanup_pending';
  j.deployment!.attempt.phase = 'verified';
  j.deployment!.attempt.smoke = 'passed';
  await store.write(j);
  h.endpoints = { enabled: true, previews_enabled: true };
  h.calls.length = 0;
  const result = await deploy(options(h, { localAuth: 'disabled' }));
  expect(result.output.error).toMatchObject({
    code: 'configuration_conflict',
  });
  expect(result.output.checks).toContainEqual({
    name: 'preview_cleanup',
    status: 'configuration_conflict',
  });
  expect(mutations(h)).toEqual([
    expect.objectContaining({
      path: expect.stringContaining('/subdomain'),
      method: 'POST',
      body: { enabled: false, previews_enabled: false },
    }),
  ]);
  h.calls.length = 0;
  const rejected = await deploy(options(h, { rollout: 25, localAuth: 'disabled' }));
  expect(rejected.output.error).toMatchObject({
    code: 'invalid_input',
    message: 'Cannot disable local sign-in on an artifact without local-auth support',
  });
  expect(mutations(h)).toEqual([]);
});

it('preserves compiled policy for effective planning and selects runtime override policy', async () => {
  const definitions = await import('@package-broker/plugin-sso-oidc/definitions');
  const planner = vi.spyOn(definitions, 'planProviders');
  const policy = { verifiedDomains: ['example.com'], emailAuthoritativeDomains: ['example.com'] };
  await localAuthArtifact([{ ...compiledIdentity, policy }]);
  const h = harness();
  h.installed.push('PB_IDP_CORP_CLIENT_SECRET');
  const result = await deploy(
    options(h, {
      dryRun: true,
      localAuth: 'disabled',
      providers: { kind: 'set', value: corpProviders, ids: ['corp'] },
    }),
  );
  expect(result.output.error).toBeNull();
  expect(planner).toHaveBeenCalledWith(
    [expect.objectContaining({ id: 'corp', policy })],
    expect.anything(),
  );
  const effective = planner.mock.results.at(-1)!.value.effective;
  expect(effective).toHaveLength(1);
  expect(effective[0].policy).toEqual(JSON.parse(corpProviders)[0].policy);
  expect(effective[0].policy).not.toEqual(policy);
  expect(mutations(h)).toEqual([]);
});

it('explicit environment mode is managed and frozen on deploy', async () => {
  await localAuthArtifact();
  const h = harness();
  const o = options(h);
  o.env = { ...o.env, PB_AUTH_LOCAL: 'disabled' };
  const result = await deploy(o);
  expect(result.output.error).toBeNull();
  expect(h.metadata!.bindings).toContainEqual(localBinding('disabled'));
  expect(result.output.checks).toContainEqual(
    expect.objectContaining({
      name: 'local_auth_change',
      status: 'notice',
    }),
  );
  expect((await store.read())!.deployment!.attempt.local_auth).toBe('disabled');
});

it.each([false, true])(
  'first deploy refuses disabled without a provider (dry-run %s)',
  async (dryRun) => {
    await localAuthArtifact([]);
    const { h, o } = firstInstall();
    o.localAuth = 'disabled';
    o.dryRun = dryRun;
    const result = await deploy(o);
    expect(result.output.error).toMatchObject({
      code: 'invalid_input',
      message: 'Cannot disable local sign-in without a usable SSO provider',
    });
    expect(mutations(h)).toEqual([]);
  },
);

it.each([false, true])(
  'fresh install refuses disabled on a legacy artifact (dry-run %s)',
  async (dryRun) => {
    const { h, o } = firstInstall();
    const result = await deploy({ ...o, dryRun, localAuth: 'disabled' });
    expect(result.output.error).toMatchObject({
      code: 'invalid_input',
      message: 'Cannot disable local sign-in on an artifact without local-auth support',
    });
    expect(mutations(h)).toEqual([]);
  },
);

it.each(['enabled', 'disabled'] as const)(
  'refuses a partial rollout changing local auth from %s, then permits a full deploy',
  async (initial) => {
    await localAuthArtifact();
    const h = harness();
    const target = initial === 'enabled' ? 'disabled' : 'enabled';
    expect((await deploy(options(h, { localAuth: initial }))).exitCode).toBe(0);
    const j = (await store.read())!;
    j.deployment!.attempt.phase = 'verified';
    j.deployment!.attempt.smoke = 'passed';
    await store.write(j);
    h.calls.length = 0;
    const refused = await deploy(options(h, { localAuth: target, rollout: 25 }));
    expect(refused.output.error).toMatchObject({
      code: 'invalid_input',
      message:
        'partial rollout is not allowed when local sign-in configuration changes; deploy with --rollout 100 first',
    });
    expect(mutations(h)).toEqual([]);
    const full = await deploy(options(h, { localAuth: target }));
    expect(full.output.error).toBeNull();
    expect(full.output.checks).toContainEqual(
      expect.objectContaining({
        name: 'local_auth_change',
        status: 'notice',
      }),
    );
    expect(h.metadata!.bindings).toContainEqual(localBinding(target));
    const later = (await store.read())!;
    later.deployment!.attempt.phase = 'verified';
    later.deployment!.attempt.smoke = 'passed';
    await store.write(later);
    expect((await deploy(options(h, { rollout: 25 }))).output.error).toBeNull();
  },
);

it.each(['enabled', 'disabled'] as const)(
  'explicit %s cannot deploy split live modes',
  async (mode) => {
    await localAuthArtifact();
    const h = harness();
    await verifiedIdentityDeploy(h);
    expect((await deploy(options(h, { rollout: 25 }))).exitCode).toBe(0);
    const j = (await store.read())!;
    j.deployment!.attempt.phase = 'verified';
    j.deployment!.attempt.smoke = 'passed';
    await store.write(j);
    liveLocalAuth(h, 'disabled', mode === 'enabled' ? CANDIDATE : NEWEST);
    h.calls.length = 0;
    for (const rollout of [25, 100]) {
      const result = await deploy(options(h, { rollout, localAuth: mode }));
      expect(result.output.error?.code).toBe('configuration_conflict');
      expect(result.output.checks).toContainEqual({
        name: rollout === 25 ? 'local_auth' : 'deployment',
        status: 'configuration_conflict',
      });
      expect(mutations(h)).toEqual([]);
    }
  },
);

it('only reports the SSO artifact notice when the identity differs from verified', async () => {
  await localAuthArtifact();
  const h = harness();
  const first = await deploy(options(h));
  expect(first.output.checks.some((c) => c.name === 'sso_artifact_upgrade')).toBe(false);
  const j = (await store.read())!;
  j.deployment!.attempt.phase = 'verified';
  j.deployment!.attempt.smoke = 'passed';
  await store.write(j);
  for (const rollout of [100, 25]) {
    const result = await deploy(options(h, { rollout, dryRun: true }));
    expect(result.output.error).toBeNull();
    expect(result.output.checks.some((c) => c.name === 'sso_artifact_upgrade')).toBe(false);
  }
});

it('reports SSO artifact upgrade only for a changed verified receipt outside resume', async () => {
  await localAuthArtifact();
  const h = harness();
  await verifiedIdentityDeploy(h);
  const j = (await store.read())!;
  j.deployment!.attempt.identity_sha256 = digest('previous identity');
  await store.write(j);
  const planned = await deploy(options(h, { dryRun: true }));
  expect(planned.output.error).toBeNull();
  expect(planned.output.checks).toContainEqual(
    expect.objectContaining({
      name: 'sso_artifact_upgrade',
      status: 'notice',
    }),
  );
  await writeFile(
    join(out, 'worker.js'),
    'export default { fetch() { return new Response("rebuilt") } };',
  );
  h.uploadLost = true;
  expect((await deploy(options(h))).output.error?.code).toBe('outcome_unknown');
  h.uploadLost = false;
  const resumed = await deploy(options(h));
  expect(resumed.output.error).toBeNull();
  expect(resumed.output.checks.some((c) => c.name === 'sso_artifact_upgrade')).toBe(false);
});

it.each(['live', 'verified'] as const)(
  'refuses ambient re-enable from %s disabled mode',
  async (state) => {
    await localAuthArtifact();
    const h = harness();
    if (state === 'live') liveLocalAuth(h, 'disabled');
    else {
      await verifiedIdentityDeploy(h);
      const j = (await store.read())!;
      j.deployment!.attempt.local_auth = 'disabled';
      await store.write(j);
    }
    h.calls.length = 0;
    const o = options(h);
    o.env = { ...o.env, PB_AUTH_LOCAL: 'enabled' };
    const result = await deploy(o);
    expect(result.output.error).toMatchObject({
      code: 'invalid_input',
      message: 'Re-enabling local sign-in requires --local-auth enabled',
    });
    expect(mutations(h)).toEqual([]);
    const explicit = await deploy({ ...o, localAuth: 'enabled' });
    expect(explicit.output.error).toBeNull();
    expect(explicit.output.checks).toContainEqual(
      expect.objectContaining({
        name: 'local_auth_change',
        status: 'notice',
      }),
    );
  },
);

it('receipts local auth and telemetry before an interrupted version upload', async () => {
  await localAuthArtifact();
  const file = join(out, 'generated/manifest.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.platformPorts.observability.endpointEnv = 'OTEL_ENDPOINT';
  await writeFile(file, JSON.stringify(manifest));
  const h = harness();
  h.uploadLost = true;
  const original = h.fetch;
  let observed = false;
  const o = options(h, {
    localAuth: 'disabled',
    fetch: async (input, init) => {
      if (String(input).endsWith('/versions') && init?.method === 'POST') {
        const history = (await store.read())!.deployment!.history!;
        expect(history.plain_bindings).toContainEqual({
          name: 'PB_AUTH_LOCAL',
          texts: ['disabled'],
        });
        expect(history.plain_bindings).toContainEqual({
          name: 'OTEL_ENDPOINT',
          texts: ['https://telemetry.example.test'],
        });
        observed = true;
      }
      return original(input, init);
    },
  });
  o.env = { ...o.env, OTEL_ENDPOINT: 'https://telemetry.example.test' };
  expect((await deploy(o)).output.error?.code).toBe('outcome_unknown');
  expect(observed).toBe(true);
  expect((await store.read())!.deployment!.history!.plain_bindings).toContainEqual({
    name: 'PB_AUTH_LOCAL',
    texts: ['disabled'],
  });
});

it.each(['enabled', 'disabled'] as const)(
  'preserves local auth %s through an interrupted deploy, resume and teardown',
  async (mode) => {
    await localAuthArtifact();
    const h = lifecycleHarness();
    const o = options(h, { localAuth: mode, secret: ['PB_MASTER_KEY'] });
    expect((await deploy(o)).exitCode).toBe(0);
    expect(
      (
        await smoke({
          workerName: 'broker',
          projectRoot: project,
          env: o.env,
          fetch: h.fetch,
          now: h.now,
          sleep: h.sleep,
        })
      ).exitCode,
    ).toBe(0);
    await writeFile(
      join(out, 'worker.js'),
      'export default {fetch(){return new Response("retry")}}',
    );
    h.uploadLost = true;
    expect((await deploy(o)).output.error?.code).toBe('outcome_unknown');
    const interrupted = (await store.read())!;
    expect(interrupted.deployment!.attempt.phase).toBe('upload_pending');
    expect(interrupted.deployment!.attempt.local_auth).toBe(mode);
    expect(interrupted.deployment!.history!.plain_bindings).toContainEqual({
      name: 'PB_AUTH_LOCAL',
      texts: [mode],
    });
    expect((h.versions.get(NEWEST)!.resources as { bindings: unknown[] }).bindings).toContainEqual(
      localBinding(mode),
    );
    h.uploadLost = false;
    h.calls.length = 0;
    const resumed = await deploy(options(h, { secret: ['PB_MASTER_KEY'] }));
    expect(resumed.output.error).toBeNull();
    expect(resumed.exitCode).toBe(0);
    expect(resumed.output.version_id).toBe(NEWEST);
    expect(providerUploads(h)).toHaveLength(0);
    const afterResume = (await store.read())!;
    expect(afterResume.deployment!.attempt.local_auth).toBe(mode);
    expect(afterResume.deployment!.history!.plain_bindings).toContainEqual({
      name: 'PB_AUTH_LOCAL',
      texts: [mode],
    });
    const result = await teardown({
      project,
      inventory: store.path,
      env: o.env,
      fetch: h.fetch,
      now: h.now,
      sleep: h.sleep,
      inventoryId: identity.owner_digest,
      iUnderstandThisDeletes: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.output.checks).toContainEqual({ name: 'worker', status: 'deleted' });
    expect(result.output.checks).toContainEqual({ name: 'd1', status: 'deleted' });
    expect(h.exists).toBe(false);
    expect(h.versions.size).toBe(0);
    expect((await store.read())!.deployment!.attempt.local_auth).toBe(mode);
  },
);

it.each(['pending', 'complete', 'worker'] as const)(
  'stale Worker list during journal-owned creation: %s',
  async (state) => {
    const { h, o } = firstInstall();
    expect((await deploy(o)).exitCode).toBe(0);
    const j = (await store.read())!;
    if (state !== 'worker') {
      delete j.resources.worker;
      if (state === 'pending') j.deployment!.attempt.phase = 'preparing_upload';
      j.deployment!.attempt.script_creation = {
        state,
        deployment_id: state === 'complete' ? 'created' : null,
        version_id: state === 'complete' ? CREATED : null,
      };
    }
    await store.write(j);
    h.calls.length = 0;
    const original = h.fetch;
    const result = await deploy({
      ...o,
      fetch: async (input, init) =>
        String(input).endsWith('/workers/scripts') ? snap([]) : original(input, init),
    });
    expect(result.output.error).toMatchObject({
      code: 'outcome_unknown',
      message: expect.stringContaining('retry deploy'),
    });
    expect(mutations(h)).toEqual([]);
  },
);

it.each([{ secret: ['PB_AUTH_LOCAL'] }, { secrets: 'PB_AUTH_LOCAL' }])(
  'selected local-auth secret gives a recovery hint: %j',
  async (selection) => {
    const h = harness();
    const result = await deploy(options(h, selection));
    expect(result.output.error).toMatchObject({
      code: 'invalid_input',
      message: 'Remove the secret first: wrangler secret delete PB_AUTH_LOCAL',
    });
    expect(mutations(h)).toEqual([]);
  },
);

it('refuses a stale absent Worker list when the settings probe finds a Worker', async () => {
  await localAuthArtifact();
  const h = harness();
  liveLocalAuth(h, 'disabled');
  const original = h.fetch;
  const result = await deploy(
    options(h, {
      fetch: async (input, init) =>
        String(input).endsWith('/workers/scripts') ? snap([]) : original(input, init),
    }),
  );
  expect(result.output.error).toMatchObject({
    code: 'configuration_conflict',
  });
  expect(result.output.checks).toContainEqual({
    name: 'worker:identity',
    status: 'configuration_conflict',
  });
  expect(mutations(h)).toEqual([]);
});

it('restricts interrupted endpoints before a configuration refusal without widening', async () => {
  await localAuthArtifact();
  const h = harness();
  h.uploadLost = true;
  expect((await deploy(options(h, { localAuth: 'disabled' }))).exitCode).not.toBe(0);
  h.endpoints = { enabled: true, previews_enabled: true };
  h.calls.length = 0;
  const result = await deploy(options(h, { localAuth: 'enabled' }));
  expect(result.output.error).toMatchObject({
    code: 'configuration_conflict',
  });
  expect(result.output.checks).toContainEqual({
    name: 'local_auth',
    status: 'configuration_conflict',
  });
  expect(mutations(h)).toEqual([
    expect.objectContaining({
      path: expect.stringContaining('/subdomain'),
      method: 'POST',
      body: { enabled: false, previews_enabled: false },
    }),
  ]);
});

it('refuses a partial rollout back to a verified mode when the live mode changed', async () => {
  await localAuthArtifact();
  const h = harness();
  await verifiedIdentityDeploy(h);
  expect((await deploy(options(h, { localAuth: 'disabled' }))).output.error).toBeNull();
  h.calls.length = 0;
  const result = await deploy(options(h, { rollout: 25, localAuth: 'enabled' }));
  expect(result.output.error).toMatchObject({
    code: 'invalid_input',
    message:
      'partial rollout is not allowed when local sign-in configuration changes; deploy with --rollout 100 first',
  });
  expect(mutations(h)).toEqual([]);
});

it('requires the flag when verified disabled survives but live mode is enabled and env is absent', async () => {
  await localAuthArtifact();
  const h = harness();
  await verifiedIdentityDeploy(h);
  const j = (await store.read())!;
  j.deployment!.attempt.local_auth = 'disabled';
  await store.write(j);
  h.calls.length = 0;
  const result = await deploy(options(h));
  expect(result.output.error).toMatchObject({
    code: 'invalid_input',
    message: 'Re-enabling local sign-in requires --local-auth enabled',
  });
  expect(mutations(h)).toEqual([]);
  expect((await deploy({ ...options(h), localAuth: 'enabled' })).output.error).toBeNull();
});
