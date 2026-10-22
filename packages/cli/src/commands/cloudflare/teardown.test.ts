import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { run } from '../../cli.js';
import {
  emptyInventory,
  installIdentity,
  InventoryStore,
  type Inventory,
  type ManagedSettings,
} from './inventory.js';
import { janitor } from './janitor.js';
import { provision } from './provision.js';
import { teardown, type TeardownOptions } from './teardown.js';

const ACCOUNT = 'a'.repeat(32);
const TOKEN = 'token_SENTINEL';
const DB = '11111111-1111-4111-8111-111111111111';
const QUEUE = 'b'.repeat(32);
const env = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: TOKEN };
const project = resolve(import.meta.dirname, '../../../../..');
let directory: string;
let inventory: string;
let journal: Inventory;
let trace: { path: string; method: string; body: unknown }[];
let options: TeardownOptions;
const response = (result: unknown = null, status = 200) =>
  Response.json({ success: status < 400, result }, { status });
const listingResponse = (result: unknown) => pageResponse(result, { total_pages: 1 });
const snapshotResponse = (result: unknown) => response(result);

function ownedWorkerSettings(bindings: unknown[] = []) {
  return { bindings, tags: ['pb-install-v1', `pb-owner-${journal.identity.owner_digest}`] };
}

function attachmentResponse(path: string) {
  const settings = journal.deployment?.attempt.prior_settings;
  if (path.endsWith('/workers/domains'))
    return listingResponse(settings?.domain ? [settings.domain] : []);
  if (path.endsWith('/zones'))
    return listingResponse(settings?.routes.map((r) => ({ id: r.zone_id })) ?? []);
  if (path.endsWith('/workers/routes')) return response(settings?.routes ?? []);
  if (path.endsWith('/queues'))
    return listingResponse(
      [journal.resources.jobs, journal.resources.dlq]
        .filter((queue) => queue?.id)
        .map((queue) => ({ queue_id: queue!.id, queue_name: queue!.name })),
    );
  if (path.endsWith('/r2/buckets')) return listingResponse({ buckets: [] });
  if (path.endsWith('/configuration')) return response({ queues: [] });
  if (path.endsWith('/objects')) return pageResponse([], { is_truncated: false });
  if (path.endsWith('/domains/custom')) return response({ domains: [] });
  if (/\/(?:cors|lifecycle|lock)$/.test(path)) return response({ rules: [] });
  if (/\/(?:domains\/managed|sippy)$/.test(path)) return response({ enabled: false });
  if (path.endsWith('/workers/scripts')) return snapshotResponse([]);
  if (path.endsWith('/settings'))
    return response(journal.deployment ? ownedWorkerSettings() : { bindings: [], tags: [] });
  if (path.endsWith('/versions')) return listingResponse({ items: [] });
  if (path.endsWith('/secrets')) return response([]);
  if (path.endsWith('/subdomain'))
    return response(settings?.endpoints ?? { enabled: false, previews_enabled: false });
  if (path.endsWith('/schedules'))
    return response({ schedules: (settings?.schedules ?? []).map((cron) => ({ cron })) });
  if (path.includes('/workers/routes/'))
    return response(
      settings?.routes.find((route) => path.endsWith(`/${route.id}`)),
      200,
    );
  if (path.includes('/workers/domains/')) return response(settings?.domain);
  if (path.endsWith('/consumers')) {
    const consumer = settings?.consumer;
    if (!consumer || !path.endsWith(`/queues/${QUEUE}/consumers`)) return snapshotResponse([]);
    const { consumer_id, script_name, dead_letter_queue, ...consumerSettings } = consumer;
    return snapshotResponse([
      { consumer_id, type: 'worker', script_name, dead_letter_queue, settings: consumerSettings },
    ]);
  }
  return response();
}

function attachmentTrace() {
  return trace
    .filter(
      (entry) =>
        entry.method !== 'GET' ||
        /\/(?:schedules|consumers)(?:\?|$)|\/workers\/(?:routes|domains)\/[^/]+$/.test(entry.path),
    )
    .map((entry) => ({ ...entry, path: entry.path.replace(/\?page=1&per_page=100$/, '') }));
}

beforeEach(async () => {
  directory = join(project, '.pb/state/cloudflare', `t852-${randomUUID()}`);
  inventory = join(directory, 'inventory.test.json');
  await mkdir(directory, { recursive: true });
  journal = emptyInventory(
    installIdentity({
      accountId: ACCOUNT,
      workerName: 'pb-e2e-123-1792300000',
      runIdentity: 'pb-e2e-123-1792300000',
    }),
    1792300000000,
  );
  journal.resources.d1 = {
    name: `${journal.identity.script_name}-db`,
    id: DB,
    jurisdiction: 'eu',
    state: 'complete',
    evidence: { source: 'adopted', operation_id: null, verified_at: journal.updated_at },
  };
  trace = [];
  options = {
    project,
    inventory,
    env,
    iUnderstandThisDeletes: true,
    now: () => 1792400000000,
    sleep: async () => undefined,
    fetch: vi.fn(async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://api.cloudflare.com');
      expect(init?.redirect).toBe('manual');
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
      trace.push({
        path: url.pathname + url.search,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (init?.method === 'DELETE' && url.pathname.endsWith('/objects')) {
        const keys: unknown = init.body ? JSON.parse(String(init.body)) : null;
        if (
          !Array.isArray(keys) ||
          keys.length < 1 ||
          keys.length > 1000 ||
          keys.some((key) => typeof key !== 'string')
        )
          return response(null, 400);
        return response(keys.map((key) => ({ key })));
      }
      return init?.method === 'GET' ? attachmentResponse(url.pathname) : response();
    }),
  };
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});
async function save() {
  await writeFile(inventory, JSON.stringify(journal));
}

function createdDatabase() {
  const database = journal.resources.d1!;
  const id = 'create-db';
  database.evidence = { source: 'created', operation_id: id, verified_at: journal.updated_at };
  journal.operations.push({
    id,
    kind: 'd1',
    name: database.name,
    spec_sha256: 'e'.repeat(64),
    absence_observed_at: journal.updated_at,
    started_at: journal.updated_at,
    state: 'confirmed',
    resolved_id: database.id,
  });
}

it('deletes only recorded IDs after partial creation and repeated teardown reports already gone', async () => {
  journal.resources.jobs = {
    name: `${journal.identity.script_name}-jobs`,
    id: null,
    state: 'planned',
    evidence: null,
  };
  await save();
  expect((await teardown(options)).exitCode).toBe(0);
  expect(attachmentTrace()).toEqual([
    {
      path: `/client/v4/accounts/${ACCOUNT}/d1/database/${DB}?jurisdiction=eu`,
      method: 'DELETE',
      body: null,
    },
  ]);
  options.fetch = vi.fn(async () => response(null, 404));
  const again = await teardown(options);
  expect(again.exitCode).toBe(0);
  expect(again.output.checks).toContainEqual({ name: 'd1', status: 'already_gone' });
  expect(JSON.parse(await readFile(inventory, 'utf8'))).toEqual(journal);
});

it('does not discover or delete a prefix-matching resource without an inventoried ID', async () => {
  journal.resources = {
    jobs: {
      name: `${journal.identity.script_name}-jobs`,
      id: null,
      state: 'creating',
      evidence: null,
    },
  };
  await save();
  const result = await teardown(options);
  expect(result.exitCode).toBe(6);
  expect(trace).toEqual([]);
});

it('requires both destructive acknowledgement and the exact ownership digest for production', async () => {
  journal.identity = installIdentity({
    accountId: ACCOUNT,
    workerName: journal.identity.worker_name,
  });
  await save();
  for (const flags of [
    {},
    { iUnderstandThisDeletes: true },
    { inventoryId: journal.identity.owner_digest },
    { iUnderstandThisDeletes: true, inventoryId: 'wrong' },
  ]) {
    expect((await teardown({ ...options, iUnderstandThisDeletes: false, ...flags })).exitCode).toBe(
      2,
    );
  }
  expect(trace).toEqual([]);
  expect(
    (
      await teardown({
        ...options,
        iUnderstandThisDeletes: true,
        inventoryId: journal.identity.owner_digest,
      })
    ).exitCode,
  ).toBe(0);
});

it('drains every R2 page before deletion and redrains on a 409, backing off on 429', async () => {
  journal.resources = {
    r2: {
      name: `${journal.identity.script_name}-blobs`,
      id: `${journal.identity.script_name}-blobs`,
      jurisdiction: 'eu',
      state: 'complete',
      evidence: { source: 'adopted', operation_id: null, verified_at: journal.updated_at },
    },
  };
  await save();
  let lists = 0;
  let buckets = 0;
  const sleep = vi.fn(async () => undefined);
  const fetcher = options.fetch!;
  options.fetch = vi.fn(async (input, init) => {
    const fallback = await fetcher(input, init);
    const path = new URL(String(input)).pathname;
    if (!path.includes('/r2/buckets/')) return fallback;
    expect(new Headers(init?.headers).get('cf-r2-jurisdiction')).toBe('eu');
    if (path.endsWith('/objects') && init?.method === 'GET') {
      lists++;
      if (lists === 1) return new Response('', { status: 429, headers: { 'retry-after': '2' } });
      const truncated = lists === 2 || lists === 4;
      return pageResponse(
        truncated
          ? [{ key: 'private@example.test/a?token=SECRET' }]
          : lists === 3 || lists === 5
            ? [{ key: 'second' }]
            : lists === 6
              ? [{ key: 'raced' }]
              : [],
        { is_truncated: truncated, ...(truncated ? { cursor: 'next' } : {}) },
      );
    }
    if (init?.method === 'DELETE' && !path.endsWith('/objects'))
      return response(null, ++buckets === 1 ? 409 : 200);
    return fallback;
  });
  const result = await teardown({ ...options, sleep });
  expect(result.exitCode).toBe(0);
  expect(sleep).toHaveBeenCalledWith(2000);
  expect(
    trace.filter((x) => x.method === 'DELETE' && x.path.endsWith('/objects')).map((x) => x.body),
  ).toEqual([['private@example.test/a?token=SECRET'], ['second'], ['raced']]);
  const firstBucket = trace.findIndex((x) => x.method === 'DELETE' && !x.path.endsWith('/objects'));
  expect(trace.slice(0, firstBucket).filter((x) => x.method === 'DELETE')).toHaveLength(2);
  expect(JSON.stringify(result)).not.toMatch(/SECRET|private@example|token_SENTINEL/);
});

it('never treats malformed R2 pagination as an empty bucket', async () => {
  journal.resources.r2 = {
    name: `${journal.identity.script_name}-blobs`,
    id: `${journal.identity.script_name}-blobs`,
    jurisdiction: 'eu',
    state: 'complete',
    evidence: { source: 'adopted', operation_id: null, verified_at: journal.updated_at },
  };
  await save();
  const fetcher = options.fetch!;
  options.fetch = vi.fn(async (input, init) => {
    const fallback = await fetcher(input, init);
    return new URL(String(input)).pathname.endsWith('/objects')
      ? response({ objects: [] })
      : fallback;
  });
  expect((await teardown(options)).exitCode).toBe(1);
  expect(trace.every((entry) => entry.method === 'GET')).toBe(true);
  expect(trace.at(-1)?.path).toContain('/objects?per_page=100');
});

it('has a read-only dry run and refuses account mismatches and symlink inventories', async () => {
  await save();
  const dry = await teardown({ ...options, dryRun: true });
  expect(dry.exitCode).toBe(0);
  expect(dry.output.status).toBe('planned');
  expect(trace).toEqual([]);
  expect(
    (await teardown({ ...options, env: { ...env, CLOUDFLARE_ACCOUNT_ID: 'c'.repeat(32) } }))
      .exitCode,
  ).toBe(8);
  const linked = join(directory, 'linked.json');
  await symlink(inventory, linked);
  expect((await teardown({ ...options, inventory: linked })).exitCode).toBe(2);
  expect(trace).toEqual([]);
});

it('bounds 429 retries and redacts raw transport errors in JSON', async () => {
  await save();
  options.fetch = vi.fn(async () => response(null, 429));
  expect((await teardown(options)).exitCode).toBe(1);
  expect(options.fetch).toHaveBeenCalledTimes(5);
  options.fetch = vi.fn(async () => {
    throw new Error(`${TOKEN} private@example.test https://user:pass@example.test`);
  });
  const result = await teardown(options);
  expect(result.exitCode).not.toBe(0);
  expect(JSON.stringify(result)).not.toMatch(/SENTINEL|private@|user:pass/);
});

it('registers teardown and janitor with typed JSON usage errors and never dispatches setup', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  for (const args of [
    ['teardown', '--inventory', inventory, '--unknown'],
    ['janitor', '--repository-id'],
    ['teardown'],
  ]) {
    expect(await run(['cloudflare', ...args, '--json'])).toBe(2);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      schema_version: 1,
      status: 'error',
      error: { code: 'invalid_input', stage: args[0] },
    });
  }
  expect(await run(['cloudflare', 'setup', '--inventory', inventory])).toBe(2);
  expect(error).toHaveBeenCalled();
  expect(trace).toEqual([]);
});

async function saveAttachments() {
  const script = journal.identity.script_name;
  const evidence = {
    source: 'adopted' as const,
    operation_id: null,
    verified_at: journal.updated_at,
  };
  journal.resources.worker = { name: script, id: script, state: 'complete', evidence };
  journal.resources.jobs = { name: `${script}-jobs`, id: QUEUE, state: 'complete', evidence };
  journal.resources.dlq = {
    name: `${script}-jobs-dlq`,
    id: 'c'.repeat(32),
    state: 'complete',
    evidence,
  };
  const settings: ManagedSettings = {
    endpoints: { enabled: true, previews_enabled: false },
    schedules: ['* * * * *'],
    routes: [{ id: 'route-1', zone_id: 'd'.repeat(32), pattern: 'example.test/*', script }],
    domain: {
      id: 'domain-1',
      zone_id: 'd'.repeat(32),
      hostname: 'registry.example.test',
      service: script,
      environment: 'production',
    },
    consumer: {
      consumer_id: 'consumer-1',
      script_name: script,
      batch_size: 10,
      max_wait_time_ms: 100,
      max_retries: 3,
      max_concurrency: 1,
      dead_letter_queue: `${script}-jobs-dlq`,
    },
  };
  journal.deployment = {
    last_verified: null,
    attempt: {
      operation_id: 'deploy-1',
      artifact_sha256: 'a'.repeat(64),
      assets_sha256: null,
      settings_sha256: 'b'.repeat(64),
      secret_names: [],
      build_info: {
        schemaVersion: 1,
        target: 'cloudflare',
        core: '2.0.0',
        plugins: {},
        lockfileSha256: null,
        gitSha: null,
      },
      version_id: 'version-1',
      previous_version_id: null,
      previous_deployment_id: null,
      previous_distribution: [],
      requested_rollout: 100,
      worker_url: 'https://example.test',
      candidate_probe_url: null,
      migration_ledger_sha256: 'c'.repeat(64),
      rollback_compatible: true,
      contract_ids: [],
      phase: 'active',
      activated_at: journal.updated_at,
      smoke: 'pending',
      rollback: 'not_needed',
      preview: 'disabled',
      prior_settings: settings,
      intended_settings: settings,
      changes: [],
    },
  };
  await save();
}

it('removes only inventoried attachments before Worker, queues and data', async () => {
  await saveAttachments();
  const script = journal.identity.script_name;
  expect((await teardown(options)).exitCode).toBe(0);
  expect(
    attachmentTrace().map((x) => [x.method, x.path.replace(`/client/v4/accounts/${ACCOUNT}`, '')]),
  ).toEqual([
    ['GET', `/workers/scripts/${script}/schedules`],
    ['GET', `/client/v4/zones/${'d'.repeat(32)}/workers/routes/route-1`],
    ['GET', '/workers/domains/domain-1'],
    ['GET', `/queues/${QUEUE}/consumers`],
    ['GET', `/queues/${'c'.repeat(32)}/consumers`],
    ['DELETE', `/client/v4/zones/${'d'.repeat(32)}/workers/routes/route-1`],
    ['DELETE', '/workers/domains/domain-1'],
    ['DELETE', `/queues/${QUEUE}/consumers/consumer-1`],
    ['PUT', `/workers/scripts/${script}/schedules`],
    ['DELETE', `/workers/scripts/${script}`],
    ['DELETE', `/queues/${QUEUE}`],
    ['DELETE', `/queues/${'c'.repeat(32)}`],
    ['DELETE', `/d1/database/${DB}?jurisdiction=eu`],
  ]);
  expect(attachmentTrace()[8]?.body).toEqual([]);
});

it('uses only durable resolved IDs when a create response preceded the resource receipt', async () => {
  const resource = journal.resources.d1!;
  resource.id = null;
  resource.state = 'creating';
  resource.evidence = null;
  journal.operations = [
    {
      id: 'create-1',
      kind: 'd1',
      name: resource.name,
      spec_sha256: 'a'.repeat(64),
      absence_observed_at: journal.updated_at,
      started_at: journal.updated_at,
      state: 'pending',
      resolved_id: DB,
    },
  ];
  await save();
  expect((await teardown(options)).exitCode).toBe(0);
  expect(attachmentTrace()).toHaveLength(1);
  expect(attachmentTrace()[0]?.path).toContain(DB);
});

it.each(['pending', 'unknown'] as const)(
  'reports a newer %s create even when an abandoned operation retained a resolved ID',
  async (state) => {
    const resource = journal.resources.d1!;
    resource.id = null;
    resource.state = 'creating';
    resource.evidence = null;
    const operation = {
      kind: 'd1' as const,
      name: resource.name,
      spec_sha256: 'a'.repeat(64),
      absence_observed_at: journal.updated_at,
      started_at: journal.updated_at,
    };
    journal.operations = [
      { ...operation, id: 'abandoned', state: 'failed', resolved_id: DB },
      { ...operation, id: 'new-create', state, resolved_id: null },
    ];
    await save();
    const result = await teardown(options);
    expect(result.exitCode).toBe(6);
    expect(result.output.error?.code).toBe('outcome_unknown');
    expect(attachmentTrace().map((entry) => entry.path)).toEqual([
      `/client/v4/accounts/${ACCOUNT}/d1/database/${DB}?jurisdiction=eu`,
    ]);
  },
);

it.each([400, 403])('cleans up after a provision POST rejected with %s', async (status) => {
  const outDir = join(directory, '.pb/cloudflare');
  const statePath = join(directory, '.pb/state/cloudflare/inventory.test.json');
  await mkdir(join(outDir, 'generated'), { recursive: true });
  await writeFile(
    join(outDir, 'generated/manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      platform: 'cloudflare',
      platformPorts: null,
      bindings: [],
      plugins: [],
    }),
  );
  await writeFile(
    join(outDir, 'build-info.json'),
    JSON.stringify({
      schemaVersion: 1,
      target: 'cloudflare',
      core: '2.0.0',
      plugins: {},
      lockfileSha256: null,
      gitSha: null,
    }),
  );
  const fetcher = options.fetch!;
  options.fetch = vi.fn(async (input, init) => {
    await fetcher(input, init);
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/d1/database')) {
      if (init?.method === 'POST') return response(null, status);
      return Response.json({ success: true, result: [], result_info: { total_pages: 1 } });
    }
    if (path.includes('/workers/scripts/')) return response(null, 404);
    if (path.endsWith('/workers/subdomain')) return response({ subdomain: 'example' });
    if (path.endsWith('/subscriptions')) return listingResponse([]);
    throw new Error('Unexpected fake API request');
  });
  const rejected = await provision({
    workerName: journal.identity.worker_name,
    runIdentity: journal.identity.run_identity!,
    project: directory,
    inventory: statePath,
    outDir,
    env,
    fetch: options.fetch,
    now: options.now!,
    sleep: options.sleep!,
    yes: true,
  });
  expect(rejected.exitCode).toBe(1);
  expect(rejected.output.error?.code).toBe(
    status === 403 ? 'permission_denied' : 'provider_failure',
  );
  const saved = JSON.parse(await readFile(statePath, 'utf8')) as Inventory;
  expect(saved.operations).toEqual([
    expect.objectContaining({ state: 'failed', resolved_id: null }),
  ]);
  expect(saved.resources.d1).toMatchObject({ state: 'creating', id: null, evidence: null });
  expect(trace.filter((entry) => entry.method === 'POST')).toHaveLength(1);
  trace.length = 0;
  const result = await teardown({ ...options, project: directory, inventory: statePath, outDir });
  expect(result.exitCode).toBe(0);
  expect(result.output.status).toBe('ok');
  expect(result.output.plan).toEqual([]);
  expect(trace).toEqual([]);
});

async function prepareAttachmentIntent() {
  await saveAttachments();
  const attempt = journal.deployment!.attempt;
  attempt.phase = 'preparing_upload';
  attempt.version_id = null;
  attempt.activated_at = null;
  attempt.intended_settings = structuredClone(attempt.intended_settings);
  attempt.intended_settings.routes[0]!.id = null;
  attempt.intended_settings.domain!.id = null;
  attempt.intended_settings.consumer!.consumer_id = null;
  attempt.prior_settings = {
    endpoints: { enabled: false, previews_enabled: false },
    schedules: [],
    routes: [],
    domain: null,
    consumer: null,
  };
  return attempt;
}

it.each([false, true])(
  'ignores unmutated attachment intentions before upload (existing Worker: %s)',
  async (workerExists) => {
    await prepareAttachmentIntent();
    if (!workerExists) {
      journal.resources.worker!.id = null;
      journal.resources.worker!.state = 'planned';
      journal.resources.worker!.evidence = null;
    }
    await save();
    const result = await teardown(options);
    expect(result.exitCode).toBe(0);
    expect(result.output.plan.map((entry) => entry.kind)).toEqual([
      ...(workerExists ? ['worker'] : []),
      'jobs',
      'dlq',
      'd1',
    ]);
    expect(
      attachmentTrace()
        .filter((entry) => entry.method === 'GET')
        .map((entry) => entry.path),
    ).toEqual([
      ...(workerExists
        ? [
            `/client/v4/accounts/${ACCOUNT}/workers/scripts/${journal.identity.script_name}/schedules`,
          ]
        : []),
      `/client/v4/accounts/${ACCOUNT}/queues/${QUEUE}/consumers`,
      `/client/v4/accounts/${ACCOUNT}/queues/${'c'.repeat(32)}/consumers`,
    ]);
    expect(
      trace.filter((entry) => entry.method !== 'GET').every((entry) => entry.method === 'DELETE'),
    ).toBe(true);
  },
);

it('retains prior attachment receipts when an upload only has new intentions', async () => {
  await saveAttachments();
  const prior = structuredClone(journal.deployment!.attempt.prior_settings);
  const attempt = await prepareAttachmentIntent();
  attempt.prior_settings = prior;
  await save();
  const result = await teardown(options);
  expect(result.exitCode).toBe(0);
  expect(result.output.checks.map((check) => check.name)).toEqual([
    'route',
    'domain',
    'consumer',
    'schedules',
    'worker',
    'jobs',
    'dlq',
    'd1',
  ]);
});

it.each(['routes', 'domain', 'consumer'] as const)(
  'still reports an unresolved %s mutation without an attachment ID',
  async (kind) => {
    const attempt = await prepareAttachmentIntent();
    attempt.phase = 'configuring';
    attempt.changes = [{ kind, state: 'unknown', restoration: 'not_needed' }];
    await save();
    const result = await teardown(options);
    expect(result.exitCode).toBe(6);
    expect(result.output.error?.code).toBe('outcome_unknown');
  },
);

it.each(['upload_pending', 'uploaded', 'configuring', 'failed'] as const)(
  'deletes a first-install Worker from %s upload evidence before its backing resources',
  async (phase) => {
    const attempt = await prepareAttachmentIntent();
    attempt.phase = phase;
    attempt.version_id = 'version-1';
    attempt.intended_settings = structuredClone(attempt.prior_settings);
    delete journal.resources.worker;
    await save();
    const result = await teardown(options);
    expect(result.exitCode).toBe(0);
    expect(attachmentTrace().map((entry) => entry.path)).toEqual([
      `/client/v4/accounts/${ACCOUNT}/workers/scripts/${journal.identity.script_name}/schedules`,
      `/client/v4/accounts/${ACCOUNT}/queues/${QUEUE}/consumers`,
      `/client/v4/accounts/${ACCOUNT}/queues/${'c'.repeat(32)}/consumers`,
      `/client/v4/accounts/${ACCOUNT}/workers/scripts/${journal.identity.script_name}`,
      `/client/v4/accounts/${ACCOUNT}/queues/${QUEUE}`,
      `/client/v4/accounts/${ACCOUNT}/queues/${'c'.repeat(32)}`,
      `/client/v4/accounts/${ACCOUNT}/d1/database/${DB}?jurisdiction=eu`,
    ]);
    expect(result.output.checks[0]).toEqual({ name: 'worker', status: 'deleted' });
    options.fetch = vi.fn(async () => response(null, 404));
    const again = await teardown(options);
    expect(again.exitCode).toBe(0);
    expect(again.output.checks[0]).toEqual({ name: 'worker', status: 'already_gone' });
  },
);

it('retains backing resources when a first-install upload has no durable version ID', async () => {
  const attempt = await prepareAttachmentIntent();
  attempt.phase = 'upload_pending';
  delete journal.resources.worker;
  await save();
  const result = await teardown(options);
  expect(result.exitCode).toBe(6);
  expect(result.output.error?.code).toBe('outcome_unknown');
  expect(trace).toEqual([]);
});

it('retains backing resources when deletion of a journalled upload is refused', async () => {
  const attempt = await prepareAttachmentIntent();
  attempt.phase = 'uploaded';
  attempt.version_id = 'version-1';
  attempt.intended_settings = structuredClone(attempt.prior_settings);
  delete journal.resources.worker;
  await save();
  const fetcher = options.fetch!;
  options.fetch = vi.fn(async (input, init) => {
    const result = await fetcher(input, init);
    return init?.method === 'GET' ? result : response(null, 403);
  });
  expect((await teardown(options)).exitCode).toBe(1);
  expect(attachmentTrace().map((entry) => entry.path)).toEqual([
    `/client/v4/accounts/${ACCOUNT}/workers/scripts/${journal.identity.script_name}/schedules`,
    `/client/v4/accounts/${ACCOUNT}/queues/${QUEUE}/consumers`,
    `/client/v4/accounts/${ACCOUNT}/queues/${'c'.repeat(32)}/consumers`,
    `/client/v4/accounts/${ACCOUNT}/workers/scripts/${journal.identity.script_name}`,
  ]);
});

it.each(['routes', 'domain', 'consumer'] as const)(
  'resolves a null-ID %s intention after restoration confirmed prior absence',
  async (kind) => {
    const attempt = await prepareAttachmentIntent();
    attempt.phase = 'failed';
    attempt.changes = [{ kind, state: 'unknown', restoration: 'restored' }];
    await save();
    const result = await teardown(options);
    expect(result.exitCode).toBe(0);
    expect(result.output.checks.map((check) => check.name)).toEqual([
      'worker',
      'jobs',
      'dlq',
      'd1',
    ]);
    expect(attachmentTrace().map((entry) => entry.method)).toEqual([
      'GET',
      'GET',
      'GET',
      'DELETE',
      'DELETE',
      'DELETE',
      'DELETE',
    ]);
  },
);

it.each(
  (['DELETE', 'PUT'] as const).flatMap((method) =>
    ['null', '[]', '{}', '{"success":true,"result":'].map((body) => ({ method, body })),
  ),
)('reports an unresolved $method response for $body', async ({ method, body }) => {
  if (method === 'PUT') await saveAttachments();
  await save();
  const fetcher = options.fetch!;
  options.fetch = vi.fn(async (input, init) => {
    const result = await fetcher(input, init);
    if (init?.method === 'GET') return result;
    return init?.method === method ? new Response(body) : response();
  });
  const result = await teardown(options);
  expect(result.exitCode).toBe(6);
  expect(result.output.checks.some((check) => check.name === 'd1')).toBe(false);
  expect(trace.at(-1)?.method).toBe(method);
});

it.each([400, 403])(
  'preserves explicit mutation HTTP failure classification for %s',
  async (status) => {
    await save();
    const fetcher = options.fetch!;
    options.fetch = vi.fn(async (input, init) => {
      const fallback = await fetcher(input, init);
      return init?.method === 'GET' ? fallback : new Response('null', { status });
    });
    const result = await teardown(options);
    expect(result.exitCode).toBe(1);
    expect(result.output.error?.code).toBe(
      status === 403 ? 'permission_denied' : 'provider_failure',
    );
    expect(trace.filter((entry) => entry.method !== 'GET')).toEqual([
      {
        path: `/client/v4/accounts/${ACCOUNT}/d1/database/${DB}?jurisdiction=eu`,
        method: 'DELETE',
        body: null,
      },
    ]);
    expect(result.output.checks.some((check) => check.status === 'deleted')).toBe(false);
  },
);

it.each(['x', '\u0001'])(
  'drains full R2 pages of maximum-length keys with JSON escaping (%j)',
  async (character) => {
    const bucket = `${journal.identity.script_name}-blobs`;
    journal.resources = {
      r2: {
        name: bucket,
        id: bucket,
        jurisdiction: 'eu',
        state: 'complete',
        evidence: { source: 'adopted', operation_id: null, verified_at: journal.updated_at },
      },
    };
    const keys = Array.from({ length: 1000 }, (_, index) => `${index}`.padStart(1024, character));
    const fetcher = options.fetch!;
    options.fetch = vi.fn(async (input, init) => {
      const fallback = await fetcher(input, init);
      const url = new URL(String(input));
      if (init?.method !== 'GET' || !url.pathname.endsWith('/objects')) return fallback;
      const limit = Number(url.searchParams.get('per_page'));
      expect(limit).toBeGreaterThan(0);
      const start = Number(url.searchParams.get('cursor') ?? 0);
      const end = Math.min(start + limit, keys.length);
      return pageResponse(
        keys.slice(start, end).map((key) => ({
          key,
          size: 0,
          etag: 'a'.repeat(32),
          uploaded: journal.updated_at,
          checksums: { md5: 'a'.repeat(32) },
        })),
        { is_truncated: end < keys.length, cursor: String(end) },
      );
    });
    await save();
    const result = await teardown(options);
    expect(result.exitCode).toBe(0);
    const deleted = trace.filter((entry) => entry.method === 'DELETE');
    expect(deleted.slice(0, -1).flatMap((entry) => entry.body as string[])).toEqual(keys);
    expect(deleted.at(-1)?.path).toBe(`/client/v4/accounts/${ACCOUNT}/r2/buckets/${bucket}`);
    expect(deleted.at(-1)?.body).toBeNull();
    expect(result.output.checks).toContainEqual({ name: 'r2', status: 'deleted' });
  },
);

it('respects the shared inventory lock and releases its own lock on provider failure', async () => {
  await save();
  const store = await InventoryStore.create({
    project,
    inventory,
    outDir: '.pb/cloudflare',
    identity: journal.identity,
  });
  const release = await store.lock(options.now!());
  try {
    expect((await teardown(options)).exitCode).toBe(4);
  } finally {
    await release();
  }
  expect(trace).toEqual([]);
  options.fetch = vi.fn(async () => response(null, 403));
  expect((await teardown(options)).exitCode).toBe(1);
  const unlocked = await store.lock(options.now!());
  await unlocked();
});

it('dispatches both commands through the CLI with one JSON envelope and safe errors', async () => {
  createdDatabase();
  await save();
  vi.spyOn(Date, 'now').mockImplementation(options.now!);
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubEnv('CLOUDFLARE_API_TOKEN', TOKEN);
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', ACCOUNT);
  vi.stubGlobal('fetch', options.fetch);
  for (const args of [
    ['teardown', '--inventory', inventory],
    ['janitor', '--inventory', inventory, '--repository-id', '123'],
  ]) {
    log.mockClear();
    expect(await run(['cloudflare', ...args, '--project', project, '--json'])).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      command: args[0],
      status: 'ok',
    });
  }
  expect(error).not.toHaveBeenCalled();
  expect(attachmentTrace()).toHaveLength(2);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      if (init?.method === 'GET') return attachmentResponse(new URL(String(input)).pathname);
      throw new Error(`${TOKEN} person@example.test https://user:pass@example.test`);
    }),
  );
  expect(
    await run(['cloudflare', 'teardown', '--inventory', inventory, '--project', project, '--json']),
  ).toBe(6);
  expect(String(log.mock.calls.at(-1)?.[0])).not.toMatch(/SENTINEL|person@|user:pass/);
});

it('refuses to replace a cron list containing an unrecorded schedule', async () => {
  await saveAttachments();
  const fetcher = options.fetch!;
  options.fetch = vi.fn(async (input, init) => {
    const fallback = await fetcher(input, init);
    return new URL(String(input)).pathname.endsWith('/schedules')
      ? response({ schedules: [{ cron: '* * * * *' }, { cron: '0 * * * *' }] })
      : fallback;
  });
  const result = await teardown(options);
  expect(result.exitCode).toBe(8);
  expect(attachmentTrace().map((x) => x.method)).toEqual(['GET']);
});

it('refuses an exact inventoried route ID reassigned to another Worker before any mutation', async () => {
  await saveAttachments();
  const route = journal.deployment!.attempt.prior_settings.routes[0]!;
  const fetcher = options.fetch!;
  let deleted = false;
  options.fetch = vi.fn(async (input, init) => {
    const fallback = await fetcher(input, init);
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/schedules')) return response({ schedules: [{ cron: '* * * * *' }] });
    if (path.endsWith(`/routes/${route.id}`)) {
      if (init?.method === 'DELETE') deleted = true;
      return response({ ...route, script: 'another-worker' });
    }
    return fallback;
  });
  const result = await teardown(options);
  expect(result.exitCode).toBe(8);
  expect(result.output.error?.code).toBe('ownership_conflict');
  expect(deleted).toBe(false);
  expect(trace).toContainEqual({
    path: `/client/v4/zones/${route.zone_id}/workers/routes/${route.id}`,
    method: 'GET',
    body: null,
  });
  expect(trace.every((entry) => entry.method === 'GET')).toBe(true);
});

it('refuses unrecorded live cron on an adopted Worker without a deployment journal', async () => {
  const script = journal.identity.script_name;
  journal.resources.worker = {
    name: script,
    id: script,
    state: 'complete',
    evidence: { source: 'adopted', operation_id: null, verified_at: journal.updated_at },
  };
  await save();
  const fetcher = options.fetch!;
  let workerDeleted = false;
  options.fetch = vi.fn(async (input, init) => {
    await fetcher(input, init);
    if (init?.method === 'DELETE') workerDeleted = true;
    return response({ schedules: [{ cron: '0 * * * *' }] });
  });
  const result = await teardown(options);
  expect(result.exitCode).toBe(8);
  expect(result.output.error?.code).toBe('ownership_conflict');
  expect(workerDeleted).toBe(false);
  expect(attachmentTrace()).toEqual([
    {
      path: `/client/v4/accounts/${ACCOUNT}/workers/scripts/${script}/schedules`,
      method: 'GET',
      body: null,
    },
  ]);
});

it.each(['empty', 'gone'] as const)(
  'deletes an adopted Worker with no schedule receipt when live schedules are %s',
  async (state) => {
    const script = journal.identity.script_name;
    journal.resources.worker = {
      name: script,
      id: script,
      state: 'complete',
      evidence: { source: 'adopted', operation_id: null, verified_at: journal.updated_at },
    };
    await save();
    const fetcher = options.fetch!;
    options.fetch = vi.fn(async (input, init) => {
      const result = await fetcher(input, init);
      return new URL(String(input)).pathname.endsWith('/schedules') &&
        init?.method === 'GET' &&
        state === 'gone'
        ? response(null, 404)
        : result;
    });
    const result = await teardown(options);
    expect(result.exitCode).toBe(0);
    expect(attachmentTrace().map((entry) => [entry.method, entry.path])).toEqual([
      ['GET', `/client/v4/accounts/${ACCOUNT}/workers/scripts/${script}/schedules`],
      ['DELETE', `/client/v4/accounts/${ACCOUNT}/workers/scripts/${script}`],
      ['DELETE', `/client/v4/accounts/${ACCOUNT}/d1/database/${DB}?jurisdiction=eu`],
    ]);
  },
);

it.each([
  { resource: 'route', drift: { pattern: 'another.example.test/*' } },
  { resource: 'domain', drift: { service: 'another-worker' } },
  { resource: 'domain', drift: { environment: 'staging' } },
  { resource: 'domain', drift: { hostname: 'another.example.test' } },
  { resource: 'consumer', drift: { script_name: 'another-worker' } },
  { resource: 'consumer', drift: { consumer_id: 'unrecorded-consumer' } },
  { resource: 'consumer', drift: { dead_letter_queue: 'another-dlq' } },
  { resource: 'consumer', drift: { settings: { batch_size: 99 } } },
])('refuses $resource live drift $drift before any mutation', async ({ resource, drift }) => {
  await saveAttachments();
  const fetcher = options.fetch!;
  options.fetch = vi.fn(async (input, init) => {
    const result = await fetcher(input, init);
    const path = new URL(String(input)).pathname;
    if (init?.method !== 'GET') return result;
    if (
      (resource === 'route' && path.endsWith('/routes/route-1')) ||
      (resource === 'domain' && path.endsWith('/domains/domain-1'))
    ) {
      const body = (await result.json()) as { result: Record<string, unknown> };
      return response({ ...body.result, ...drift });
    }
    if (resource === 'consumer' && path.endsWith(`/queues/${QUEUE}/consumers`)) {
      const body = (await result.json()) as { result: Record<string, unknown>[] };
      return snapshotResponse(body.result.map((consumer) => ({ ...consumer, ...drift })));
    }
    return result;
  });
  const result = await teardown(options);
  expect(result.exitCode).toBe(8);
  expect(result.output.error?.code).toBe('ownership_conflict');
  expect(trace.length).toBeGreaterThan(0);
  expect(trace.every((entry) => entry.method === 'GET')).toBe(true);
  expect(result.output.checks).toEqual([]);
});

it.each(['jobs', 'dlq'] as const)(
  'refuses an unrecorded consumer implied by deleting an adopted %s queue',
  async (kind) => {
    journal.resources[kind] = {
      name: `${journal.identity.script_name}-${kind === 'jobs' ? 'jobs' : 'jobs-dlq'}`,
      id: QUEUE,
      state: 'complete',
      evidence: { source: 'adopted', operation_id: null, verified_at: journal.updated_at },
    };
    await save();
    const fetcher = options.fetch!;
    options.fetch = vi.fn(async (input, init) => {
      const result = await fetcher(input, init);
      return init?.method === 'GET'
        ? snapshotResponse([
            {
              consumer_id: 'unrecorded-consumer',
              type: 'worker',
              script_name: journal.identity.script_name,
            },
          ])
        : result;
    });
    const result = await teardown(options);
    expect(result.exitCode).toBe(8);
    expect(result.output.error?.code).toBe('ownership_conflict');
    expect(attachmentTrace()).toEqual([
      {
        path: `/client/v4/accounts/${ACCOUNT}/queues/${QUEUE}/consumers`,
        method: 'GET',
        body: null,
      },
    ]);
  },
);

it.each(['route', 'domain', 'consumer', 'schedules'] as const)(
  'reports an absent inventoried %s without sending its mutation',
  async (kind) => {
    await saveAttachments();
    const fetcher = options.fetch!;
    options.fetch = vi.fn(async (input, init) => {
      const result = await fetcher(input, init);
      const path = new URL(String(input)).pathname;
      if (init?.method !== 'GET') return result;
      if (
        (kind === 'route' && path.endsWith('/routes/route-1')) ||
        (kind === 'domain' && path.endsWith('/domains/domain-1')) ||
        (kind === 'schedules' && path.endsWith('/schedules'))
      )
        return response(null, 404);
      if (kind === 'consumer' && path.endsWith(`/queues/${QUEUE}/consumers`))
        return snapshotResponse([]);
      return result;
    });
    const result = await teardown(options);
    expect(result.exitCode).toBe(0);
    expect(result.output.checks).toContainEqual({ name: kind, status: 'already_gone' });
    expect(result.output.checks).toContainEqual({ name: 'worker', status: 'deleted' });
    const suffix = {
      route: '/routes/route-1',
      domain: '/domains/domain-1',
      consumer: '/consumers/consumer-1',
      schedules: '/schedules',
    }[kind];
    expect(
      trace.filter((entry) => entry.path.endsWith(suffix)).map((entry) => entry.method),
    ).toEqual(kind === 'consumer' ? [] : ['GET']);
  },
);

it('does not report a bucket gone merely because object listing returns 404', async () => {
  journal.resources = {
    r2: {
      name: `${journal.identity.script_name}-blobs`,
      id: `${journal.identity.script_name}-blobs`,
      jurisdiction: 'eu',
      state: 'complete',
      evidence: { source: 'adopted', operation_id: null, verified_at: journal.updated_at },
    },
  };
  await save();
  const fetcher = options.fetch!;
  options.fetch = vi.fn(async (input, init) => {
    const fallback = await fetcher(input, init);
    return new URL(String(input)).pathname.endsWith('/objects') ? response(null, 404) : fallback;
  });
  const result = await teardown(options);
  expect(result.exitCode).not.toBe(0);
  expect(trace.every((entry) => entry.method === 'GET')).toBe(true);
  expect(trace.slice(-2).map((entry) => entry.path.split('?')[0]!.split('/').at(-1))).toEqual([
    'objects',
    journal.resources.r2!.id,
  ]);
  options.fetch = vi.fn(async () => response(null, 404));
  const gone = await teardown(options);
  expect(gone.exitCode).toBe(0);
  expect(gone.output.checks).toContainEqual({ name: 'r2', status: 'already_gone' });
});

it('returns usage errors for missing and malformed inventories without touching the API', async () => {
  expect((await teardown(options)).exitCode).toBe(2);
  for (const raw of [null, [], { identity: null }, '{']) {
    await writeFile(inventory, typeof raw === 'string' ? raw : JSON.stringify(raw));
    const result = await teardown(options);
    expect(result.exitCode).toBe(2);
    expect(result.output.error?.code).toBe('invalid_inventory');
  }
  expect(trace).toEqual([]);
});

function interceptRead(
  handler: (url: URL, fallback: Response, init?: RequestInit) => Promise<Response>,
) {
  const fetcher = options.fetch!;
  options.fetch = vi.fn(async (input, init) => {
    const fallback = await fetcher(input, init);
    return init?.method === 'GET' ? handler(new URL(String(input)), fallback, init) : fallback;
  });
}

function pageResponse(result: unknown, info: Record<string, unknown>) {
  return Response.json({ success: true, result, result_info: info });
}

async function expectOwnershipConflict() {
  const result = await teardown(options);
  expect(result.exitCode).toBe(8);
  expect(result.output.error?.code).toBe('ownership_conflict');
  expect(result.output.checks).toEqual([]);
  expect(trace.length).toBeGreaterThan(0);
  expect(trace.every((entry) => entry.method === 'GET')).toBe(true);
}

it.each(['missing', 'empty', 'install_only', 'owner_only', 'foreign', 'changed'] as const)(
  'refuses a broker-deployed replacement Worker with %s ownership tags before mutation',
  async (kind) => {
    await saveAttachments();
    let reads = 0;
    interceptRead(async (url, fallback) => {
      if (!url.pathname.endsWith(`/workers/scripts/${journal.identity.script_name}/settings`))
        return fallback;
      reads++;
      const owned = ['pb-install-v1', `pb-owner-${journal.identity.owner_digest}`];
      const tags =
        kind === 'foreign'
          ? ['pb-install-v1', `pb-owner-${'f'.repeat(64)}`]
          : kind === 'install_only'
            ? owned.slice(0, 1)
            : kind === 'owner_only'
              ? owned.slice(1)
              : kind === 'changed' && reads === 1
                ? owned
                : [];
      return response({ bindings: [], ...(kind === 'missing' ? {} : { tags }) });
    });
    const result = await teardown(options);
    expect(result.exitCode).toBe(8);
    expect(result.output.error?.code).toBe('ownership_conflict');
    expect(result.output.error?.message).toContain('ownership');
    expect(result.output.checks).toEqual([]);
    expect(trace.every((entry) => entry.method === 'GET')).toBe(true);
    expect(reads).toBe(kind === 'changed' ? 2 : 1);
  },
);

it.each([false, true])(
  'closes HTTP entry points before draining R2 with Worker deletion refused=%s',
  async (refused) => {
    await saveAttachments();
    const name = await provisionedBucket();
    const attached = new Set(['worker', 'route', 'domain']);
    const fetcher = options.fetch!;
    let drained = false;
    options.fetch = vi.fn(async (input, init) => {
      const path = new URL(String(input)).pathname;
      const fallback = await fetcher(input, init);
      if (path.endsWith('/settings'))
        return response({
          bindings: [],
          tags: ['pb-install-v1', `pb-owner-${journal.identity.owner_digest}`],
        });
      if (init?.method === 'DELETE') {
        if (path.endsWith(`/workers/scripts/${journal.identity.script_name}`)) {
          if (refused) return response(null, 403);
          attached.delete('worker');
        }
        if (path.endsWith('/workers/routes/route-1')) attached.delete('route');
        if (path.endsWith('/workers/domains/domain-1')) attached.delete('domain');
        if (path.endsWith('/objects')) drained = true;
      }
      if (init?.method === 'GET' && path.endsWith(`/r2/buckets/${name}/objects`)) {
        if (!trace.some((entry) => entry.method !== 'GET'))
          return pageResponse([{ key: 'live-http-object' }], { is_truncated: false });
        if (attached.size) return response(null, 409);
        return pageResponse([{ key: 'live-http-object' }], { is_truncated: false });
      }
      return fallback;
    });
    const result = await teardown(options);
    expect(result.exitCode).toBe(refused ? 1 : 0);
    expect(drained).toBe(!refused);
    if (refused) {
      expect(result.output.error?.code).toBe('permission_denied');
      expect(trace.some((entry) => entry.method !== 'GET' && entry.path.includes('/r2/'))).toBe(
        false,
      );
    } else expect(attached.size).toBe(0);
  },
);

async function adoptedWorker() {
  const script = journal.identity.script_name;
  journal.resources.worker = {
    name: script,
    id: script,
    state: 'complete',
    evidence: { source: 'adopted', operation_id: null, verified_at: journal.updated_at },
  };
  await save();
}

async function adoptedBucket() {
  const name = `${journal.identity.script_name}-blobs`;
  journal.resources.r2 = {
    name,
    id: name,
    state: 'complete',
    jurisdiction: 'eu',
    evidence: { source: 'adopted', operation_id: null, verified_at: journal.updated_at },
  };
  await save();
  return name;
}

it.each([1, 2])(
  'refuses an unrecorded custom domain on page %s for an adopted Worker with no journal',
  async (page) => {
    await adoptedWorker();
    expect(journal.deployment).toBeNull();
    interceptRead(async (url, fallback) => {
      if (!url.pathname.endsWith('/workers/domains')) return fallback;
      const current = Number(url.searchParams.get('page'));
      return pageResponse(
        current === page
          ? [
              {
                id: 'unrecorded-domain',
                hostname: 'other.example.test',
                zone_id: 'd'.repeat(32),
                service: journal.identity.script_name,
                environment: 'production',
              },
            ]
          : [],
        { total_pages: page },
      );
    });
    await expectOwnershipConflict();
    expect(
      trace.some((entry) => entry.path.endsWith(`/workers/domains?page=${page}&per_page=100`)),
    ).toBe(true);
  },
);

it('refuses an unrecorded consumer beside an inventoried consumer in the documented snapshot', async () => {
  await saveAttachments();
  interceptRead(async (url, fallback) => {
    if (!url.pathname.endsWith(`/queues/${QUEUE}/consumers`)) return fallback;
    const result = ((await fallback.json()) as { result: unknown[] }).result;
    return snapshotResponse([
      ...result,
      { consumer_id: 'unrecorded-consumer', type: 'worker', script_name: 'another-worker' },
    ]);
  });
  await expectOwnershipConflict();
  expect(
    trace
      .filter((entry) => entry.path.includes(`/queues/${QUEUE}/consumers`))
      .map((entry) => entry.path),
  ).toEqual([`/client/v4/accounts/${ACCOUNT}/queues/${QUEUE}/consumers`]);
});

it('reads the consumer and Worker script collections without pagination parameters', async () => {
  await saveAttachments();
  expect((await teardown(options)).exitCode).toBe(0);
  const reads = trace
    .filter((entry) => entry.method === 'GET')
    .map((entry) => entry.path)
    .filter((path) => /\/consumers|\/workers\/scripts(\?|$)/.test(path));
  expect(reads.length).toBeGreaterThan(0);
  expect(reads.every((path) => !path.includes('?'))).toBe(true);
});

it('refuses a terminal first-page cursor with an inconsistent total', async () => {
  await saveAttachments();
  interceptRead(async (url, fallback) =>
    url.pathname.endsWith(`/queues/${QUEUE}/consumers`)
      ? pageResponse(((await fallback.json()) as { result: unknown }).result, {
          cursor: '',
          total_count: 2,
        })
      : fallback,
  );
  await expectOwnershipConflict();
});

it.each(['partial', 'loop', 'invalid', '404'] as const)(
  'refuses %s consumer pagination before any mutation',
  async (pagination) => {
    await saveAttachments();
    interceptRead(async (url, fallback) => {
      if (!url.pathname.endsWith(`/queues/${QUEUE}/consumers`)) return fallback;
      const result = ((await fallback.json()) as { result: unknown[] }).result;
      if (pagination === '404') return response(null, 404);
      if (pagination === 'partial') return pageResponse(result, { total_pages: 2 });
      return pageResponse(
        result,
        pagination === 'loop' ? { cursor: 'repeat' } : { total_pages: -1 },
      );
    });
    await expectOwnershipConflict();
  },
);

it.each(['domains', 'zones', 'queues', 'versions'] as const)(
  'discovers unrecorded implicit attachments on later %s pages',
  async (kind) => {
    await saveAttachments();
    const script = journal.identity.script_name;
    const zone = 'e'.repeat(32);
    const foreignQueue = '1'.repeat(32);
    const path = {
      domains: '/workers/domains',
      zones: '/zones',
      queues: '/queues',
      versions: `/workers/scripts/${script}/versions`,
    }[kind];
    interceptRead(async (url, fallback) => {
      if (url.pathname.endsWith(path)) {
        const foreign = {
          domains: { id: 'foreign-domain', service: script },
          zones: { id: zone },
          queues: { queue_id: foreignQueue, queue_name: 'foreign-queue' },
          versions: { id: 'foreign-version' },
        }[kind];
        const first = url.searchParams.get('page') === '1';
        const original = ((await fallback.json()) as { result: unknown }).result;
        const records = first
          ? kind === 'versions'
            ? (original as { items: unknown[] }).items
            : original
          : [foreign];
        return pageResponse(kind === 'versions' ? { items: records } : records, { total_pages: 2 });
      }
      if (url.pathname.endsWith(`/zones/${zone}/workers/routes`))
        return response([{ id: 'foreign-route', script, pattern: 'other.test/*' }]);
      if (url.pathname.endsWith(`/queues/${foreignQueue}/consumers`))
        return snapshotResponse([
          { consumer_id: 'foreign-consumer', script_name: script, type: 'worker' },
        ]);
      if (url.pathname.endsWith('/workers/scripts/foreign-worker/settings'))
        return response({ bindings: [{ type: 'd1', name: 'DB', id: DB }] });
      return fallback;
    });
    await expectOwnershipConflict();
    expect(
      trace.some((entry) =>
        entry.path.endsWith(
          `${path}?${kind === 'zones' ? `account.id=${ACCOUNT}&` : ''}page=2&per_page=100`,
        ),
      ),
    ).toBe(true);
  },
);

it('refuses a consumer on an external queue that sends failures to an inventoried DLQ', async () => {
  await saveAttachments();
  const foreignQueue = '1'.repeat(32);
  interceptRead(async (url, fallback) => {
    if (url.pathname.endsWith('/queues')) return listingResponse([{ queue_id: foreignQueue }]);
    if (url.pathname.endsWith(`/queues/${foreignQueue}/consumers`))
      return snapshotResponse([
        {
          consumer_id: 'foreign',
          script_name: 'another-worker',
          type: 'worker',
          dead_letter_queue: journal.resources.dlq!.name,
        },
      ]);
    return fallback;
  });
  await expectOwnershipConflict();
});

it.each(['d1', 'queue', 'r2_bucket', 'service'] as const)(
  'refuses an external inactive Worker version with an orphaned %s binding',
  async (type) => {
    await saveAttachments();
    await adoptedBucket();
    const binding = {
      d1: { type, id: DB },
      queue: { type, queue_name: journal.resources.jobs!.name },
      r2_bucket: { type, bucket_name: journal.resources.r2!.name, jurisdiction: 'eu' },
      service: { type, service: journal.identity.script_name },
    }[type];
    interceptRead(async (url, fallback) => {
      if (url.pathname.endsWith('/workers/scripts')) return snapshotResponse([{ id: 'external' }]);
      if (url.pathname.endsWith('/workers/scripts/external/versions'))
        return listingResponse({ items: [{ id: 'inactive' }] });
      if (url.pathname.endsWith('/workers/scripts/external/versions/inactive'))
        return response({ resources: { bindings: [binding] } });
      return fallback;
    });
    await expectOwnershipConflict();
  },
);

it.each(['current', 'inactive'] as const)(
  'refuses an unrecorded binding in the selected Worker’s %s settings',
  async (state) => {
    await saveAttachments();
    const script = journal.identity.script_name;
    interceptRead(async (url, fallback) => {
      if (state === 'current' && url.pathname.endsWith(`/workers/scripts/${script}/settings`))
        return response(ownedWorkerSettings([{ type: 'd1', name: 'FOREIGN', id: 'foreign-db' }]));
      if (state === 'inactive' && url.pathname.endsWith(`/workers/scripts/${script}/versions`))
        return listingResponse({ items: [{ id: 'version-1' }] });
      if (url.pathname.endsWith(`/versions/version-1`))
        return response({
          resources: {
            bindings: [{ type: 'kv_namespace', name: 'FOREIGN', namespace_id: 'unrecorded' }],
          },
        });
      return fallback;
    });
    await expectOwnershipConflict();
  },
);

it('permits inventoried resource bindings and versions after reading them live', async () => {
  await saveAttachments();
  const script = journal.identity.script_name;
  const bindings = [
    { type: 'd1', name: 'DB', id: DB },
    { type: 'queue', name: 'JOBS', queue_name: journal.resources.jobs!.name },
  ];
  interceptRead(async (url, fallback) => {
    if (url.pathname.endsWith(`/workers/scripts/${script}/settings`))
      return response(ownedWorkerSettings(bindings));
    if (url.pathname.endsWith(`/workers/scripts/${script}/versions`))
      return listingResponse({ items: [{ id: 'version-1' }] });
    if (url.pathname.endsWith('/versions/version-1')) return response({ resources: { bindings } });
    return fallback;
  });
  expect((await teardown(options)).exitCode).toBe(0);
  expect(
    trace.some((entry) => entry.path.endsWith('/versions/version-1') && entry.method === 'GET'),
  ).toBe(true);
});

it.each(['bucket', 'queue', 'later_bucket_page', 'incomplete_notification_snapshot'] as const)(
  'refuses an unrecorded R2 event notification affecting the selected %s',
  async (kind) => {
    await saveAttachments();
    const bucket = kind === 'bucket' ? await adoptedBucket() : 'external-bucket';
    interceptRead(async (url, fallback, init) => {
      if (url.pathname.endsWith('/r2/buckets')) {
        if (new Headers(init?.headers).get('cf-r2-jurisdiction') !== 'eu') return fallback;
        const first = url.searchParams.get('page') === '1';
        return pageResponse(
          { buckets: kind === 'later_bucket_page' && first ? [] : [{ name: bucket }] },
          { total_pages: kind === 'later_bucket_page' ? 2 : 1 },
        );
      }
      if (url.pathname.endsWith(`/event_notifications/r2/${bucket}/configuration`)) {
        return pageResponse(
          {
            queues:
              kind === 'incomplete_notification_snapshot'
                ? []
                : [
                    {
                      queueId: kind === 'bucket' ? '9'.repeat(32) : QUEUE,
                      rules: [{ ruleId: 'foreign-notification' }],
                    },
                  ],
          },
          { total_pages: kind === 'incomplete_notification_snapshot' ? 2 : 1 },
        );
      }
      return fallback;
    });
    await expectOwnershipConflict();
  },
);

it.each(['domains/custom', 'cors', 'lifecycle', 'lock', 'domains/managed', 'sippy'] as const)(
  'refuses unrecorded R2 %s configuration before draining any object',
  async (suffix) => {
    const name = await adoptedBucket();
    interceptRead(async (url, fallback) => {
      if (!url.pathname.endsWith(`/r2/buckets/${name}/${suffix}`)) return fallback;
      return response(
        suffix === 'domains/custom'
          ? { domains: [{ domain: 'external.test' }] }
          : ['domains/managed', 'sippy'].includes(suffix)
            ? { enabled: true }
            : { rules: [{ id: 'foreign-rule' }] },
      );
    });
    await expectOwnershipConflict();
    expect(trace.some((entry) => entry.path.includes('/objects'))).toBe(false);
  },
);

it('discovers a foreign Worker bound to an inventoried resource in the scripts snapshot', async () => {
  await saveAttachments();
  interceptRead(async (url, fallback) => {
    if (url.pathname.endsWith('/workers/scripts'))
      return snapshotResponse([{ id: 'foreign-worker' }]);
    if (url.pathname.endsWith('/workers/scripts/foreign-worker/settings'))
      return response({ bindings: [{ type: 'd1', name: 'DB', id: DB }] });
    return fallback;
  });
  await expectOwnershipConflict();
});

it.each(['scripts', 'consumers'] as const)(
  'refuses a %s snapshot that claims more pages than it returned',
  async (kind) => {
    await saveAttachments();
    interceptRead(async (url, fallback) => {
      const target =
        kind === 'scripts'
          ? url.pathname.endsWith('/workers/scripts')
          : url.pathname.endsWith(`/queues/${QUEUE}/consumers`);
      return target
        ? pageResponse(((await fallback.json()) as { result: unknown }).result, { total_pages: 2 })
        : fallback;
    });
    await expectOwnershipConflict();
  },
);

it('rejects incomplete object pagination before deleting other inventoried resources', async () => {
  await adoptedBucket();
  interceptRead(async (url, fallback) =>
    url.pathname.endsWith('/objects') ? pageResponse([], { is_truncated: true }) : fallback,
  );
  const result = await teardown(options);
  expect(result.exitCode).not.toBe(0);
  expect(trace.every((entry) => entry.method === 'GET')).toBe(true);
});

it.each(['domains', 'zones', 'queues', 'buckets', 'versions'] as const)(
  'refuses missing completion metadata for the %s listing',
  async (kind) => {
    await saveAttachments();
    await adoptedBucket();
    const script = journal.identity.script_name;
    const suffix = {
      domains: '/workers/domains',
      zones: '/zones',
      queues: '/queues',
      buckets: '/r2/buckets',
      versions: `/workers/scripts/${script}/versions`,
    }[kind];
    interceptRead(async (url, fallback) => {
      if (!url.pathname.endsWith(suffix)) return fallback;
      return Response.json({
        success: true,
        result: ((await fallback.json()) as { result: unknown }).result,
      });
    });
    await expectOwnershipConflict();
  },
);

it.each(['schedules', 'settings', 'subdomain'] as const)(
  'refuses an incomplete %s snapshot instead of treating its first page as complete',
  async (suffix) => {
    await saveAttachments();
    interceptRead(async (url, fallback) =>
      !url.pathname.endsWith(`/${suffix}`)
        ? fallback
        : pageResponse(((await fallback.json()) as { result: unknown }).result, { total_pages: 2 }),
    );
    await expectOwnershipConflict();
  },
);

it('refuses inconsistent consumer totals even when the last page number claims completion', async () => {
  await saveAttachments();
  interceptRead(async (url, fallback) => {
    if (!url.pathname.endsWith(`/queues/${QUEUE}/consumers`)) return fallback;
    return pageResponse(
      url.searchParams.get('page') === '1'
        ? ((await fallback.json()) as { result: unknown }).result
        : [],
      { total_pages: 2, total_count: 2 },
    );
  });
  await expectOwnershipConflict();
});

it('finds a queue notification in the default R2 jurisdiction when inventory uses EU', async () => {
  await saveAttachments();
  interceptRead(async (url, fallback, init) => {
    if (
      url.pathname.endsWith('/r2/buckets') &&
      new Headers(init?.headers).get('cf-r2-jurisdiction') === 'default'
    )
      return listingResponse({ buckets: [{ name: 'external-default-bucket' }] });
    if (url.pathname.endsWith('/event_notifications/r2/external-default-bucket/configuration'))
      return response({ queues: [{ queueId: QUEUE, rules: [{ ruleId: 'foreign' }] }] });
    return fallback;
  });
  await expectOwnershipConflict();
});

it('refuses a queue binding whose known name conceals an unrecorded queue ID', async () => {
  await saveAttachments();
  interceptRead(async (url, fallback) =>
    url.pathname.endsWith(`/workers/scripts/${journal.identity.script_name}/settings`)
      ? response({
          ...ownedWorkerSettings(),
          bindings: [
            {
              type: 'queue',
              name: 'JOBS',
              queue_name: journal.resources.jobs!.name,
              queue_id: '9'.repeat(32),
            },
          ],
        })
      : fallback,
  );
  await expectOwnershipConflict();
});

it('resolves queue binding names live and refuses a replacement queue with the same name', async () => {
  await saveAttachments();
  const replacement = '9'.repeat(32);
  interceptRead(async (url, fallback) => {
    if (url.pathname.endsWith(`/queues/${QUEUE}`)) return response(null, 404);
    if (url.pathname.endsWith('/queues'))
      return listingResponse([{ queue_id: replacement, queue_name: journal.resources.jobs!.name }]);
    if (url.pathname.endsWith(`/workers/scripts/${journal.identity.script_name}/settings`))
      return response({
        ...ownedWorkerSettings(),
        bindings: [{ type: 'queue', name: 'JOBS', queue_name: journal.resources.jobs!.name }],
      });
    return fallback;
  });
  await expectOwnershipConflict();
});

it('checks Worker existence through JSON settings without downloading the script body', async () => {
  await adoptedWorker();
  const path = `/client/v4/accounts/${ACCOUNT}/workers/scripts/${journal.identity.script_name}`;
  interceptRead(async (url, fallback) =>
    url.pathname === path
      ? new Response('export default {}', { headers: { 'content-type': 'application/javascript' } })
      : fallback,
  );
  expect((await teardown(options)).exitCode).toBe(0);
  expect(trace.filter((entry) => entry.path === path).map((entry) => entry.method)).toEqual([
    'DELETE',
  ]);
  expect(trace.some((entry) => entry.path === `${path}/settings` && entry.method === 'GET')).toBe(
    true,
  );
});

it.each(['foreign', 'mixed', 'changed'] as const)(
  'refuses %s owner tags on an inventoried adopted Worker before any mutation',
  async (kind) => {
    await adoptedWorker();
    let reads = 0;
    interceptRead(async (url, fallback) => {
      if (!url.pathname.endsWith(`/workers/scripts/${journal.identity.script_name}/settings`))
        return fallback;
      reads++;
      const owned = `pb-owner-${journal.identity.owner_digest}`;
      const foreign = `pb-owner-${'f'.repeat(64)}`;
      return response({
        bindings: [],
        tags:
          kind === 'mixed'
            ? [owned, foreign]
            : [kind === 'changed' && reads === 1 ? owned : foreign],
      });
    });
    await expectOwnershipConflict();
    expect(reads).toBe(kind === 'changed' ? 2 : 1);
  },
);

it.each(['untagged', 'owned'] as const)(
  'cleans up an explicitly adopted %s Worker',
  async (kind) => {
    await adoptedWorker();
    interceptRead(async (url, fallback) =>
      url.pathname.endsWith(`/workers/scripts/${journal.identity.script_name}/settings`)
        ? response({
            bindings: [],
            tags:
              kind === 'owned'
                ? ['pb-install-v1', `pb-owner-${journal.identity.owner_digest}`]
                : [],
          })
        : fallback,
    );
    expect((await teardown(options)).exitCode).toBe(0);
    expect(trace).toContainEqual({
      path: `/client/v4/accounts/${ACCOUNT}/workers/scripts/${journal.identity.script_name}`,
      method: 'DELETE',
      body: null,
    });
  },
);

it('reads complete R2 configuration snapshots without pagination metadata or query parameters', async () => {
  const bucket = await adoptedBucket();
  const configurations = [
    `/event_notifications/r2/${bucket}/configuration`,
    ...['domains/custom', 'cors', 'lifecycle', 'lock', 'domains/managed', 'sippy'].map(
      (suffix) => `/r2/buckets/${bucket}/${suffix}`,
    ),
  ];
  const read = new Set<string>();
  interceptRead(async (url, fallback) => {
    const suffix = configurations.find((suffix) => url.pathname.endsWith(suffix));
    if (suffix) {
      expect(url.search).toBe('');
      expect(await fallback.clone().json()).not.toHaveProperty('result_info');
      read.add(suffix);
    }
    return fallback;
  });
  expect((await teardown(options)).exitCode).toBe(0);
  expect([...read].sort()).toEqual(configurations.sort());
  const firstMutation = trace.findIndex((entry) => entry.method !== 'GET');
  expect(firstMutation).toBeGreaterThan(0);
  for (const suffix of configurations)
    expect(trace.findIndex((entry) => entry.path.endsWith(suffix))).toBeLessThan(firstMutation);
  expect(
    trace.some(
      (entry) => entry.method === 'DELETE' && entry.path.endsWith(`/r2/buckets/${bucket}`),
    ),
  ).toBe(true);
});

it.each(['configuration', 'domains/custom', 'cors', 'lifecycle', 'lock'] as const)(
  'refuses malformed R2 %s snapshot collections before any mutation',
  async (suffix) => {
    const bucket = await adoptedBucket();
    interceptRead(async (url, fallback) =>
      url.pathname.endsWith(
        suffix === 'configuration'
          ? `/event_notifications/r2/${bucket}/configuration`
          : `/r2/buckets/${bucket}/${suffix}`,
      )
        ? response({})
        : fallback,
    );
    await expectOwnershipConflict();
  },
);

it.each(['enable_pending', 'enabled', 'cleanup_pending'] as const)(
  'janitor cleans up an interrupted candidate preview journalled as %s',
  async (preview) => {
    await saveAttachments();
    const attempt = journal.deployment!.attempt;
    attempt.prior_settings.endpoints = { enabled: false, previews_enabled: false };
    attempt.intended_settings.endpoints = { enabled: false, previews_enabled: false };
    attempt.requested_rollout = 10;
    attempt.candidate_probe_url = 'https://candidate.example.test';
    attempt.preview = preview;
    createdDatabase();
    await save();
    interceptRead(async (url, fallback) =>
      url.pathname.endsWith('/subdomain')
        ? response({ enabled: false, previews_enabled: true })
        : fallback,
    );
    const result = await janitor({ ...options, repositoryId: '123' });
    expect(result.exitCode).toBe(0);
    expect(result.output.checks).toContainEqual({ name: 'worker', status: 'deleted' });
    const endpoint = trace.findIndex((entry) => entry.path.endsWith('/subdomain'));
    expect(endpoint).toBeGreaterThan(0);
    expect(trace.findIndex((entry) => entry.method !== 'GET')).toBeGreaterThan(endpoint);
  },
);

it.each(['disabled', 'full_rollout', 'wrong_endpoint', 'last_verified_only'] as const)(
  'refuses an enabled preview with %s evidence before any mutation',
  async (kind) => {
    await saveAttachments();
    const attempt = journal.deployment!.attempt;
    attempt.prior_settings.endpoints = { enabled: false, previews_enabled: false };
    attempt.intended_settings.endpoints = { enabled: false, previews_enabled: false };
    attempt.requested_rollout = kind === 'full_rollout' ? 100 : 10;
    attempt.preview = kind === 'disabled' ? 'disabled' : 'enabled';
    if (kind === 'last_verified_only') {
      journal.deployment!.last_verified = {
        ...structuredClone(attempt),
        phase: 'verified',
        smoke: 'passed',
      };
      attempt.preview = 'disabled';
    }
    await save();
    interceptRead(async (url, fallback) =>
      url.pathname.endsWith('/subdomain')
        ? response({ enabled: kind === 'wrong_endpoint', previews_enabled: true })
        : fallback,
    );
    await expectOwnershipConflict();
  },
);

it('cleans up an empty R2 bucket using the HTTP object-list contract', async () => {
  const bucket = await adoptedBucket();
  let reads = 0;
  interceptRead(async (url, fallback) => {
    if (!url.pathname.endsWith(`/r2/buckets/${bucket}/objects`)) return fallback;
    expect(url.searchParams.get('per_page')).toBe('100');
    expect(url.searchParams.has('limit')).toBe(false);
    reads++;
    return pageResponse([], { is_truncated: false });
  });
  expect((await teardown(options)).exitCode).toBe(0);
  expect(reads).toBe(2);
  expect(trace.filter((entry) => entry.method !== 'GET')).toEqual([
    { path: `/client/v4/accounts/${ACCOUNT}/r2/buckets/${bucket}`, method: 'DELETE', body: null },
    {
      path: `/client/v4/accounts/${ACCOUNT}/d1/database/${DB}?jurisdiction=eu`,
      method: 'DELETE',
      body: null,
    },
  ]);
});

it.each(['missing_flag', 'invalid_flag', 'missing_cursor', 'repeated_cursor', 'binding_shape'])(
  'refuses malformed R2 object-list metadata (%s) before any mutation',
  async (kind) => {
    await adoptedBucket();
    interceptRead(async (url, fallback) => {
      if (!url.pathname.endsWith('/objects')) return fallback;
      if (kind === 'binding_shape') return response({ objects: [], truncated: false });
      return pageResponse(
        [],
        kind === 'missing_flag'
          ? {}
          : {
              is_truncated: kind === 'invalid_flag' ? 'false' : true,
              ...(kind === 'repeated_cursor' ? { cursor: 'same' } : {}),
            },
      );
    });
    expect((await teardown(options)).exitCode).toBe(1);
    expect(trace.every((entry) => entry.method === 'GET')).toBe(true);
    expect(trace.filter((entry) => entry.path.includes('/objects?'))).toHaveLength(
      kind === 'repeated_cursor' ? 2 : 1,
    );
  },
);

it.each(['binding_pending', 'bound'] as const)(
  'recognizes an uploaded analytics binding with a null dataset ID (%s)',
  async (state) => {
    await saveAttachments();
    journal.resources.analytics = {
      name: `${journal.identity.script_name.replaceAll('-', '_')}_metrics`,
      id: null,
      state,
      evidence:
        state === 'bound'
          ? { source: 'worker_binding', operation_id: null, verified_at: journal.updated_at }
          : null,
    };
    const binding = {
      type: 'analytics_engine',
      name: 'ANALYTICS',
      dataset: journal.resources.analytics.name,
    };
    await save();
    interceptRead(async (url, fallback) => {
      if (url.pathname.endsWith('/settings')) return response(ownedWorkerSettings([binding]));
      if (url.pathname.endsWith('/versions'))
        return listingResponse({ items: [{ id: 'version-1' }] });
      if (url.pathname.endsWith('/versions/version-1'))
        return response({ resources: { bindings: [binding] } });
      return fallback;
    });
    expect((await teardown(options)).exitCode).toBe(0);
    expect(
      trace.some(
        (entry) =>
          entry.method === 'DELETE' &&
          entry.path.endsWith(`/workers/scripts/${journal.identity.script_name}`),
      ),
    ).toBe(true);
  },
);

it.each(['foreign_dataset', 'missing_upload', 'wrong_evidence'])(
  'refuses an analytics binding without matching creation evidence (%s)',
  async (kind) => {
    await saveAttachments();
    journal.resources.analytics = {
      name: `${journal.identity.script_name.replaceAll('-', '_')}_metrics`,
      id: null,
      state: 'bound',
      evidence: {
        source: kind === 'wrong_evidence' ? 'adopted' : 'worker_binding',
        operation_id: null,
        verified_at: journal.updated_at,
      },
    };
    if (kind === 'missing_upload') journal.deployment!.attempt.version_id = null;
    await save();
    interceptRead(async (url, fallback) =>
      url.pathname.endsWith('/settings')
        ? response({
            bindings: [
              {
                type: 'analytics_engine',
                name: 'ANALYTICS',
                dataset:
                  kind === 'foreign_dataset'
                    ? 'foreign_metrics'
                    : journal.resources.analytics!.name,
              },
            ],
            tags: ownedWorkerSettings().tags,
          })
        : fallback,
    );
    await expectOwnershipConflict();
  },
);

const ABORT_RULE = {
  id: 'Default Multipart Abort Rule',
  enabled: true,
  conditions: { prefix: '' },
  abortMultipartUploadsTransition: { condition: { type: 'Age', maxAge: 604800 } },
};

async function provisionedBucket(baseline: unknown[] | null = [ABORT_RULE]) {
  const name = `${journal.identity.script_name}-blobs`;
  const operation = {
    id: 'create-r2',
    kind: 'r2' as const,
    name,
    spec_sha256: 'e'.repeat(64),
    absence_observed_at: journal.updated_at,
    started_at: journal.updated_at,
    state: 'confirmed' as const,
    resolved_id: name,
  };
  journal.operations.push(operation);
  journal.resources.r2 = {
    name,
    id: name,
    state: 'complete',
    jurisdiction: 'eu',
    evidence: { source: 'created', operation_id: operation.id, verified_at: journal.updated_at },
    ...(baseline === null ? {} : { lifecycle_baseline: baseline as never }),
  };
  await save();
  return name;
}

function versionsFake(ids: string[], bindings: unknown[] = []) {
  const script = journal.identity.script_name;
  interceptRead(async (url, fallback) => {
    if (url.pathname.endsWith(`/workers/scripts/${script}/versions`))
      return listingResponse({ items: ids.map((id) => ({ id })) });
    if (ids.some((id) => url.pathname.endsWith(`/versions/${id}`)))
      return response({ resources: { bindings } });
    return fallback;
  });
}

it('deletes the provisioned R2 bucket whose only lifecycle rule is the recorded provider default', async () => {
  const name = await provisionedBucket();
  interceptRead(async (url, fallback) =>
    url.pathname.endsWith(`/r2/buckets/${name}/lifecycle`)
      ? response({ rules: [ABORT_RULE] })
      : fallback,
  );
  expect((await teardown(options)).exitCode).toBe(0);
  expect(trace.some((e) => e.method === 'DELETE' && e.path.endsWith(`/r2/buckets/${name}`))).toBe(
    true,
  );
});

it('treats the documented empty storageClassTransitions as part of the abort-only default rule', async () => {
  const name = await provisionedBucket();
  interceptRead(async (url, fallback) =>
    url.pathname.endsWith(`/r2/buckets/${name}/lifecycle`)
      ? response({ rules: [{ ...ABORT_RULE, storageClassTransitions: [] }] })
      : fallback,
  );
  expect((await teardown(options)).exitCode).toBe(0);
  expect(trace.some((e) => e.method === 'DELETE' && e.path.endsWith(`/r2/buckets/${name}`))).toBe(
    true,
  );
});

it.each(['changed', 'unrelated', 'no_baseline'] as const)(
  'refuses a %s R2 lifecycle rule before any mutation',
  async (kind) => {
    const name = await provisionedBucket(kind === 'no_baseline' ? null : [ABORT_RULE]);
    const rule =
      kind === 'changed'
        ? {
            ...ABORT_RULE,
            abortMultipartUploadsTransition: { condition: { type: 'Age', maxAge: 60 } },
          }
        : kind === 'unrelated'
          ? { id: 'expire', enabled: true, conditions: { prefix: '' }, deleteObjectsTransition: {} }
          : ABORT_RULE;
    interceptRead(async (url, fallback) =>
      url.pathname.endsWith(`/r2/buckets/${name}/lifecycle`)
        ? response({ rules: [rule] })
        : fallback,
    );
    await expectOwnershipConflict();
  },
);

it('retains ownership of every uploaded Worker version across three deploy-and-smoke cycles', async () => {
  await saveAttachments();
  const attempt = journal.deployment!.attempt;
  attempt.version_id = 'version-3';
  attempt.phase = 'verified';
  attempt.smoke = 'passed';
  journal.deployment!.last_verified = structuredClone(attempt);
  journal.deployment!.history = {
    version_ids: ['version-1', 'version-2', 'version-3'],
    plain_bindings: [],
  };
  await save();
  versionsFake(['version-1', 'version-2', 'version-3']);
  expect((await teardown(options)).exitCode).toBe(0);
  expect(
    trace.some(
      (e) =>
        e.method === 'DELETE' &&
        e.path.endsWith(`/workers/scripts/${journal.identity.script_name}`),
    ),
  ).toBe(true);
});

it('refuses a foreign version even when the history lists others', async () => {
  await saveAttachments();
  journal.deployment!.history = { version_ids: ['version-1'], plain_bindings: [] };
  await save();
  versionsFake(['version-1', 'foreign']);
  await expectOwnershipConflict();
});

it('accepts only the recorded telemetry endpoint binding', async () => {
  await saveAttachments();
  const script = journal.identity.script_name;
  journal.deployment!.history = {
    version_ids: ['version-1'],
    plain_bindings: [{ name: 'OTEL_ENDPOINT', texts: ['https://otel.example.test/v1'] }],
  };
  await save();
  const settings = (text: string, name = 'OTEL_ENDPOINT') => ({
    ...ownedWorkerSettings(),
    bindings: [{ type: 'plain_text', name, text }],
  });
  for (const [binding, exit] of [
    [settings('https://otel.example.test/v1'), 0],
    [settings('https://evil.example.test/v1'), 8],
    [settings('https://otel.example.test/v1', 'OTHER_ENDPOINT'), 8],
  ] as const) {
    trace = [];
    interceptRead(async (url, fallback) =>
      url.pathname.endsWith(`/workers/scripts/${script}/settings`) ? response(binding) : fallback,
    );
    expect((await teardown(options)).exitCode).toBe(exit);
  }
});

it('reports possible unrecorded multipart uploads while retaining other resources', async () => {
  const name = await provisionedBucket();
  const fetcher = options.fetch!;
  options.fetch = vi.fn(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (init?.method === 'DELETE' && path.endsWith(`/r2/buckets/${name}`)) {
      trace.push({ path, method: 'DELETE', body: null });
      return response(null, 409);
    }
    return fetcher(input, init);
  });
  const result = await teardown(options);
  expect(result.exitCode).toBe(8);
  expect(result.output.error?.code).toBe('ownership_conflict');
  expect(result.output.error?.message).toContain('multipart uploads');
  expect(
    trace.filter((e) => e.method === 'DELETE' && !e.path.includes(`/r2/buckets/${name}`)),
  ).toEqual([]);
});

it.each([
  { confirmation: [{ key: 'a' }] },
  { confirmation: [{ key: 'a' }, null] },
  { confirmation: null },
])(
  'deletes objects with the documented array body and classifies an incomplete or invalid confirmation as unresolved: $confirmation',
  async ({ confirmation }) => {
    const name = await adoptedBucket();
    let listed = 0;
    interceptRead(async (url, fallback) =>
      url.pathname.endsWith(`/r2/buckets/${name}/objects`) && ++listed === 2
        ? pageResponse([{ key: 'a' }, { key: 'b/c' }], { is_truncated: false })
        : fallback,
    );
    const fetcher = options.fetch!;
    options.fetch = vi.fn(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (init?.method === 'DELETE' && path.endsWith('/objects')) {
        trace.push({ path, method: 'DELETE', body: JSON.parse(String(init.body)) });
        return response(confirmation);
      }
      return fetcher(input, init);
    });
    const result = await teardown(options);
    expect(result.exitCode).toBe(6);
    expect(result.output.error?.code).toBe('outcome_unknown');
    expect(trace.find((e) => e.method === 'DELETE')?.body).toEqual(['a', 'b/c']);
  },
);

it('reads complete non-paginated Worker routes and secrets arrays', async () => {
  await saveAttachments();
  interceptRead(async (url, fallback) =>
    url.pathname.endsWith('/secrets') || url.pathname.endsWith('/workers/routes')
      ? Response.json({
          success: true,
          result: ((await fallback.json()) as { result: unknown }).result,
        })
      : fallback,
  );
  expect((await teardown(options)).exitCode).toBe(0);
});

it.each(['routes', 'secrets'] as const)(
  'refuses a foreign entry in the %s snapshot',
  async (kind) => {
    await saveAttachments();
    const script = journal.identity.script_name;
    interceptRead(async (url, fallback) => {
      if (kind === 'routes' && url.pathname.endsWith('/workers/routes'))
        return response([{ id: 'foreign', script, pattern: 'x.test/*' }]);
      if (kind === 'secrets' && url.pathname.endsWith('/secrets'))
        return response([{ name: 'FOREIGN_SECRET', type: 'secret_text' }]);
      return fallback;
    });
    await expectOwnershipConflict();
  },
);

it.each(['d1', 'r2'] as const)(
  'requires explicit destructive acknowledgement for adopted %s even in a test run',
  async (key) => {
    if (key === 'r2') {
      await adoptedBucket();
      delete journal.resources.d1;
    }
    await save();
    const denied = await teardown({ ...options, iUnderstandThisDeletes: false });
    expect(denied.exitCode).toBe(2);
    expect(denied.output.error?.message).toContain('Adopted D1 and R2');
    expect(trace).toEqual([]);
    expect((await teardown(options)).exitCode).toBe(0);
  },
);

it('classifies an incorrect inventory id in a test run as invalid input before any API call', async () => {
  await save();
  const result = await teardown({ ...options, inventoryId: 'wrong' });
  expect(result.exitCode).toBe(2);
  expect(result.output.error?.code).toBe('invalid_input');
  expect(trace).toEqual([]);
});

it('detaches every recorded writer before draining a bucket', async () => {
  await saveAttachments();
  const name = await provisionedBucket();
  const attached = new Set(['schedules', 'consumer', 'route', 'domain', 'worker']);
  const fetcher = options.fetch!;
  let objects = ['live-writer-object'];
  options.fetch = vi.fn(async (input, init) => {
    const url = new URL(String(input));
    if (init?.method !== 'GET') {
      if (url.pathname.endsWith('/schedules')) attached.delete('schedules');
      if (url.pathname.endsWith('/consumers/consumer-1')) attached.delete('consumer');
      if (url.pathname.endsWith('/workers/routes/route-1')) attached.delete('route');
      if (url.pathname.endsWith('/workers/domains/domain-1')) attached.delete('domain');
      if (url.pathname.endsWith(`/workers/scripts/${journal.identity.script_name}`))
        attached.delete('worker');
      if (url.pathname.endsWith('/objects')) {
        expect(attached.size).toBe(0);
        objects = [];
      }
    }
    const fallback = await fetcher(input, init);
    if (url.pathname.endsWith('/objects') && init?.method === 'GET')
      return pageResponse(
        objects.map((key) => ({ key })),
        { is_truncated: false },
      );
    return fallback;
  });
  const result = await teardown(options);
  expect(result.exitCode).toBe(0);
  const mutations = trace.filter((entry) => entry.method !== 'GET');
  const drain = mutations.findIndex((entry) => entry.path.endsWith(`/r2/buckets/${name}/objects`));
  expect(drain).toBe(5);
  expect(mutations.slice(0, drain).map((entry) => entry.method)).toEqual([
    'DELETE',
    'DELETE',
    'DELETE',
    'PUT',
    'DELETE',
  ]);
});

it('retains the bucket contents when detaching a trigger fails', async () => {
  await saveAttachments();
  await provisionedBucket();
  const fetcher = options.fetch!;
  options.fetch = vi.fn(async (input, init) =>
    init?.method === 'DELETE' && new URL(String(input)).pathname.endsWith('/workers/routes/route-1')
      ? response(null, 403)
      : fetcher(input, init),
  );
  expect((await teardown(options)).exitCode).toBe(1);
  expect(trace.some((entry) => entry.method === 'DELETE' && entry.path.includes('/r2/'))).toBe(
    false,
  );
});

it('does not misclassify an empty final page and empty retries after deleting objects as multipart-only', async () => {
  const name = await provisionedBucket();
  let lists = 0;
  const fetcher = options.fetch!;
  options.fetch = vi.fn(async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === 'DELETE' && url.pathname.endsWith(`/r2/buckets/${name}`))
      return response(null, 409);
    const fallback = await fetcher(input, init);
    if (init?.method === 'GET' && url.pathname.endsWith('/objects')) {
      lists++;
      return lists === 2
        ? pageResponse([{ key: 'deleted-object' }], { is_truncated: true, cursor: 'last' })
        : pageResponse([], { is_truncated: false });
    }
    return fallback;
  });
  const result = await teardown(options);
  expect(result.exitCode).toBe(1);
  expect(result.output.error?.code).toBe('provider_failure');
  expect(result.output.error?.message).not.toContain('multipart uploads');
});

it('refuses queue references from R2 notifications in the FedRAMP jurisdiction', async () => {
  await saveAttachments();
  const fetcher = options.fetch!;
  options.fetch = vi.fn(async (input, init) => {
    const url = new URL(String(input));
    const fallback = await fetcher(input, init);
    if (new Headers(init?.headers).get('cf-r2-jurisdiction') !== 'fedramp') return fallback;
    if (url.pathname.endsWith('/r2/buckets'))
      return listingResponse({ buckets: [{ name: 'foreign-fedramp-bucket' }] });
    if (url.pathname.endsWith('/foreign-fedramp-bucket/configuration'))
      return response({ queues: [{ queueId: QUEUE, rules: [{ id: 'foreign-rule' }] }] });
    return fallback;
  });
  await expectOwnershipConflict();
});
