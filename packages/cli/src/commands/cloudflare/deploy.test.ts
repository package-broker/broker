import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { envelopeResponse } from '@package-broker/core/kernel/errors';
import { smoke } from './smoke.js';
import { teardown } from './teardown.js';
import { stageAssets } from '../../build-assets.js';
import { CloudflareApi, object } from './api.js';
import {
  deploy,
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
  blob: { adapter: 'r2', binding: 'STORAGE', maxBytes: 1024 },
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
    url: `https://${version}-${script}.account.workers.dev`,
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
      const current = h.versions.get(h.active.versions[0]?.version_id ?? '');
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
      return ok(h.domain ? [h.domain] : []);
    }
    if (path === `/zones/${ZONE}/workers/routes`) {
      if (method !== 'GET') h.routes = [{ ...body, id: 'managed-route' }];
      return ok(h.routes);
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
  expect(cloudflareDeployContract.preview).toBeUndefined();
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
    // The old reader could not verify any setting once this consumer existed.
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
  listing: 'worker_id' | 'name_only' = 'worker_id',
) {
  const inner = o.fetch!;
  o.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/workers/scripts')) {
      const response = await inner(input, init);
      const envelope = object(await response.json());
      envelope.result = (envelope.result as Record<string, unknown>[]).map((w) =>
        listing === 'name_only'
          ? w
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
    if (!String(input).endsWith(base + '/settings')) return response;
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
  providerReadback(h, o);
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
it('the production contract refuses a gradual rollout before writes when preview is unavailable', async () => {
  const h = harness();
  const o = options(h, { rollout: 25 });
  delete o.contract;
  delete o.domain;
  expect((await deploy(o)).output.error?.code).toBe('capability_unknown');
  expect(mutations(h)).toEqual([]);
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
it('requires verified provider facilities and refuses unknown inheritance or gradual preview before writes', async () => {
  for (const contract of [
    { ...fixtureContract, secretInheritance: false },
    { versionsCreateScript: true, secretInheritance: true },
    { versionsCreateScript: true, secretInheritance: true, assetHash: sha },
  ]) {
    const h = harness();
    const r = await deploy(
      options(h, { contract: contract as DeployProviderContract, rollout: 20 }),
    );
    expect(r.output.error?.code).toBe('capability_unknown');
    expect(mutations(h)).toHaveLength(0);
  }
});
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
      expect(url).toContain(CANDIDATE);
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

it.each(['PB_PUBLIC_URL', 'DB', 'JOBS', 'ASSETS'])(
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

it('looks up versions by Worker name when the scripts listing carries no worker_id', async () => {
  const { h, o } = firstInstall();
  providerReadback(h, o, 'name_only');
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
  for (const path of fullPaths) expect(path).toContain(`/workers/workers/${script}/versions/`);
});

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
