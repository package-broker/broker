import { teardown } from './teardown.js';
import { InventoryStore, InventoryTransaction, emptyInventory } from './inventory.js';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { collectRegistrations } from '@package-broker/core/kernel/registry';
import type { PluginDefinition } from '@package-broker/core/plugin';
import { renderManifestJson } from '../../manifest.js';
import { installIdentity, type Inventory, type ResourceKind } from './inventory.js';
import {
  provision,
  cloudflareProviderContract,
  runCloudflareProvision,
  type ProviderContract,
  type ProvisionOptions,
} from './provision.js';

const ACCOUNT = 'a'.repeat(32);
const TOKEN = 'token_SENTINEL';
const realConsumer = JSON.parse(
  await readFile(new URL('./fixtures/queue-consumer.json', import.meta.url), 'utf8'),
);
const DB = '11111111-1111-4111-8111-111111111111';
const IDS = [DB, 'broker-production-blobs', 'b'.repeat(32), 'c'.repeat(32)];
const env = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: TOKEN };
const identity = installIdentity({ accountId: ACCOUNT, workerName: 'broker' });
let project: string;
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
const verifiedFixture: ProviderContract = {
  capabilities: async () => ({
    queues: { supported: true, remaining: 100 },
    r2: { supported: true },
    analytics: { supported: true },
  }),
  pendingCreation: () => true,
  exactNameUnique: () => false,
};
interface Remote {
  uuid?: string;
  queue_id?: string;
  name?: string;
  queue_name?: string;
  jurisdiction?: string;
  created_at?: string;
}
interface Harness {
  resources: Record<string, Remote[]>;
  trace: { path: string; method: string; headers: Headers; body?: unknown }[];
  worker: Record<string, unknown> | null;
  planDenied: boolean;
  subdomain: string | null;
  pageSize: number;
  loseCreate: number;
  loseMode:
    | 'transport'
    | 'truncated'
    | 'conflict'
    | 'no_evidence'
    | 'absent'
    | 'transient'
    | 'rate_limited';
  hook: ((path: string, method: string) => Response | undefined) | undefined;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  creates: () => number;
  fetch: typeof fetch;
}
const DEFAULT_ABORT_RULE = {
  id: 'Default Multipart Abort Rule',
  enabled: true,
  conditions: { prefix: '' },
  abortMultipartUploadsTransition: { condition: { type: 'Age', maxAge: 604800 } },
};
function harness(): Harness {
  let time = Date.parse('2026-10-19T12:00:00Z');
  const resources: Record<string, Remote[]> = { d1: [], r2: [], queue: [] };
  const trace: Harness['trace'] = [];
  let createCount = 0;
  const h: Harness = {
    resources,
    trace,
    worker: null as Record<string, unknown> | null,
    planDenied: true,
    subdomain: 'example' as string | null,
    pageSize: 1,
    loseCreate: 0,
    loseMode: 'transport' as
      | 'transport'
      | 'truncated'
      | 'conflict'
      | 'no_evidence'
      | 'absent'
      | 'transient'
      | 'rate_limited',
    hook: undefined as ((path: string, method: string) => Response | undefined) | undefined,
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
    creates: () => createCount,
    fetch: (async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname.split(ACCOUNT)[1]!;
      const method = init?.method ?? 'GET';
      trace.push({
        path: path + url.search,
        method,
        headers: new Headers(init?.headers),
        ...(init?.body
          ? {
              body:
                path === '/analytics_engine/sql'
                  ? String(init.body)
                  : (JSON.parse(String(init.body)) as unknown),
            }
          : {}),
      });
      const override = h.hook?.(path, method);
      if (override) return override;
      if (path === '/subscriptions')
        return h.planDenied
          ? new Response('billing email@example.com SENTINEL', { status: 403 })
          : ok([]);
      if (path === '/workers/subdomain') return ok({ subdomain: h.subdomain });
      if (path.includes('/workers/scripts/'))
        return h.worker === null ? new Response('', { status: 404 }) : ok(h.worker);
      if (path.endsWith('/lifecycle')) {
        expect(new Headers(init?.headers).get('cf-r2-jurisdiction')).toMatch(/^(?:eu|default)$/);
        return ok({ rules: [DEFAULT_ABORT_RULE] });
      }
      const kind: ResourceKind = path.startsWith('/d1')
        ? 'd1'
        : path.startsWith('/r2')
          ? 'r2'
          : 'queue';
      const segments = path.split('/').filter(Boolean);
      const detail = segments.length > (kind === 'queue' ? 1 : 2);
      if (method === 'POST') {
        createCount++;
        const body = JSON.parse(String(init?.body)) as Remote;
        const id =
          kind === 'd1'
            ? IDS[0]!
            : kind === 'r2'
              ? IDS[1]!
              : body.queue_name?.endsWith('-dlq')
                ? IDS[2]!
                : IDS[3]!;
        const remote: Remote = {
          ...body,
          ...(kind === 'd1' ? { uuid: id } : kind === 'queue' ? { queue_id: id } : {}),
          jurisdiction:
            kind === 'r2'
              ? (new Headers(init?.headers).get('cf-r2-jurisdiction') ?? 'default')
              : (body.jurisdiction ?? 'default'),
          created_at: new Date(time).toISOString(),
        };
        if (h.loseCreate !== createCount || h.loseMode !== 'absent') resources[kind]!.push(remote);
        if (h.loseCreate === createCount) {
          if (h.loseMode === 'no_evidence') delete remote.created_at;
          if (h.loseMode === 'transient') return new Response('', { status: 503 });
          if (h.loseMode === 'rate_limited') return new Response('', { status: 429 });
          if (h.loseMode === 'conflict') return new Response('SENTINEL', { status: 409 });
          if (h.loseMode === 'truncated') return new Response('{');
          throw new Error(`${TOKEN} ${ACCOUNT} email@example.com`);
        }
        return ok(remote);
      }
      if (path.endsWith('/consumers')) return ok([]);
      if (detail) {
        const id = segments.at(-1);
        const remote = resources[kind]!.find((r) => (r.uuid ?? r.queue_id ?? r.name) === id);
        return remote ? ok(remote) : new Response('', { status: 404 });
      }
      const page = Number(url.searchParams.get('page') ?? 1);
      const list = resources[kind]!.slice((page - 1) * h.pageSize, page * h.pageSize);
      return ok(kind === 'r2' ? { buckets: list } : list, {
        total_pages: Math.max(1, Math.ceil(resources[kind]!.length / h.pageSize)),
      });
    }) as typeof fetch,
  };
  return h;
}
function ok(result: unknown, result_info?: unknown) {
  return new Response(JSON.stringify({ success: true, result, result_info }));
}
async function build(platformPorts: unknown = ports) {
  const out = join(project, '.pb/cloudflare');
  await mkdir(join(out, 'generated'), { recursive: true });
  await writeFile(
    join(out, 'generated/manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      platform: 'cloudflare',
      platformPorts,
      bindings: [],
      plugins: [],
      migrations: [],
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
}
const statePath = () => join(project, '.pb/state/cloudflare/inventory.broker.production.json');
const journal = async () => JSON.parse(await readFile(statePath(), 'utf8')) as Inventory;
function options(
  h: ReturnType<typeof harness>,
  more: Partial<ProvisionOptions> = {},
): ProvisionOptions {
  return {
    workerName: 'broker',
    project,
    outDir: join(project, '.pb/cloudflare'),
    env,
    fetch: h.fetch,
    now: h.now,
    sleep: h.sleep,
    contract: verifiedFixture,
    yes: true,
    ...more,
  };
}
beforeEach(async () => {
  await mkdir('.pb', { recursive: true });
  project = await mkdtemp(resolve('.pb/provision-test-'));
  await build();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(project, { recursive: true, force: true });
});
it('creates only D1, R2, DLQ, jobs with EU jurisdiction, records logical analytics and reruns unchanged', async () => {
  const h = harness();
  const first = await provision(options(h));
  expect(first.exitCode).toBe(0);
  expect(first.output).toMatchObject({
    database_id: DB,
    r2_bucket: 'broker-production-blobs',
    queue_names: ['broker-production-jobs', 'broker-production-jobs-dlq'],
    kv_namespace_id: null,
  });
  expect(h.trace.filter((r) => r.method === 'POST').map((r) => r.body)).toEqual([
    { name: 'broker-production-db', jurisdiction: 'eu' },
    { name: 'broker-production-blobs' },
    { queue_name: 'broker-production-jobs-dlq', jurisdiction: 'eu' },
    { queue_name: 'broker-production-jobs', jurisdiction: 'eu' },
  ]);
  const bucketCalls = h.trace.filter((r) => r.path.startsWith('/r2/buckets'));
  expect(bucketCalls.some((r) => r.path === '/r2/buckets' && r.method === 'POST')).toBe(true);
  expect(bucketCalls.every((r) => r.headers.get('cf-r2-jurisdiction') === 'eu')).toBe(true);
  expect(bucketCalls.every((r) => !r.path.includes('jurisdiction='))).toBe(true);
  expect((await journal()).resources.analytics).toMatchObject({
    id: null,
    state: 'binding_pending',
  });
  const prompt = vi.fn();
  const second = await provision(options(h, { yes: false, prompt }));
  expect(second.exitCode).toBe(0);
  expect(second.output.database_id).toBe(first.output.database_id);
  expect(h.creates()).toBe(4);
  expect(prompt).not.toHaveBeenCalled();
  expect(h.trace.every((r) => ['GET', 'POST'].includes(r.method))).toBe(true);
});
it('creates R2 in EU with the jurisdiction header and real bucket collection envelopes', async () => {
  const h = harness();
  h.hook = (path, method) =>
    path === '/analytics_engine/sql'
      ? Response.json({ meta: [{ name: 'dataset', type: 'String' }], data: [], rows: 0 })
      : path === '/r2/buckets' && method === 'GET'
        ? new Response(
            JSON.stringify({
              success: true,
              errors: null,
              messages: null,
              result: { buckets: h.resources.r2 },
              result_info: { total_count: h.resources.r2!.length },
            }),
          )
        : undefined;
  expect((await provision(options(h, { contract: cloudflareProviderContract }))).exitCode).toBe(0);
  const create = h.trace.find((r) => r.path === '/r2/buckets' && r.method === 'POST');
  expect(create?.headers.get('cf-r2-jurisdiction')).toBe('eu');
  expect(create?.body).toEqual({ name: 'broker-production-blobs' });
  expect(
    h.trace
      .filter((r) => r.path.startsWith('/r2/buckets'))
      .every((r) => r.headers.get('cf-r2-jurisdiction') === 'eu'),
  ).toBe(true);
});
it('provisions no default-port superset for a build without platform ports', async () => {
  await build(null);
  const h = harness();
  const defaultOptions = options(h);
  delete defaultOptions.contract;
  expect((await provision(defaultOptions)).exitCode).toBe(0);
  expect(h.creates()).toBe(1);
});
it.each([200, 403])(
  'uses SQL evidence for a read-only provision plan without billing permission (%s)',
  async (sqlStatus) => {
    const h = harness();
    h.hook = (path) =>
      path === '/analytics_engine/sql'
        ? new Response(
            JSON.stringify({ meta: [{ name: 'dataset', type: 'String' }], data: [], rows: 0 }),
            { status: sqlStatus },
          )
        : undefined;
    const defaultOptions = options(h, { dryRun: true });
    delete defaultOptions.contract;
    const result = await provision(defaultOptions);
    expect(result.output.checks).toContainEqual({
      name: 'plan_identification',
      status: 'unavailable_optional',
    });
    expect(result.output.checks).toContainEqual({
      name: 'analytics_engine',
      status: sqlStatus === 200 ? 'supported' : 'capability_unknown',
      source: 'analytics_engine_sql',
    });
    if (sqlStatus === 200) {
      expect(result.exitCode).toBe(0);
      expect(result.output.status).toBe('planned');
      expect(result.output.checks).toContainEqual({
        name: 'provider_semantics',
        status: 'documented',
      });
      expect(result.output.plan.filter((entry) => entry.action === 'create')).toHaveLength(4);
    } else {
      expect(result.exitCode).toBe(1);
      expect(result.output.error).toMatchObject({
        code: 'capability_unknown',
        message: expect.stringMatching(/Analytics Engine.*Read.*permission/),
      });
    }
    expect(
      h.trace.every(
        (request) =>
          request.method === 'GET' ||
          (request.path === '/analytics_engine/sql' &&
            request.method === 'POST' &&
            request.body === 'SHOW TABLES'),
      ),
    ).toBe(true);
    expect(h.creates()).toBe(0);
    expect(h.trace.some((request) => request.path.startsWith('/queues?page='))).toBe(true);
    await expect(stat(statePath())).rejects.toMatchObject({ code: 'ENOENT' });
  },
);
it.each([false, true])(
  'accepts generated identity and source bindings with platform ports: %s',
  async (enabled) => {
    const plugins: PluginDefinition[] = [
      {
        id: 'sso-oidc',
        package: '@test/sso-oidc',
        apiVersion: 3,
        platforms: ['cloudflare'],
        binds: ['identity'],
        identityProviders: () => [],
      },
      {
        id: 'source',
        package: '@test/source',
        apiVersion: 3,
        platforms: ['cloudflare'],
        binds: ['source'],
        sourceProviders: () => [],
      },
    ];
    const manifest = renderManifestJson(plugins, new Map(), 'cloudflare', {
      registration: collectRegistrations(plugins),
    });
    expect(manifest.bindings).toEqual([
      { port: 'identity', plugin: 'sso-oidc' },
      { port: 'source', plugin: 'source' },
    ]);
    await writeFile(
      join(project, '.pb/cloudflare/generated/manifest.json'),
      JSON.stringify({
        ...manifest,
        platformPorts: enabled ? ports : null,
      }),
    );
    const h = harness();
    expect((await provision(options(h))).exitCode).toBe(0);
    expect(h.creates()).toBe(enabled ? 4 : 1);
  },
);

it.each(['blob', 'unknown', null])(
  'rejects unsupported plugin binding %s before API access',
  async (port) => {
    const path = join(project, '.pb/cloudflare/generated/manifest.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.bindings = [{ port, plugin: 'invalid' }];
    await writeFile(path, JSON.stringify(manifest));
    const h = harness();
    expect((await provision(options(h))).exitCode).toBe(2);
    expect(h.trace).toEqual([]);
  },
);
it.each(['transport', 'truncated', 'conflict', 'transient', 'rate_limited'] as const)(
  'reconciles a %s response at each of the four create boundaries without duplicates',
  async (loseMode) => {
    for (let boundary = 1; boundary <= 4; boundary++) {
      await rm(join(project, '.pb/state'), { recursive: true, force: true });
      const h = harness();
      h.loseCreate = boundary;
      h.loseMode = loseMode;
      expect((await provision(options(h))).exitCode).toBe(0);
      expect(h.creates()).toBe(4);
      expect((await journal()).operations.every((op) => op.state === 'confirmed')).toBe(true);
      expect((await provision(options(h))).exitCode).toBe(0);
      expect(h.creates()).toBe(4);
    }
  },
);
it('retains unresolved intents, refuses a blind retry and allows exact-ID recovery', async () => {
  const h = harness();
  h.loseCreate = 1;
  h.loseMode = 'no_evidence';
  expect((await provision(options(h))).exitCode).toBe(8);
  expect((await journal()).operations[0]?.state).toBe('unknown');
  expect((await provision(options(h))).exitCode).toBe(8);
  expect(h.creates()).toBe(1);
  expect((await provision(options(h, { adoptResource: [`d1:${DB}`] }))).exitCode).toBe(0);
  expect(h.creates()).toBe(4);
});
it('requires explicit recovery if authoritative reconciliation remains absent', async () => {
  const h = harness();
  h.loseCreate = 1;
  h.loseMode = 'absent';
  expect((await provision(options(h))).exitCode).toBe(6);
  expect((await provision(options(h))).exitCode).toBe(6);
  expect(h.creates()).toBe(1);
});
it('persists the returned ID before a simulated crash at verification and resumes from it', async () => {
  const h = harness();
  h.hook = (path, method) =>
    path === `/d1/database/${DB}` && method === 'GET'
      ? new Response('', { status: 403 })
      : undefined;
  const first = await provision(options(h));
  expect(first.exitCode).not.toBe(0);
  expect((await journal()).resources.d1?.id).toBe(DB);
  h.hook = undefined;
  expect((await provision(options(h))).exitCode).toBe(0);
  expect(h.creates()).toBe(4);
});
it('fully pages, rejects same-name ownership and ambiguous matches, and adopts only exact IDs', async () => {
  const h = harness();
  h.resources.d1!.push(
    { uuid: '22222222-2222-4222-8222-222222222222', name: 'unrelated', jurisdiction: 'eu' },
    { uuid: DB, name: 'broker-production-db', jurisdiction: 'eu' },
  );
  expect((await provision(options(h))).exitCode).toBe(8);
  expect(h.creates()).toBe(0);
  expect(h.trace.some((r) => r.path.includes('page=2'))).toBe(true);
  expect(
    (await provision(options(h, { adoptResource: ['d1:22222222-2222-4222-8222-222222222222'] })))
      .exitCode,
  ).toBe(8);
  h.resources.d1!.push({ uuid: DB, name: 'broker-production-db', jurisdiction: 'eu' });
  expect((await provision(options(h, { adoptResource: [`d1:${DB}`] }))).exitCode).toBe(8);
});
it.each(['default', undefined])(
  'rejects actual jurisdiction %s even with adoption and never trusts hints',
  async (jurisdiction) => {
    const h = harness();
    h.resources.d1!.push({
      uuid: DB,
      name: 'broker-production-db',
      ...(jurisdiction === undefined ? {} : { jurisdiction }),
      location: 'weur',
    } as Remote);
    expect((await provision(options(h, { adoptResource: [`d1:${DB}`] }))).exitCode).toBe(8);
    expect(h.creates()).toBe(0);
  },
);
it('rejects foreign Worker ownership, account identity changes and build changes before creation', async () => {
  const h = harness();
  h.worker = { tags: ['pb-install-v1', `pb-owner-${'f'.repeat(64)}`], bindings: [] };
  expect((await provision(options(h))).exitCode).toBe(8);
  expect(
    (await provision(options(h, { adoptResource: ['worker:broker-production'] }))).exitCode,
  ).toBe(8);
  h.worker = null;
  expect((await provision(options(h))).exitCode).toBe(0);
  expect(
    (await provision(options(h, { env: { ...env, CLOUDFLARE_ACCOUNT_ID: 'd'.repeat(32) } })))
      .exitCode,
  ).toBe(8);
  await build(null);
  expect((await provision(options(h))).exitCode).toBe(8);
});
it('reconstructs exact resource ownership from the tagged Worker bindings on a fresh runner', async () => {
  const h = harness();
  expect((await provision(options(h))).exitCode).toBe(0);
  await rm(join(project, '.pb/state'), { recursive: true });
  h.worker = {
    tags: ['pb-install-v1', `pb-owner-${identity.owner_digest}`],
    bindings: [
      { type: 'd1', name: 'DB', id: DB },
      { type: 'r2_bucket', name: 'STORAGE', bucket_name: 'broker-production-blobs' },
      { type: 'queue', name: 'JOBS', queue_name: 'broker-production-jobs' },
      { type: 'queue', name: 'DLQ', queue_name: 'broker-production-jobs-dlq' },
    ],
  };
  expect((await provision(options(h))).exitCode).toBe(0);
  expect(h.creates()).toBe(4);
});

it.each([
  { type: 'd1', name: 'DB', id: '22222222-2222-4222-8222-222222222222' },
  { type: 'r2_bucket', name: 'STORAGE', bucket_name: 'foreign-blobs' },
  { type: 'queue', name: 'JOBS', queue_name: 'foreign-jobs' },
  { type: 'plain_text', name: 'DB', text: 'wrong-type' },
])('checks incompatible adopted Worker binding $name/$type before creates', async (binding) => {
  const h = harness();
  h.worker = { tags: [], bindings: [binding] };
  const result = await provision(options(h, { adoptResource: ['worker:broker-production'] }));
  expect(result).toMatchObject({
    exitCode: 8,
    output: { error: { code: 'configuration_conflict' } },
  });
  expect(h.creates()).toBe(0);
  await expect(stat(statePath())).rejects.toMatchObject({ code: 'ENOENT' });
});

it('uses cwd-relative build output independently of the configuration directory', async () => {
  const h = harness();
  const fixtures = join(project, 'fixtures');
  await mkdir(fixtures);
  const result = await provision({
    workerName: 'broker',
    configPath: join(fixtures, 'minimal.config.ts'),
    outDir: relative(process.cwd(), join(project, '.pb/cloudflare')),
    env,
    fetch: h.fetch,
    now: h.now,
    sleep: h.sleep,
    contract: verifiedFixture,
    yes: true,
  });
  expect(result.exitCode).toBe(0);
  expect(h.creates()).toBe(4);
  const store = await InventoryStore.create({
    project: fixtures,
    outDir: join(project, '.pb/cloudflare'),
    identity,
  });
  expect((await store.read())?.resources.d1?.id).toBe(DB);
});

it.each(['requirements', 'bindings', 'build-info', 'invalid'])(
  'refuses changed selected-build %s after confirmation before any create',
  async (change) => {
    const h = harness();
    const prompt = vi.fn(async () => {
      if (change === 'requirements') await build(null);
      else if (change === 'bindings')
        await build({ ...ports, blob: { ...ports.blob, binding: 'OTHER_STORAGE' } });
      else if (change === 'build-info') {
        const path = join(project, '.pb/cloudflare/build-info.json');
        const info = JSON.parse(await readFile(path, 'utf8'));
        await writeFile(path, JSON.stringify({ ...info, core: '2.0.1' }));
      } else await writeFile(join(project, '.pb/cloudflare/generated/manifest.json'), '{');
      return 'yes';
    });
    const result = await provision(options(h, { yes: false, interactive: true, prompt }));
    expect(prompt).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ exitCode: 8, output: { error: { code: 'plan_changed' } } });
    expect(h.creates()).toBe(0);
    await expect(stat(statePath())).rejects.toMatchObject({ code: 'ENOENT' });
  },
);
it('requires literal yes, displays exact plan, and revalidates after confirmation', async () => {
  const h = harness();
  const progress = vi.fn();
  const prompt = vi.fn(async () => 'Yes');
  expect(
    (await provision(options(h, { yes: false, interactive: false, progress, prompt }))).exitCode,
  ).toBe(2);
  expect(prompt).not.toHaveBeenCalled();
  expect(
    (await provision(options(h, { yes: false, interactive: true, progress, prompt }))).exitCode,
  ).toBe(2);
  expect(h.creates()).toBe(0);
  expect(progress.mock.calls[0]?.[0]).toContain('broker-production-db');
  expect(progress.mock.calls[0]?.[0]).toContain('eu');
  expect(progress.mock.calls[0]?.[0]).toContain('no deletes');
  prompt.mockImplementation(async () => {
    h.worker = { tags: [], bindings: [] };
    return 'yes';
  });
  expect(
    (await provision(options(h, { yes: false, interactive: true, progress, prompt }))).exitCode,
  ).toBe(8);
  expect(h.creates()).toBe(0);
});
it('dry-run uses only GET, never prompts and changes no inventory, lock, key or token bytes', async () => {
  const h = harness();
  const prompt = vi.fn();
  expect((await provision(options(h, { dryRun: true, yes: false, prompt }))).exitCode).toBe(0);
  await expect(stat(join(project, '.pb/state'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(h.trace.every((r) => r.method === 'GET')).toBe(true);
  expect((await provision(options(h))).exitCode).toBe(0);
  const root = join(project, '.pb/state/cloudflare');
  await writeFile(join(root, 'key'), 'key_SENTINEL');
  await writeFile(join(root, 'token'), 'token_SENTINEL');
  const snapshot = async () =>
    Promise.all(
      (await readdir(root))
        .sort()
        .map(async (name) => [
          name,
          await readFile(join(root, name), 'utf8'),
          (await stat(join(root, name))).mtimeMs,
        ]),
    );
  const before = await snapshot();
  h.trace.length = 0;
  expect((await provision(options(h, { dryRun: true, yes: false, prompt }))).exitCode).toBe(0);
  expect(await snapshot()).toEqual(before);
  expect(h.trace.every((r) => r.method === 'GET')).toBe(true);
  expect(prompt).not.toHaveBeenCalled();
});
it('requires workers.dev registration only for the default origin and never auto-registers', async () => {
  const h = harness();
  h.subdomain = null;
  expect((await provision(options(h))).output.error?.code).toBe('workers_dev_subdomain_missing');
  expect(h.creates()).toBe(0);
  expect((await provision(options(h, { domain: 'registry.example.com' }))).exitCode).toBe(0);
});
it.each([
  [
    {
      queues: { supported: false, remaining: 2 },
      r2: { supported: true },
      analytics: { supported: true },
    },
    'queues_unavailable',
  ],
  [
    {
      queues: { supported: true, remaining: 0 },
      r2: { supported: true },
      analytics: { supported: true },
    },
    'capacity_exceeded',
  ],
  [
    {
      queues: { supported: true, remaining: 2 },
      r2: { supported: false },
      analytics: { supported: true },
    },
    'r2_unavailable',
  ],
  [
    {
      queues: { supported: true, remaining: 2 },
      r2: { supported: true },
      analytics: { supported: false },
    },
    'analytics_engine_unavailable',
  ],
  [{}, 'capability_unknown'],
] as const)('fails closed on required capability evidence %#', async (evidence, code) => {
  const h = harness();
  const result = await provision(
    options(h, { contract: { ...verifiedFixture, capabilities: async () => evidence } }),
  );
  expect(result.output.error?.code).toBe(code);
  expect(h.creates()).toBe(0);
});
it('classifies Queue permission denial without asserting a Free plan, and sanitizes every failure', async () => {
  const h = harness();
  h.hook = (path) =>
    path === '/queues'
      ? new Response(`${TOKEN} ${ACCOUNT} email@example.com`, { status: 403 })
      : undefined;
  const result = await provision(options(h));
  expect(result.output.error?.code).toBe('permission_denied');
  expect(JSON.stringify(result)).not.toMatch(
    new RegExp(`${TOKEN}|${ACCOUNT}|email@example.com|Free`),
  );
  expect(h.creates()).toBe(0);
});
it('produces exactly one JSON envelope on both success and failure', async () => {
  const h = harness();
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await runCloudflareProvision(options(h, { json: true, dryRun: true }))).toBe(0);
  expect(log).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
    schema_version: 1,
    command: 'provision',
    status: 'planned',
  });
  log.mockClear();
  expect(await runCloudflareProvision(options(h, { json: true, env: {} }))).toBe(2);
  expect(log).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
    status: 'error',
    error: { code: 'invalid_input' },
  });
});

it('creates the displayed plan after literal yes and refuses JSON prompting even when a TTY is present', async () => {
  const h = harness();
  const prompt = vi.fn(async () => 'yes');
  expect(
    (await provision(options(h, { yes: false, json: true, interactive: true, prompt }))).exitCode,
  ).toBe(2);
  expect(prompt).not.toHaveBeenCalled();
  expect((await provision(options(h, { yes: false, interactive: true, prompt }))).exitCode).toBe(0);
  expect(prompt).toHaveBeenCalledTimes(1);
});

it('rejects a material plan change after yes even if the new object has explicit adoption', async () => {
  const h = harness();
  const prompt = async () => {
    h.resources.d1!.push({ uuid: DB, name: 'broker-production-db', jurisdiction: 'eu' });
    return 'yes';
  };
  const result = await provision(
    options(h, { yes: false, interactive: true, prompt, adoptResource: [`d1:${DB}`] }),
  );
  expect(result).toMatchObject({ exitCode: 8, output: { error: { code: 'plan_changed' } } });
  expect(h.creates()).toBe(0);
});

it('retains Worker adoption across reruns and refuses changed ownership tags', async () => {
  const h = harness();
  h.worker = { tags: [], bindings: [] };
  expect(
    (await provision(options(h, { adoptResource: ['worker:broker-production'] }))).exitCode,
  ).toBe(0);
  expect((await provision(options(h))).exitCode).toBe(0);
  h.worker.tags = [`pb-owner-${'e'.repeat(64)}`];
  expect((await provision(options(h))).exitCode).toBe(8);
  expect(h.creates()).toBe(4);
});

it('refuses a pre-existing timestamp as evidence of a pending create', async () => {
  const h = harness();
  h.loseCreate = 1;
  const contract = { ...verifiedFixture, pendingCreation: () => true };
  h.hook = (path, method) => {
    if (method === 'GET' && path === '/d1/database' && h.resources.d1!.length)
      h.resources.d1![0]!.created_at = '2020-01-01T00:00:00Z';
    return undefined;
  };
  expect((await provision(options(h, { contract }))).exitCode).toBe(8);
  expect(h.creates()).toBe(1);
});

it('supports explicit default jurisdiction, ignores reuse location hints and refuses unsupported builds before API access', async () => {
  const h = harness();
  expect(
    (await provision(options(h, { jurisdiction: 'default', locationHint: 'weur' }))).exitCode,
  ).toBe(0);
  expect(
    (await provision(options(h, { jurisdiction: 'default', locationHint: 'eeur' }))).exitCode,
  ).toBe(0);
  expect(h.creates()).toBe(4);
  expect(h.trace.filter((r) => r.method === 'POST').map((r) => r.body)).toEqual([
    { name: 'broker-production-db', primary_location_hint: 'weur' },
    { name: 'broker-production-blobs', locationHint: 'weur' },
    { queue_name: 'broker-production-jobs-dlq' },
    { queue_name: 'broker-production-jobs' },
  ]);
  expect(
    h.trace
      .filter((r) => r.path.startsWith('/r2/buckets'))
      .every((r) => r.headers.get('cf-r2-jurisdiction') === 'default'),
  ).toBe(true);
  const unsupported = harness();
  await build({ ...ports, blob: { adapter: 's3' } });
  expect((await provision(options(unsupported))).exitCode).toBe(2);
  expect(unsupported.trace).toHaveLength(0);
});

it('rejects foreign queue consumers even with exact-ID adoption', async () => {
  const h = harness();
  h.resources.queue!.push({ queue_id: 'c'.repeat(32), queue_name: 'broker-production-jobs' });
  h.hook = (path) =>
    path.endsWith('/consumers')
      ? ok([{ type: 'worker', script_name: 'foreign-worker' }])
      : undefined;
  const result = await provision(options(h, { adoptResource: [`queue:${'c'.repeat(32)}`] }));
  expect(result).toMatchObject({
    exitCode: 8,
    output: { error: { code: 'configuration_conflict' } },
  });
  expect(h.creates()).toBe(0);
});

it('keeps a caller-owned setup transaction locked across provision reruns', async () => {
  const h = harness();
  const store = await InventoryStore.create({ project, outDir: '.pb/cloudflare', identity });
  const transaction = await InventoryTransaction.begin(store, h.now());
  try {
    const before = await readFile(store.lockPath, 'utf8');
    expect((await provision(options(h, { transaction }))).exitCode).toBe(0);
    expect((await provision(options(h, { transaction }))).exitCode).toBe(0);
    expect(await readFile(store.lockPath, 'utf8')).toBe(before);
    await expect(store.lock(h.now())).rejects.toMatchObject({ exitCode: 4 });
    expect(h.creates()).toBe(4);
  } finally {
    await transaction.close();
  }
  expect((await provision(options(h, { transaction }))).exitCode).toBe(4);
});

it.each(['d1', 'jobs'] as const)(
  'rejects a reconciled %s ID that contradicts the successful create response',
  async (key) => {
    const h = harness();
    const kind = key === 'd1' ? 'd1' : 'queue';
    const name = `broker-production-${key === 'd1' ? 'db' : 'jobs'}`;
    const originalId = key === 'd1' ? DB : IDS[3];
    const differentId = key === 'd1' ? '22222222-2222-4222-8222-222222222222' : 'd'.repeat(32);
    h.hook = (_path, method) => {
      if (method === 'GET') {
        const remote = h.resources[kind]!.find((r) => (r.name ?? r.queue_name) === name);
        if (remote) {
          if (key === 'd1') remote.uuid = differentId;
          else remote.queue_id = differentId;
        }
      }
      return undefined;
    };
    expect(await provision(options(h))).toMatchObject({
      exitCode: 8,
      output: { error: { code: 'ownership_conflict' } },
    });
    const saved = await journal();
    expect(saved.resources[key]?.id).toBe(originalId);
    expect(saved.operations.at(-1)).toMatchObject({ state: 'unknown', resolved_id: originalId });
    const creates = h.creates();
    expect((await provision(options(h))).exitCode).toBe(8);
    expect(h.creates()).toBe(creates);
  },
);

it('rejects an array resource map before provider requests and preserves its bytes', async () => {
  const h = harness();
  const store = await InventoryStore.create({ project, outDir: '.pb/cloudflare', identity });
  await store.write(emptyInventory(identity, h.now()));
  const bytes = JSON.stringify({ ...(await journal()), resources: [] });
  await writeFile(statePath(), bytes);
  expect(await provision(options(h))).toMatchObject({
    exitCode: 2,
    output: { error: { code: 'invalid_inventory' } },
  });
  expect(h.trace).toEqual([]);
  expect(h.creates()).toBe(0);
  expect(await readFile(statePath(), 'utf8')).toBe(bytes);
});

it.each(['recorded', 'owned-worker', 'foreign-worker', 'foreign-dlq', 'conflicting-alias'])(
  'R8 reconciles the real consumer script field during provision: %s',
  async (evidence) => {
    const h = harness();
    expect((await provision(options(h))).exitCode).toBe(0);
    if (evidence === 'owned-worker') {
      await rm(join(project, '.pb/state'), { recursive: true });
      h.worker = {
        tags: ['pb-install-v1', `pb-owner-${identity.owner_digest}`],
        bindings: [
          { type: 'd1', name: 'DB', id: DB },
          { type: 'r2_bucket', name: 'STORAGE', bucket_name: 'broker-production-blobs' },
          { type: 'queue', name: 'JOBS', queue_name: 'broker-production-jobs' },
        ],
      };
    }
    const consumer = {
      ...realConsumer,
      script: evidence === 'foreign-worker' ? 'foreign-worker' : identity.script_name,
      dead_letter_queue:
        evidence === 'foreign-dlq' ? 'foreign-dlq' : `${identity.script_name}-jobs-dlq`,
      ...(evidence === 'conflicting-alias' ? { script_name: 'foreign-worker' } : {}),
    };
    h.hook = (path) => (path === `/queues/${IDS[3]}/consumers` ? ok([consumer]) : undefined);
    const result = await provision(options(h));
    expect(result.exitCode).toBe(['recorded', 'owned-worker'].includes(evidence) ? 0 : 8);
    expect(h.creates()).toBe(4);
    if (evidence === 'owned-worker')
      expect((await journal()).resources.dlq?.evidence?.source).toBe('worker_binding');
  },
);

it.each(['valid', 'missing', 'foreign-dlq', 'foreign-worker', 'ambiguous'])(
  'recovers default DLQ ownership only through an owned jobs consumer: %s',
  async (evidence) => {
    const h = harness();
    expect((await provision(options(h))).exitCode).toBe(0);
    await rm(join(project, '.pb/state'), { recursive: true });
    h.worker = {
      tags: ['pb-install-v1', `pb-owner-${identity.owner_digest}`],
      bindings: [
        { type: 'd1', name: 'DB', id: DB },
        { type: 'r2_bucket', name: 'STORAGE', bucket_name: 'broker-production-blobs' },
        { type: 'queue', name: 'JOBS', queue_name: 'broker-production-jobs' },
      ],
    };
    const consumer = {
      type: 'worker',
      script_name: evidence === 'foreign-worker' ? 'foreign-worker' : identity.script_name,
      ...(evidence === 'missing'
        ? {}
        : {
            dead_letter_queue:
              evidence === 'foreign-dlq' ? 'foreign-dlq' : 'broker-production-jobs-dlq',
          }),
    };
    h.hook = (path) =>
      path === `/queues/${IDS[3]}/consumers`
        ? ok(evidence === 'ambiguous' ? [consumer, consumer] : [consumer])
        : undefined;
    expect((await provision(options(h))).exitCode).toBe(evidence === 'valid' ? 0 : 8);
    expect(h.creates()).toBe(4);
    if (evidence === 'valid') {
      expect((await journal()).resources.dlq).toMatchObject({
        id: IDS[2],
        state: 'complete',
        evidence: { source: 'worker_binding' },
      });
    } else await expect(stat(statePath())).rejects.toMatchObject({ code: 'ENOENT' });
  },
);

it('preserves a bound analytics checkpoint and all inventory bytes on an unchanged rerun', async () => {
  const h = harness();
  expect((await provision(options(h))).exitCode).toBe(0);
  const saved = await journal();
  saved.resources.analytics = {
    name: 'broker_production_metrics',
    id: null,
    state: 'bound',
    evidence: {
      source: 'worker_binding',
      operation_id: null,
      verified_at: new Date(h.now()).toISOString(),
    },
  };
  const store = await InventoryStore.create({ project, outDir: '.pb/cloudflare', identity });
  await store.write(saved);
  const bytes = await readFile(statePath(), 'utf8');
  const prompt = vi.fn();
  expect((await provision(options(h, { yes: false, interactive: true, prompt }))).exitCode).toBe(0);
  expect(await readFile(statePath(), 'utf8')).toBe(bytes);
  expect(h.creates()).toBe(4);
  expect(prompt).not.toHaveBeenCalled();
});

it('waits for create Retry-After before provision reconciliation without duplicate creates', async () => {
  const h = harness();
  h.loseCreate = 1;
  h.loseMode = 'rate_limited';
  let limitedAt: number | undefined;
  let reconciliationAt: number | undefined;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (limitedAt !== undefined && reconciliationAt === undefined && init?.method === 'GET')
      reconciliationAt = h.now();
    const response = await h.fetch(input, init);
    if (response.status === 429) {
      limitedAt = h.now();
      response.headers.set('retry-after', '60');
    }
    return response;
  };
  expect((await provision(options(h, { fetch }))).exitCode).toBe(0);
  expect(limitedAt).toBeDefined();
  expect(reconciliationAt).toBeDefined();
  expect(reconciliationAt! - limitedAt!).toBeGreaterThanOrEqual(60_000);
  expect(h.creates()).toBe(4);
});

it('budgets every queue scan when provisioning near the account limit', async () => {
  const h = harness();
  h.pageSize = 100;
  h.resources.queue = Array.from({ length: 9998 }, (_, index) => ({
    queue_id: index.toString(16).padStart(32, '0'),
    queue_name: `existing-${index}`,
  }));
  const fixtures = JSON.parse(
    await readFile(new URL('./fixtures/provider-responses.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown>;
  h.hook = (path) =>
    path === '/analytics_engine/sql'
      ? new Response(JSON.stringify(fixtures.analyticsTablesEmpty))
      : undefined;
  const defaultOptions = options(h);
  delete defaultOptions.contract;
  const started = h.now();
  const result = await provision(defaultOptions);
  expect(result.exitCode).toBe(0);
  expect(h.creates()).toBe(4);
  expect(
    h.trace.filter((read) => read.method === 'GET' && read.path.startsWith('/queues?')),
  ).toHaveLength(800);
  expect(h.now() - started).toBeGreaterThan(800_000);
  expect((await journal()).operations.every((operation) => operation.state === 'confirmed')).toBe(
    true,
  );
});

it('starts the provision budget after the confirmation prompt', async () => {
  const h = harness();
  const prompt = vi.fn(async () => {
    await h.sleep(1_800_000);
    return 'yes';
  });
  const result = await provision(options(h, { yes: false, interactive: true, prompt }));
  expect(result.exitCode).toBe(0);
  expect(h.creates()).toBe(4);
});

it('sends no POST once the remaining budget cannot cover a request and its reconciliation', async () => {
  const h = harness();
  let jumped = false;
  h.hook = (_path, method) => {
    if (method === 'GET' && h.creates() === 1 && !jumped) {
      jumped = true;
      void h.sleep(1_160_000);
    }
    return undefined;
  };
  const result = await provision(options(h));
  expect(result).toMatchObject({ exitCode: 1, output: { error: { code: 'deadline_exceeded' } } });
  expect(h.creates()).toBe(1);
  const saved = await journal();
  expect(saved.operations).toHaveLength(1);
  expect(saved.operations[0]?.state).toBe('confirmed');
  expect(saved.resources.r2).toBeUndefined();
});

it('keeps creating while the remaining budget covers a request and its reconciliation', async () => {
  const h = harness();
  let jumped = false;
  h.hook = (_path, method) => {
    if (method === 'GET' && h.creates() === 1 && !jumped) {
      jumped = true;
      void h.sleep(1_100_000);
    }
    return undefined;
  };
  expect((await provision(options(h))).exitCode).toBe(0);
  expect(h.creates()).toBe(4);
});

it('re-reads exact absence immediately before each create', async () => {
  const h = harness();
  let listings = 0;
  h.hook = (path, method) => {
    if (method === 'GET' && path === '/d1/database') {
      listings++;
      if (listings === 3)
        h.resources.d1!.push({ uuid: DB, name: 'broker-production-db', jurisdiction: 'eu' });
    }
    return undefined;
  };
  const result = await provision(options(h));
  expect(result).toMatchObject({ exitCode: 8, output: { error: { code: 'plan_changed' } } });
  expect(h.creates()).toBe(0);
});

it.each([
  [{ type: 'd1', name: 'DB', id: '22222222-2222-4222-8222-222222222222' }],
  [{ type: 'r2_bucket', name: 'STORAGE', bucket_name: 'foreign-blobs' }],
  [{ type: 'queue', name: 'JOBS', queue_name: 'foreign-jobs' }],
])('refuses an owned Worker binding %j that points at a different resource', async (wrong) => {
  const h = harness();
  expect((await provision(options(h))).exitCode).toBe(0);
  await rm(join(project, '.pb/state'), { recursive: true });
  const right = [
    { type: 'd1', name: 'DB', id: DB },
    { type: 'r2_bucket', name: 'STORAGE', bucket_name: 'broker-production-blobs' },
    { type: 'queue', name: 'JOBS', queue_name: 'broker-production-jobs' },
  ];
  h.worker = {
    tags: ['pb-install-v1', `pb-owner-${identity.owner_digest}`],
    bindings: right.map((binding) => (binding.name === wrong.name ? wrong : binding)),
  };
  const result = await provision(
    options(h, {
      adoptResource: [
        `d1:${DB}`,
        'r2:broker-production-blobs',
        `queue:${IDS[2]}`,
        `queue:${IDS[3]}`,
      ],
    }),
  );
  expect(result).toMatchObject({ exitCode: 8, output: { error: { code: 'ownership_conflict' } } });
  expect(h.creates()).toBe(4);
  await expect(stat(statePath())).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses a DLQ that has a consumer of its own', async () => {
  const h = harness();
  expect((await provision(options(h))).exitCode).toBe(0);
  h.hook = (path) =>
    path === `/queues/${IDS[2]}/consumers`
      ? ok([{ type: 'worker', script_name: identity.script_name }])
      : undefined;
  const before = await readFile(statePath(), 'utf8');
  const result = await provision(options(h));
  expect(result).toMatchObject({
    exitCode: 8,
    output: { error: { code: 'configuration_conflict' } },
  });
  expect(await readFile(statePath(), 'utf8')).toBe(before);
  expect(h.creates()).toBe(4);
});

it('abandons a pending intent only after complete authoritative absence and still confirms the plan', async () => {
  const h = harness();
  h.loseCreate = 1;
  h.loseMode = 'absent';
  expect((await provision(options(h))).exitCode).toBe(6);
  const intent = (await journal()).operations[0]!;
  expect(intent.state).toBe('unknown');
  const state = async () => (await journal()).operations.map((op) => op.state);

  const fresh = await provision(options(h, { abandonIntent: intent.id }));
  expect(fresh).toMatchObject({ exitCode: 6, output: { error: { code: 'outcome_unknown' } } });
  expect(await state()).toEqual(['unknown']);
  await h.sleep(60_000);

  expect((await provision(options(h, { abandonIntent: randomUUID() }))).exitCode).toBe(2);
  expect(await state()).toEqual(['unknown']);

  h.hook = (path, method) => (method === 'GET' && path === '/d1/database' ? ok([], {}) : undefined);
  const incomplete = await provision(options(h, { abandonIntent: intent.id }));
  expect(incomplete.output.error?.code).toBe('capability_unknown');
  expect(await state()).toEqual(['unknown']);
  h.hook = undefined;

  h.resources.d1!.push({
    uuid: DB,
    name: 'broker-production-db',
    jurisdiction: 'eu',
    created_at: new Date(h.now()).toISOString(),
  });
  const present = await provision(options(h, { abandonIntent: intent.id }));
  expect(present).toMatchObject({ exitCode: 8, output: { error: { code: 'ownership_conflict' } } });
  expect(await state()).toEqual(['unknown']);
  h.resources.d1!.length = 0;

  const planned = await provision(options(h, { abandonIntent: intent.id, dryRun: true }));
  expect(planned.exitCode).toBe(0);
  expect(planned.output.checks).toContainEqual({ name: 'abandon_intent', status: intent.id });
  expect(await state()).toEqual(['unknown']);

  const unconfirmed = await provision(options(h, { abandonIntent: intent.id, yes: false }));
  expect(unconfirmed.output.error?.code).toBe('confirmation_required');
  expect(await state()).toEqual(['unknown']);
  expect(h.creates()).toBe(1);

  const abandoned = await provision(options(h, { abandonIntent: intent.id }));
  expect(abandoned.exitCode).toBe(0);
  expect(abandoned.output.checks).toContainEqual({ name: 'abandon_intent', status: intent.id });
  expect(h.creates()).toBe(5);
  const saved = await journal();
  expect(saved.operations.find((op) => op.id === intent.id)?.state).toBe('failed');
  expect(saved.operations.filter((op) => op.state === 'confirmed')).toHaveLength(4);
  expect((await provision(options(h))).exitCode).toBe(0);
  expect(h.creates()).toBe(5);
});

it('marks an intent failed only for a 4xx answer to the create itself', async () => {
  const h = harness();
  h.hook = (path, method) =>
    method === 'POST' && path === '/d1/database' ? new Response('', { status: 400 }) : undefined;
  expect((await provision(options(h))).exitCode).toBe(1);
  expect((await journal()).operations.map((op) => op.state)).toEqual(['failed']);
  h.hook = undefined;
  expect((await provision(options(h))).exitCode).toBe(0);
  expect(h.creates()).toBe(4);
});

it('keeps an intent unresolved when a 4xx follows a successful create', async () => {
  const h = harness();
  h.hook = (path, method) =>
    path === `/d1/database/${DB}` && method === 'GET'
      ? new Response('', { status: 403 })
      : undefined;
  expect((await provision(options(h))).exitCode).not.toBe(0);
  expect((await journal()).operations.map((op) => op.state)).toEqual(['unknown']);
  h.hook = undefined;
  expect((await provision(options(h))).exitCode).toBe(0);
  const saved = await journal();
  expect(saved.operations[0]?.state).toBe('confirmed');
  expect(saved.resources.d1?.evidence?.source).toBe('created');
  expect(h.creates()).toBe(4);
});

it('records the returned ID before a jurisdiction mismatch is raised', async () => {
  const h = harness();
  h.hook = (path, method) =>
    method === 'POST' && path === '/d1/database'
      ? ok({ uuid: DB, name: 'broker-production-db', jurisdiction: 'default' })
      : undefined;
  const result = await provision(options(h));
  expect(result).toMatchObject({
    exitCode: 8,
    output: { error: { code: 'jurisdiction_conflict' } },
  });
  expect((await journal()).operations[0]).toMatchObject({ state: 'unknown', resolved_id: DB });
});

it.each([[`d1:${DB}`], ['worker:broker-production'], [`queue:${'e'.repeat(32)}`]])(
  'refuses the unmatched adoption flag %s with exit 2 before any create',
  async (flag) => {
    const h = harness();
    const result = await provision(options(h, { adoptResource: [flag] }));
    expect(result).toMatchObject({ exitCode: 2, output: { error: { code: 'invalid_input' } } });
    expect(h.creates()).toBe(0);
    await expect(stat(statePath())).rejects.toMatchObject({ code: 'ENOENT' });
  },
);

it('tells the operator how to recover a held install lock', async () => {
  const h = harness();
  const store = await InventoryStore.create({ project, outDir: '.pb/cloudflare', identity });
  const transaction = await InventoryTransaction.begin(store, h.now());
  try {
    const result = await provision(options(h));
    expect(result).toMatchObject({ exitCode: 4, output: { error: { code: 'install_locked' } } });
    expect(result.output.error?.message).toMatch(/pid/);
    expect(result.output.error?.message).toMatch(/remove that one file/);
  } finally {
    await transaction.close();
  }
});

it('names a missing git work tree instead of an unsafe path', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'pb-no-git-'));
  const inside = project;
  try {
    project = outside;
    await build();
    const h = harness();
    const result = await provision(options(h));
    expect(result).toMatchObject({
      exitCode: 2,
      output: { error: { code: 'unsafe_path', message: expect.stringMatching(/git work tree/) } },
    });
    expect(h.trace).toEqual([]);
  } finally {
    project = inside;
    await rm(outside, { recursive: true, force: true });
  }
});

it.skipIf(process.getuid?.() === 0)(
  'maps a local state file failure to a state I/O code and releases the lock',
  async () => {
    const h = harness();
    expect((await provision(options(h))).exitCode).toBe(0);
    await chmod(statePath(), 0o000);
    try {
      const result = await provision(options(h));
      expect(result).toMatchObject({
        exitCode: 1,
        output: { error: { code: 'state_io_failure' } },
      });
      await expect(
        stat(join(project, '.pb/state/cloudflare/lock.broker.production.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await chmod(statePath(), 0o600);
    }
  },
);

it.each(['exists', 'gone'] as const)(
  'abandons an intent that holds a returned ID only if that exact ID is confirmed gone: %s',
  async (remote) => {
    const h = harness();
    h.hook = (path, method) =>
      method === 'POST' && path === '/r2/buckets'
        ? ok({ name: 'broker-production-blobs', jurisdiction: 'default' })
        : undefined;
    expect((await provision(options(h))).output.error?.code).toBe('jurisdiction_conflict');
    const intent = (await journal()).operations.find((op) => op.kind === 'r2')!;
    expect(intent).toMatchObject({ state: 'unknown', resolved_id: 'broker-production-blobs' });
    await h.sleep(60_000);
    h.hook =
      remote === 'exists'
        ? (path, method) =>
            method === 'GET' && path === '/r2/buckets/broker-production-blobs'
              ? ok({ name: 'broker-production-blobs', jurisdiction: 'default' })
              : undefined
        : undefined;
    const before = await readFile(statePath(), 'utf8');
    const result = await provision(options(h, { abandonIntent: intent.id }));
    if (remote === 'exists') {
      expect(result).toMatchObject({
        exitCode: 8,
        output: { error: { code: 'ownership_conflict' } },
      });
      expect(await readFile(statePath(), 'utf8')).toBe(before);
    } else expect(result.exitCode).toBe(0);
  },
);

it('rejects an unmatched Worker adoption flag before the confirmation prompt', async () => {
  const h = harness();
  const prompt = vi.fn(async () => 'yes');
  const result = await provision(
    options(h, {
      yes: false,
      interactive: true,
      prompt,
      adoptResource: ['worker:broker-production'],
    }),
  );
  expect(result).toMatchObject({ exitCode: 2, output: { error: { code: 'invalid_input' } } });
  expect(prompt).not.toHaveBeenCalled();
});

it('keeps the generic unsafe path message when git itself is unavailable', async () => {
  vi.stubEnv('PATH', '');
  try {
    const result = await provision(options(harness()));
    expect(result.output.error?.code).toBe('unsafe_path');
    expect(result.output.error?.message).not.toMatch(/git work tree/);
  } finally {
    vi.unstubAllEnvs();
  }
});

it('records the documented abort-only rule shape with an empty storage class list', async () => {
  const h = harness();
  h.hook = (path) =>
    path.endsWith('/lifecycle')
      ? ok({ rules: [{ ...DEFAULT_ABORT_RULE, storageClassTransitions: [] }] })
      : undefined;
  const result = await provision(options(h));
  expect(result.exitCode).toBe(0);
  expect((await journal()).resources.r2?.lifecycle_baseline).toEqual([DEFAULT_ABORT_RULE]);
  expect(result.output.checks).not.toContainEqual({
    name: 'lifecycle_baseline',
    status: 'unrecorded',
  });
});

it.each([
  'provider_failure',
  'unrecognised_rule',
  'non_empty_transitions',
  'delete_transition',
] as const)('still succeeds and reports an unrecorded lifecycle baseline on %s', async (kind) => {
  const h = harness();
  h.hook = (path) => {
    if (!path.endsWith('/lifecycle')) return undefined;
    if (kind === 'provider_failure') return new Response('', { status: 500 });
    const rule =
      kind === 'unrecognised_rule'
        ? { id: 'expire', enabled: true, conditions: { prefix: '' } }
        : kind === 'non_empty_transitions'
          ? {
              ...DEFAULT_ABORT_RULE,
              storageClassTransitions: [
                {
                  condition: { type: 'Age', maxAge: 60 },
                  storageClass: 'InfrequentAccess',
                },
              ],
            }
          : {
              ...DEFAULT_ABORT_RULE,
              deleteObjectsTransition: { condition: { type: 'Age', maxAge: 60 } },
            };
    return ok({ rules: [rule] });
  };
  const result = await provision(options(h));
  expect(result.exitCode).toBe(0);
  expect(result.output.error).toBeNull();
  expect(result.output.checks).toContainEqual({
    name: 'lifecycle_baseline',
    status: 'unrecorded',
  });
  expect((await journal()).resources.r2?.lifecycle_baseline).toBeUndefined();
});

it('records the provider-created R2 lifecycle baseline once and ignores non-abort rules', async () => {
  const h = harness();
  expect((await provision(options(h))).exitCode).toBe(0);
  expect((await journal()).resources.r2?.lifecycle_baseline).toEqual([DEFAULT_ABORT_RULE]);
  const lifecycleReads = () => h.trace.filter((t) => t.path.endsWith('/lifecycle')).length;
  const reads = lifecycleReads();
  expect((await provision(options(h))).exitCode).toBe(0);
  expect(lifecycleReads()).toBe(reads);
  const foreign = harness();
  foreign.hook = (path) =>
    path.endsWith('/lifecycle')
      ? ok({ rules: [{ id: 'expire', enabled: true, conditions: { prefix: '' } }] })
      : undefined;
  await rm(statePath(), { force: true });
  expect((await provision(options(foreign))).exitCode).toBe(0);
  expect((await journal()).resources.r2?.lifecycle_baseline).toBeUndefined();
});

it.each([false, true])('chains provision into teardown with lifecycle drift=%s', async (drift) => {
  const h = harness();
  expect((await provision(options(h))).exitCode).toBe(0);
  expect((await journal()).resources.r2!.lifecycle_baseline).toEqual([DEFAULT_ABORT_RULE]);
  const provider = h.fetch;
  const deleted: string[] = [];
  h.fetch = vi.fn(async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.split(ACCOUNT)[1]!;
    if (path.startsWith('/r2/buckets')) {
      const jurisdiction = new Headers(init?.headers).get('cf-r2-jurisdiction');
      expect(jurisdiction).toEqual(
        path === '/r2/buckets' ? expect.stringMatching(/^(?:eu|default|fedramp)$/) : 'eu',
      );
    }
    if (init?.method === 'DELETE') {
      deleted.push(path);
      const id = path.split('/').at(-1);
      for (const kind of ['d1', 'r2', 'queue'])
        h.resources[kind] = h.resources[kind]!.filter(
          (r) => (r.uuid ?? r.queue_id ?? r.name) !== id,
        );
      return ok(null);
    }
    if (path === '/workers/scripts') return ok([]);
    if (path === '/queues') return ok(h.resources.queue, { total_pages: 1 });
    if (path.endsWith('/consumers')) return ok([]);
    if (path.endsWith('/configuration')) return ok({ queues: [] });
    if (path.endsWith('/objects')) return ok([], { is_truncated: false });
    if (path.endsWith('/domains/custom')) return ok({ domains: [] });
    if (/\/(?:cors|lock)$/.test(path)) return ok({ rules: [] });
    if (/\/(?:domains\/managed|sippy)$/.test(path)) return ok({ enabled: false });
    if (drift && path.endsWith('/lifecycle'))
      return ok({ rules: [{ ...DEFAULT_ABORT_RULE, conditions: { prefix: 'foreign/' } }] });
    return provider(input, init);
  });
  const result = await teardown({
    project,
    inventory: statePath(),
    env,
    fetch: h.fetch,
    now: h.now,
    sleep: h.sleep,
    inventoryId: identity.owner_digest,
    iUnderstandThisDeletes: true,
  });
  expect(result.exitCode).toBe(drift ? 8 : 0);
  if (drift) expect(deleted).toEqual([]);
  else {
    expect(deleted).toHaveLength(4);
    expect(Object.values(h.resources).every((resources) => resources.length === 0)).toBe(true);
  }
});

const liveFixtures = JSON.parse(
  await readFile(new URL('./fixtures/provider-responses.json', import.meta.url), 'utf8'),
) as Record<string, Record<string, unknown>>;
const LIVE_DEFAULT_RULE = (liveFixtures.r2LifecycleDefault!.result as { rules: unknown[] })
  .rules[0] as Record<string, unknown>;

it('records the recorded live default rule with empty conditions as the normalized baseline', async () => {
  const h = harness();
  h.hook = (path) =>
    path.endsWith('/lifecycle')
      ? new Response(JSON.stringify(liveFixtures.r2LifecycleDefault))
      : undefined;
  const result = await provision(options(h));
  expect(result.exitCode).toBe(0);
  expect((await journal()).resources.r2?.lifecycle_baseline).toEqual([DEFAULT_ABORT_RULE]);
  expect(result.output.checks).not.toContainEqual({
    name: 'lifecycle_baseline',
    status: 'unrecorded',
  });
});

it.each([
  ['extra_condition', { prefix: '', suffix: '' }],
  ['other_condition', { suffix: '' }],
  ['numeric_prefix', { prefix: 0 }],
  ['null_conditions', null],
  ['array_conditions', []],
] as const)(
  'still reports an unrecorded baseline for live conditions %s',
  async (_kind, conditions) => {
    const h = harness();
    h.hook = (path) =>
      path.endsWith('/lifecycle')
        ? ok({ rules: [{ ...LIVE_DEFAULT_RULE, conditions }] })
        : undefined;
    const result = await provision(options(h));
    expect(result.exitCode).toBe(0);
    expect(result.output.checks).toContainEqual({
      name: 'lifecycle_baseline',
      status: 'unrecorded',
    });
    expect((await journal()).resources.r2?.lifecycle_baseline).toBeUndefined();
  },
);

it('chains provision into teardown when every lifecycle read returns the live default shape', async () => {
  const h = harness();
  const live = () => new Response(JSON.stringify(liveFixtures.r2LifecycleDefault));
  h.hook = (path) => (path.endsWith('/lifecycle') ? live() : undefined);
  expect((await provision(options(h))).exitCode).toBe(0);
  expect((await journal()).resources.r2!.lifecycle_baseline).toEqual([DEFAULT_ABORT_RULE]);
  const provider = h.fetch;
  const deleted: string[] = [];
  h.fetch = vi.fn(async (input, init) => {
    const path = new URL(String(input)).pathname.split(ACCOUNT)[1]!;
    if (init?.method === 'DELETE') {
      deleted.push(path);
      const id = path.split('/').at(-1);
      for (const kind of ['d1', 'r2', 'queue'])
        h.resources[kind] = h.resources[kind]!.filter(
          (r) => (r.uuid ?? r.queue_id ?? r.name) !== id,
        );
      return ok(null);
    }
    if (path === '/workers/scripts') return ok([]);
    if (path === '/queues') return ok(h.resources.queue, { total_pages: 1 });
    if (path.endsWith('/consumers')) return ok([]);
    if (path.endsWith('/configuration')) return ok({ queues: [] });
    if (path.endsWith('/objects')) return new Response(JSON.stringify(liveFixtures.r2ObjectsEmpty));
    if (path.endsWith('/domains/custom')) return ok({ domains: [] });
    if (/\/(?:cors|lock)$/.test(path)) return ok({ rules: [] });
    if (/\/(?:domains\/managed|sippy)$/.test(path)) return ok({ enabled: false });
    return provider(input, init);
  });
  const result = await teardown({
    project,
    inventory: statePath(),
    env,
    fetch: h.fetch,
    now: h.now,
    sleep: h.sleep,
    inventoryId: identity.owner_digest,
    iUnderstandThisDeletes: true,
  });
  expect(result.exitCode).toBe(0);
  expect(deleted).toHaveLength(4);
});

it.each([true, false, null])(
  'preserves dirty provenance in provision output (%s)',
  async (dirty) => {
    const file = join(project, '.pb/cloudflare/build-info.json');
    const info = JSON.parse(await readFile(file, 'utf8'));
    info.dirty = dirty;
    await writeFile(file, JSON.stringify(info));
    const result = await provision(options(harness(), { dryRun: true }));
    expect(result.exitCode).toBe(0);
    expect(result.output.build_info).toEqual(info);
  },
);

it('rejects invalid dirty provenance before provisioning requests', async () => {
  const file = join(project, '.pb/cloudflare/build-info.json');
  const info = JSON.parse(await readFile(file, 'utf8'));
  info.dirty = 'SENTINEL';
  await writeFile(file, JSON.stringify(info));
  const h = harness();
  const result = await provision(options(h));
  expect(result.output.error?.code).toBe('invalid_input');
  expect(h.trace).toHaveLength(0);
  expect(JSON.stringify(result)).not.toContain('SENTINEL');
});
