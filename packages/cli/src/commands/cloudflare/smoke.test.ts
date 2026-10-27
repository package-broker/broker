import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { envelopeResponse } from '@package-broker/core/kernel/errors';
import {
  emptyInventory,
  installIdentity,
  InventoryStore,
  type DeploymentAttempt,
  type Distribution,
  type ManagedSettings,
} from './inventory.js';
import { smoke, runCloudflareSmoke, type SmokeOptions } from './smoke.js';
import type { DeployProviderContract } from './deploy.js';

const ACCOUNT = 'a'.repeat(32),
  API = 'API_SENTINEL',
  TOKEN = 'SMOKE_SENTINEL';
const OLD = '11111111-1111-4111-8111-111111111111';
const CANDIDATE = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const DB = '44444444-4444-4444-8444-444444444444';
const URL = 'https://broker-production.account.workers.dev';
const PREVIEW = `https://${CANDIDATE.slice(0, 8)}-broker-production.account.workers.dev`;
const identity = installIdentity({ accountId: ACCOUNT, workerName: 'broker' });
const base = `/workers/scripts/${identity.script_name}`;
const settings = (): ManagedSettings => ({
  endpoints: { enabled: true, previews_enabled: false },
  schedules: ['* * * * *'],
  consumer: null,
  routes: [],
  domain: null,
});
const receipt = (): DeploymentAttempt => ({
  operation_id: 'candidate-operation',
  artifact_sha256: 'a'.repeat(64),
  assets_sha256: null,
  settings_sha256: 'b'.repeat(64),
  secret_names: ['PB_MASTER_KEY'],
  build_info: {
    schemaVersion: 1,
    target: 'cloudflare',
    core: '2.0.0',
    plugins: {},
    lockfileSha256: null,
    gitSha: null,
  },
  version_id: CANDIDATE,
  previous_version_id: OLD,
  previous_deployment_id: 'old-deploy',
  previous_distribution: [{ version_id: OLD, percentage: 100 }],
  requested_rollout: 100,
  worker_url: URL,
  candidate_probe_url: null,
  migration_ledger_sha256: 'c'.repeat(64),
  rollback_compatible: true,
  contract_ids: [],
  phase: 'active',
  activated_at: new Date(0).toISOString(),
  smoke: 'pending',
  rollback: 'not_needed',
  preview: 'disabled',
  prior_settings: settings(),
  intended_settings: settings(),
  changes: [],
});
const runtimeError = (code: string, status: number, format: 'nested' | 'npm' = 'nested') =>
  envelopeResponse(status, code, 'fixed message', 'request-1', undefined, format);
const unauthorized = (url: globalThis.URL) =>
  runtimeError('unauthorized', 401, url.pathname.endsWith('/npm/-/ping') ? 'npm' : 'nested');
const json = (body: unknown, status = 200) => Response.json(body, { status });
const snap = (result: unknown) => json({ success: true, result });
const ok = (result: unknown) => json({ success: true, result, result_info: { total_pages: 1 } });
let root: string, store: InventoryStore;
beforeEach(async () => {
  await mkdir('.pb', { recursive: true });
  root = await mkdtemp(resolve('.pb/smoke-test-'));
  store = await InventoryStore.create({
    project: root,
    outDir: join(root, '.pb/cloudflare'),
    identity,
  });
  const j = emptyInventory(identity, 0);
  j.resources.d1 = {
    id: DB,
    name: 'broker-production-db',
    state: 'complete',
    jurisdiction: 'eu',
    evidence: { source: 'adopted', operation_id: null, verified_at: new Date(0).toISOString() },
  };
  j.deployment = { attempt: receipt(), last_verified: null };
  await store.write(j);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
async function change(edit: (a: DeploymentAttempt) => void) {
  const j = (await store.read())!;
  edit(j.deployment!.attempt);
  await store.write(j);
}
function harness() {
  let clock = 0;
  const h = {
    calls: [] as {
      url: string;
      method: string;
      auth: string | null;
      init: RequestInit;
      body: unknown;
    }[],
    live: [{ version_id: CANDIDATE, percentage: 100 }] as Distribution[],
    endpoints: { enabled: true, previews_enabled: false },
    schedules: ['* * * * *'],
    domain: null as ManagedSettings['domain'],
    routes: [] as ManagedSettings['routes'],
    consumers: [] as Record<string, unknown>[],
    canonical: URL,
    owned: true,
    rollback: 'ok' as 'ok' | 'lost' | 'unknown' | 'refused',
    cleanupFail: false,
    badDigest: false,
    app: undefined as
      ((url: globalThis.URL, init: RequestInit) => Response | Promise<Response>) | undefined,
    fetch: undefined as unknown as typeof fetch,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
  h.fetch = vi.fn(async (input, init = {}) => {
    const url = new globalThis.URL(String(input));
    const auth = new Headers(init.headers).get('authorization');
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    h.calls.push({ url: url.href, method, auth, init, body });
    expect(init.redirect).toBe('manual');
    if (url.origin !== 'https://api.cloudflare.com') {
      if (auth) expect(auth).not.toContain(API);
      expect(init.credentials).toBe('omit');
      expect(new Headers(init.headers).has('cookie')).toBe(false);
      if (h.app) return h.app(url, init);
      if (url.pathname === '/health/ready') return json({ status: 'ready' });
      if (!auth) return unauthorized(url);
      if (url.pathname.endsWith('/packages.json'))
        return json({ packages: [], 'metadata-url': '/demo/p2/%package%.json' });
      return json({});
    }
    expect(auth).toBe(`Bearer ${API}`);
    const path = url.pathname.replace(`/client/v4/accounts/${ACCOUNT}`, '');
    if (url.pathname === `/client/v4/zones/${'b'.repeat(32)}/workers/routes`) return ok(h.routes);
    expect(url.pathname).toContain(`/client/v4/accounts/${ACCOUNT}/`);
    if (path === `${base}/settings`)
      return ok({
        tags: h.owned ? ['pb-install-v1', `pb-owner-${identity.owner_digest}`] : [],
        bindings: [
          { name: 'DEPLOYMENT_ID', type: 'plain_text', text: identity.deployment_id },
          { name: 'PB_PUBLIC_URL', type: 'plain_text', text: h.canonical },
          { name: 'DB', type: 'd1', id: DB },
        ],
      });
    if (path === `${base}/versions/${CANDIDATE}`)
      return ok({
        id: CANDIDATE,
        annotations: {
          'pb-operation': 'candidate-operation',
          'pb-artifact-sha256': (h.badDigest ? 'f' : 'a').repeat(64),
        },
      });
    if (path === `${base}/deployments`) {
      if (method === 'GET')
        return ok({ deployments: [{ id: 'live-deployment', versions: h.live }] });
      if (h.rollback === 'refused') return new Response(API, { status: 403 });
      if (h.rollback !== 'unknown') h.live = body.versions;
      if (h.rollback !== 'ok') throw new Error(`${API} ${TOKEN}`);
      return ok({ id: 'restored' });
    }
    if (path === `${base}/subdomain`) {
      if (method !== 'GET') {
        if (h.cleanupFail && !body.previews_enabled) return new Response(TOKEN, { status: 403 });
        h.endpoints = body;
      }
      return ok(h.endpoints);
    }
    if (path === `${base}/schedules`) {
      if (method !== 'GET') h.schedules = body.map((v: { cron: string }) => v.cron);
      return ok({ schedules: h.schedules.map((cron) => ({ cron })) });
    }
    if (path === '/workers/domains') return ok(h.domain ? [h.domain] : []);
    if (path === `/queues/${'5'.repeat(32)}/consumers`) return snap(h.consumers);
    if (path === `/queues/${'6'.repeat(32)}/consumers`) return snap([]);
    throw new Error(`Unexpected fake request: ${path}`);
  }) as typeof fetch;
  return h;
}
function options(h: ReturnType<typeof harness>, extra: Partial<SmokeOptions> = {}): SmokeOptions {
  return {
    workerName: 'broker',
    projectRoot: root,
    env: { CLOUDFLARE_API_TOKEN: API, CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
    fetch: h.fetch,
    now: h.now,
    sleep: h.sleep,
    ...extra,
  };
}
const application = (h: ReturnType<typeof harness>) =>
  h.calls.filter((c) => !c.url.startsWith('https://api.cloudflare.com/'));
const rollbacks = (h: ReturnType<typeof harness>) =>
  h.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/deployments'));
const mutations = (h: ReturnType<typeof harness>) => h.calls.filter((c) => c.method !== 'GET');
const failNpm = (h: ReturnType<typeof harness>) => {
  h.app = (url) =>
    url.pathname === '/health/ready'
      ? json({ status: 'ready' })
      : url.pathname.endsWith('packages.json')
        ? unauthorized(url)
        : new Response(`<html>${TOKEN}</html>`, { headers: { 'content-type': 'text/html' } });
};

it('always probes readiness then real project paths, including empty Composer and npm positives', async () => {
  const h = harness();
  const result = await smoke(
    options(h, { project: 'demo', env: { ...options(h).env, PB_SMOKE_TOKEN: TOKEN } }),
  );
  expect(result.exitCode).toBe(0);
  expect(application(h).map((c) => new globalThis.URL(c.url).pathname)).toEqual([
    '/health/ready',
    '/demo/packages.json',
    '/demo/npm/-/ping',
    '/demo/packages.json',
    '/demo/npm/-/ping',
  ]);
  expect(application(h).map((c) => c.auth)).toEqual([
    null,
    null,
    null,
    `Basic ${Buffer.from(`token:${TOKEN}`).toString('base64')}`,
    `Bearer ${TOKEN}`,
  ]);
  expect(result.output.checks.every((c) => c.status === 'passed')).toBe(true);
  expect((await store.read())!.deployment!.last_verified?.smoke).toBe('passed');
  expect(mutations(h)).toHaveLength(0);
  expect(JSON.stringify(result)).not.toContain(TOKEN);
  expect(await readFile(store.path, 'utf8')).not.toContain(TOKEN);
});
it('uses the absent project only for credential-free negative checks', async () => {
  const h = harness();
  expect((await smoke(options(h))).exitCode).toBe(0);
  expect(application(h).map((c) => new globalThis.URL(c.url).pathname)).toEqual([
    '/health/ready',
    '/pb-smoke-unassigned/packages.json',
    '/pb-smoke-unassigned/npm/-/ping',
  ]);
});
it.each([
  { env: { PB_SMOKE_TOKEN: TOKEN } },
  { project: 'pb-smoke-unassigned', env: { PB_SMOKE_TOKEN: TOKEN } },
  { project: '../other' },
  { project: 'health' },
  { smokeTokenEnv: 'MISSING' },
  { smokeTokenEnv: 'CLOUDFLARE_API_TOKEN' },
  { deadlineSeconds: 301 },
  { deadlineSeconds: 1.5 },
  { publicUrl: 'http://broker.example.test' },
  { publicUrl: `https://${TOKEN}@broker.example.test` },
  { publicUrl: 'https://broker.example.test/path' },
  { publicUrl: 'https://broker.example.test/' },
])('rejects invalid inputs before requests: %j', async (extra) => {
  const h = harness();
  const result = await smoke(options(h, { ...extra, env: { ...options(h).env, ...extra.env } }));
  expect(result.exitCode).toBe(2);
  expect(h.calls).toHaveLength(0);
  expect(JSON.stringify(result)).not.toContain(TOKEN);
});
it('selects a named environment token without persisting its value', async () => {
  const h = harness();
  expect(
    (
      await smoke(
        options(h, {
          project: 'demo',
          smokeTokenEnv: 'READ_TOKEN',
          env: { ...options(h).env, READ_TOKEN: TOKEN },
        }),
      )
    ).exitCode,
  ).toBe(0);
  expect(application(h).at(-1)!.auth).toBe(`Bearer ${TOKEN}`);
});
it('retries only readiness connection, recognized not_ready and rate limits with bounded backoff', async () => {
  const h = harness();
  let n = 0;
  h.app = (url) => {
    if (url.pathname !== '/health/ready') return unauthorized(url);
    n++;
    if (n === 1) throw new TypeError(TOKEN);
    if (n === 2) return runtimeError('not_ready', 503);
    if (n === 3) return new Response(TOKEN, { status: 429, headers: { 'retry-after': '5' } });
    return json({ status: 'ready' });
  };
  const start = h.now();
  const result = await smoke(options(h));
  expect(result.exitCode).toBe(0);
  expect(result.output.checks.slice(0, 4).map((c) => c.status)).toEqual([
    'connection',
    'not_ready',
    'rate_limited',
    'passed',
  ]);
  expect(h.now() - start).toBeGreaterThanOrEqual(8000);
  expect(n).toBe(4);
});
it.each([
  () => runtimeError('misconfigured', 503),
  () => runtimeError('internal', 503),
  () => runtimeError('internal', 500),
  () => json({ status: 'live' }),
  () => new Response('{', { headers: { 'content-type': 'application/json' } }),
  () => json(['ready']),
  () => new Response('html', { headers: { 'content-type': 'text/html' } }),
  () => new Response(TOKEN, { status: 302, headers: { location: 'https://foreign.example.test' } }),
  () => new Response(' '.repeat(262145), { headers: { 'content-type': 'application/json' } }),
])('fails readiness assertions immediately without retries (%#)', async (response) => {
  const h = harness();
  h.app = response;
  const result = await smoke(options(h, { noRollback: true }));
  expect(result.exitCode).toBe(9);
  expect(result.output.rollback.status).toBe('disabled');
  expect(application(h)).toHaveLength(1);
  expect(mutations(h)).toHaveLength(0);
});
it.each([200, 403, 404, 500, 502, 503])(
  'does not retry registry assertion failure %i',
  async (status) => {
    const h = harness();
    h.app = (url) =>
      url.pathname === '/health/ready' ? json({ status: 'ready' }) : json({}, status);
    const result = await smoke(options(h, { noRollback: true }));
    expect(result.exitCode).toBe(9);
    expect(application(h)).toHaveLength(2);
  },
);
it('repeats a registry transport only for 429, honors Retry-After and never follows a redirect with credentials', async () => {
  const h = harness();
  let n = 0;
  h.app = (url, init) => {
    if (url.pathname === '/health/ready') return json({ status: 'ready' });
    if (!new Headers(init.headers).has('authorization')) return unauthorized(url);
    if (++n === 1)
      return new Response(null, {
        status: 429,
        headers: { 'retry-after': new Date(h.now() + 5000).toUTCString() },
      });
    return new Response(null, {
      status: 307,
      headers: { location: `https://foreign.example.test/${TOKEN}` },
    });
  };
  const result = await smoke(
    options(h, {
      project: 'demo',
      noRollback: true,
      env: { ...options(h).env, PB_SMOKE_TOKEN: TOKEN },
    }),
  );
  expect(result.exitCode).toBe(9);
  expect(n).toBe(2);
  expect(application(h).every((c) => c.url.startsWith(URL))).toBe(true);
  expect(JSON.stringify(result)).not.toContain(TOKEN);
});
it('bounds readiness exhaustion and still has a separate rollback/readiness budget', async () => {
  const h = harness();
  h.app = () =>
    h.live[0]!.version_id === OLD ? json({ status: 'ready' }) : runtimeError('not_ready', 503);
  const result = await smoke(options(h, { deadlineSeconds: 5 }));
  expect(result.exitCode).toBe(9);
  expect(result.output.rollback.status).toBe('succeeded');
  expect(result.output.checks.at(-1)).toMatchObject({ name: 'rollback_ready', status: 'passed' });
  expect(rollbacks(h)).toHaveLength(1);
});
it.each(['ok', 'lost', 'unknown', 'refused'] as const)(
  'guards one logical rollback after %s response and preserves failed evidence on rerun',
  async (mode) => {
    const h = harness();
    h.rollback = mode;
    failNpm(h);
    const result = await smoke(options(h));
    expect(result.exitCode).toBe(mode === 'ok' || mode === 'lost' ? 9 : 10);
    expect(result.output.version_id).toBe(CANDIDATE);
    expect(result.output.rollback.status).toBe(
      mode === 'ok' || mode === 'lost' ? 'succeeded' : mode === 'refused' ? 'failed' : 'unknown',
    );
    const before = (await store.read())!.deployment!.attempt;
    const count = application(h).length;
    h.app = () => json({ status: 'ready' });
    const rerun = await smoke(options(h));
    expect(rerun.exitCode).toBe(result.exitCode);
    expect(rollbacks(h)).toHaveLength(1);
    expect(rerun.output.checks).toEqual(expect.arrayContaining(before.smoke_checks!));
    expect((await store.read())!.deployment!.attempt.smoke).toBe('failed');
    expect(
      application(h)
        .slice(count)
        .every((c) => c.url.endsWith('/health/ready')),
    ).toBe(true);
  },
);
it('reconciles a later observed rollback without replaying the unknown operation', async () => {
  const h = harness();
  h.rollback = 'unknown';
  failNpm(h);
  expect((await smoke(options(h))).exitCode).toBe(10);
  h.live = [{ version_id: OLD, percentage: 100 }];
  expect((await smoke(options(h))).exitCode).toBe(9);
  expect(rollbacks(h)).toHaveLength(1);
});
it('reports failed prior readiness as exit 10 without retrying activation on rerun', async () => {
  const h = harness();
  h.app = () => runtimeError('misconfigured', 503);
  expect((await smoke(options(h))).exitCode).toBe(10);
  h.app = () => json({ status: 'ready' });
  expect((await smoke(options(h))).exitCode).toBe(10);
  expect(rollbacks(h)).toHaveLength(1);
});
it('restores and verifies changed nonversioned configuration', async () => {
  await change((a) => {
    a.prior_settings.schedules = ['* * * * *'];
    a.intended_settings.schedules = [];
    a.changes.push({ kind: 'schedules', state: 'applied', restoration: 'not_needed' });
  });
  const h = harness();
  h.schedules = [];
  failNpm(h);
  expect((await smoke(options(h))).output.rollback.status).toBe('succeeded');
  expect(h.schedules).toEqual(['* * * * *']);
});
it('fails rollback verification if unchanged managed configuration has drifted', async () => {
  const h = harness();
  h.schedules = [];
  failNpm(h);
  expect((await smoke(options(h))).exitCode).toBe(10);
});
it('retains first-deployment candidate and resources with exit 12, even with rollback disabled', async () => {
  await change((a) => {
    a.previous_version_id = null;
    a.previous_deployment_id = null;
    a.previous_distribution = [];
  });
  const h = harness();
  failNpm(h);
  for (const noRollback of [false, true]) {
    const result = await smoke(options(h, { noRollback }));
    expect(result.exitCode).toBe(12);
    expect(result.output.rollback).toEqual({
      status: 'unavailable_first_deploy',
      target_version_id: null,
    });
  }
  expect(rollbacks(h)).toHaveLength(0);
  expect(h.live[0]!.version_id).toBe(CANDIDATE);
  expect(mutations(h)).toHaveLength(0);
});
it.each(['receipt', 'interrupted migration'] as const)(
  'blocks automatic rollback across a contract boundary in %s',
  async (where) => {
    const j = (await store.read())!;
    const target = where === 'receipt' ? j.deployment!.attempt : j.migrations;
    target.rollback_compatible = false;
    target.contract_ids = ['core:0002_contract'];
    await store.write(j);
    const h = harness();
    failNpm(h);
    const result = await smoke(options(h));
    expect(result.exitCode).toBe(11);
    expect(result.output.rollback.status).toBe('blocked_contract');
    expect(result.output.pending_migrations).toContain('core:0002_contract');
    expect(result.output.error!.message).toContain('forward repair');
    expect(rollbacks(h)).toHaveLength(0);
  },
);
it.each(['before', 'during', 'recovery'] as const)(
  'refuses changed distribution %s probes with exit 8',
  async (when) => {
    const h = harness();
    if (when === 'before') h.live = [{ version_id: OTHER, percentage: 100 }];
    if (when === 'during')
      h.app = () => {
        h.live = [{ version_id: OTHER, percentage: 100 }];
        return runtimeError('misconfigured', 503);
      };
    if (when === 'recovery') {
      failNpm(h);
      h.rollback = 'unknown';
      expect((await smoke(options(h))).exitCode).toBe(10);
      h.live = [{ version_id: OTHER, percentage: 100 }];
    }
    const before = rollbacks(h).length;
    const result = await smoke(options(h));
    expect(result.exitCode).toBe(8);
    expect(result.output.rollback.status).toBe('conflict');
    expect(rollbacks(h)).toHaveLength(before);
    expect(h.live[0]!.version_id).toBe(OTHER);
  },
);
it('never infers a standalone rollback target from active or uploaded versions', async () => {
  const j = (await store.read())!;
  j.deployment = null;
  await store.write(j);
  const h = harness();
  failNpm(h);
  const result = await smoke(options(h));
  expect(result.exitCode).toBe(9);
  expect(result.output.version_id).toBeNull();
  expect(result.output.previous_version_id).toBeNull();
  expect(result.output.rollback.status).toBe('unavailable_no_receipt');
  expect(mutations(h)).toHaveLength(0);
});
it('dry-run only reads control plane, plans assertions and leaves inventory and files unchanged', async () => {
  const h = harness();
  const before = await readFile(store.path, 'utf8');
  const files = await readdir(root, { recursive: true });
  const result = await smoke(
    options(h, {
      dryRun: true,
      project: 'demo',
      env: { ...options(h).env, PB_SMOKE_TOKEN: TOKEN },
    }),
  );
  expect(result.exitCode).toBe(0);
  expect(result.output.status).toBe('planned');
  expect(result.output.plan).toHaveLength(5);
  expect(result.output.rollback.status).toBe('eligible');
  expect(application(h)).toHaveLength(0);
  expect(mutations(h)).toHaveLength(0);
  expect(await readFile(store.path, 'utf8')).toBe(before);
  expect(await readdir(root, { recursive: true })).toEqual(files);
});
async function gradual(h: ReturnType<typeof harness>) {
  const canonical = 'https://broker.example.test';
  const domain = {
    id: 'domain-id',
    zone_id: 'b'.repeat(32),
    hostname: 'broker.example.test',
    service: identity.script_name,
    environment: 'production' as const,
  };
  h.canonical = canonical;
  h.domain = domain;
  h.endpoints.enabled = false;
  h.live = [
    { version_id: CANDIDATE, percentage: 10 },
    { version_id: OLD, percentage: 90 },
  ];
  await change((a) => {
    a.worker_url = canonical;
    a.candidate_probe_url = PREVIEW;
    a.requested_rollout = 10;
    a.prior_settings.endpoints.enabled = false;
    a.intended_settings.endpoints.enabled = false;
    a.prior_settings.domain = domain;
    a.intended_settings.domain = domain;
  });
  const contract: DeployProviderContract = {
    versionsCreateScript: false,
    secretInheritance: false,
    domainZone: async () => {
      throw new Error('Unexpected zone lookup in smoke fixture');
    },
    preview: async (_api, script, version) => {
      expect(script).toBe(identity.script_name);
      expect(version).toBe(CANDIDATE);
      expect(h.endpoints).toEqual({ enabled: false, previews_enabled: true });
      return { url: PREVIEW, version_id: CANDIDATE, bindings_verified: true };
    },
  };
  return contract;
}
it.each(['success', 'assertion', 'timeout'] as const)(
  'actually probes the pinned gradual candidate and cleans exposure after %s',
  async (mode) => {
    const h = harness();
    const contract = await gradual(h);
    h.app = (url) => {
      if (url.origin === PREVIEW && mode !== 'success') {
        if (mode === 'timeout') h.advance(121000);
        return json({ status: 'wrong' });
      }
      return url.pathname === '/health/ready' ? json({ status: 'ready' }) : unauthorized(url);
    };
    const result = await smoke(options(h, { contract }));
    expect(result.exitCode).toBe(mode === 'success' ? 0 : 9);
    expect(application(h).some((c) => c.url.startsWith(PREVIEW))).toBe(true);
    expect(h.endpoints).toEqual({ enabled: false, previews_enabled: false });
    expect((await store.read())!.deployment!.attempt.preview).toBe('disabled');
    expect(
      h.calls
        .filter((c) => c.url.endsWith('/subdomain') && c.method !== 'GET')
        .every((c) => !(c.body as { enabled: boolean }).enabled),
    ).toBe(true);
    if (mode === 'success') expect(h.live).toHaveLength(2);
  },
);
it('does not accept a preview for the wrong version and cleans exposure', async () => {
  const h = harness();
  const contract = await gradual(h);
  contract.preview = async () => ({ version_id: OTHER, url: PREVIEW, bindings_verified: true });
  const result = await smoke(options(h, { contract }));
  expect(result.exitCode).toBe(8);
  expect(application(h).some((c) => c.url.startsWith(PREVIEW))).toBe(false);
  expect(h.endpoints).toEqual({ enabled: false, previews_enabled: false });
});
it('journals failed preview cleanup and reconciles it on rerun without enabling generic workers.dev', async () => {
  const h = harness();
  const contract = await gradual(h);
  h.cleanupFail = true;
  const result = await smoke(options(h, { contract }));
  expect(result.exitCode).toBe(10);
  expect((await store.read())!.deployment!.attempt.preview).toBe('cleanup_pending');
  h.cleanupFail = false;
  expect((await smoke(options(h, { contract }))).exitCode).toBe(9);
  expect(h.endpoints).toEqual({ enabled: false, previews_enabled: false });
});
it('reconciles preview exposure left by process interruption before diagnostic probes', async () => {
  const h = harness();
  const contract = await gradual(h);
  await change((a) => {
    a.preview = 'enabled';
  });
  h.endpoints.previews_enabled = true;
  expect((await smoke(options(h, { contract, noRollback: true }))).exitCode).toBe(0);
  expect(h.endpoints.previews_enabled).toBe(false);
});
it('prints exactly one safe schema object for JSON mode', async () => {
  const h = harness();
  failNpm(h);
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await runCloudflareSmoke(options(h, { json: true }))).toBe(9);
  expect(log).toHaveBeenCalledTimes(1);
  expect(error).not.toHaveBeenCalled();
  const text = String(log.mock.calls[0]![0]);
  expect(JSON.parse(text)).toMatchObject({
    schema_version: 1,
    command: 'smoke',
    status: 'error',
    version_id: CANDIDATE,
    previous_version_id: OLD,
    kv_namespace_id: null,
    queue_names: [],
    rollback: { status: 'succeeded' },
  });
  expect(text).not.toContain(TOKEN);
  expect(text).not.toContain(API);
});

it.each(['connection', 'body'] as const)(
  'bounds a stalled %s with the request and overall deadline',
  async (where) => {
    const h = harness();
    let cancelled = false;
    h.app = () =>
      where === 'connection'
        ? new Promise<Response>(() => undefined)
        : new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { 'content-type': 'application/json' } },
          );
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = smoke(options(h, { noRollback: true, deadlineSeconds: 5 }));
    await vi.waitFor(() => expect(application(h)).toHaveLength(1));
    h.advance(5001);
    await vi.advanceTimersByTimeAsync(5001);
    const result = await pending;
    expect(result.exitCode).toBe(9);
    expect(application(h)).toHaveLength(1);
    expect(result.output.checks).toContainEqual(
      expect.objectContaining({ name: 'canonical_ready', status: 'timeout' }),
    );
    expect(application(h)[0]!.init.signal!.aborted).toBe(true);
    if (where === 'body') expect(cancelled).toBe(true);
  },
);

it('fails a positive 404 for an inaccessible project after both negative checks', async () => {
  const h = harness();
  h.app = (url, init) =>
    url.pathname === '/health/ready'
      ? json({ status: 'ready' })
      : new Headers(init.headers).has('authorization')
        ? runtimeError('not_found', 404)
        : unauthorized(url);
  const result = await smoke(
    options(h, {
      noRollback: true,
      project: 'missing',
      env: { ...options(h).env, PB_SMOKE_TOKEN: TOKEN },
    }),
  );
  expect(result.exitCode).toBe(9);
  expect(result.output.checks.map((c) => [c.name, c.status])).toEqual([
    ['canonical_ready', 'passed'],
    ['canonical_composer_unauthorized', 'passed'],
    ['canonical_npm_unauthorized', 'passed'],
    ['canonical_composer_authorized', 'failed'],
  ]);
});

it('rejects a candidate artifact digest mismatch immediately', async () => {
  const h = harness();
  h.badDigest = true;
  const result = await smoke(options(h));
  expect(result.exitCode).toBe(9);
  expect(result.output.rollback.status).toBe('succeeded');
  expect(application(h).map((c) => new globalThis.URL(c.url).pathname)).toEqual(['/health/ready']);
  expect(h.calls.filter((c) => c.url.endsWith(`/versions/${CANDIDATE}`))).toHaveLength(1);
});

it('preserves only allowlisted smoke evidence and rejects body or credential fields in the journal', async () => {
  const h = harness();
  failNpm(h);
  await smoke(options(h, { noRollback: true }));
  const j = (await store.read())!;
  const evidence = j.deployment!.attempt.smoke_checks!;
  evidence[0] = { ...evidence[0]!, name: TOKEN as never };
  await expect(store.write(j)).rejects.toMatchObject({ code: 'invalid_inventory' });
  evidence[0] = {
    name: 'canonical_ready',
    status: 'failed',
    attempt: 1,
    elapsed_ms: 0,
    body: TOKEN,
  } as never;
  await expect(store.write(j)).rejects.toMatchObject({ code: 'invalid_inventory' });
  for (const file of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (file.isFile()) {
      const bytes = await readFile(join(file.parentPath, file.name), 'utf8');
      expect(bytes).not.toContain(TOKEN);
      expect(bytes).not.toContain(API);
      expect(bytes).not.toContain(Buffer.from(`token:${TOKEN}`).toString('base64'));
    }
  }
});

it('rejects a gradual rollout journal without a candidate probe URL', async () => {
  const h = harness();
  await gradual(h);
  await change((a) => {
    a.candidate_probe_url = null;
  });
  expect(await smoke(options(h))).toMatchObject({
    exitCode: 1,
    output: { error: { code: 'invalid_inventory', stage: 'smoke' } },
  });
  expect(h.calls).toHaveLength(0);
});

it('custom origin at full rollout never enables workers.dev or previews', async () => {
  const h = harness();
  await gradual(h);
  await change((a) => {
    a.requested_rollout = 100;
    a.candidate_probe_url = null;
  });
  h.live = [{ version_id: CANDIDATE, percentage: 100 }];
  expect((await smoke(options(h))).exitCode).toBe(0);
  expect(application(h).every((c) => c.url.startsWith('https://broker.example.test/'))).toBe(true);
  expect(mutations(h)).toHaveLength(0);
  expect(h.endpoints).toEqual({ enabled: false, previews_enabled: false });
});

it('restricts unexpected custom-domain exposure on first-deployment failure', async () => {
  const h = harness();
  await gradual(h);
  await change((a) => {
    a.requested_rollout = 100;
    a.candidate_probe_url = null;
    a.previous_version_id = null;
    a.previous_deployment_id = null;
    a.previous_distribution = [];
  });
  h.live = [{ version_id: CANDIDATE, percentage: 100 }];
  h.endpoints = { enabled: true, previews_enabled: true };
  const result = await smoke(options(h));
  expect(result.exitCode).toBe(12);
  expect(h.endpoints).toEqual({ enabled: false, previews_enabled: false });
  expect(rollbacks(h)).toHaveLength(0);
});

it('detects a concurrent deployment during restored readiness without overwriting it', async () => {
  const h = harness();
  h.app = (url) => {
    if (url.pathname === '/health/ready') {
      if (h.live[0]!.version_id === OLD) h.live = [{ version_id: OTHER, percentage: 100 }];
      return json({ status: 'ready' });
    }
    return url.pathname.endsWith('packages.json') ? unauthorized(url) : json({});
  };
  const result = await smoke(options(h));
  expect(result.exitCode).toBe(8);
  expect(result.output.rollback.status).toBe('conflict');
  expect(rollbacks(h)).toHaveLength(1);
  expect(h.live[0]!.version_id).toBe(OTHER);
});

it('checks the restored version canonical origin when rollback reverts PB_PUBLIC_URL', async () => {
  const h = harness();
  const priorUrl = 'https://previous.example.test';
  const original = h.fetch;
  h.fetch = (async (input, init) => {
    const response = await original(input, init);
    if (String(input).endsWith('/deployments') && init?.method === 'POST') h.canonical = priorUrl;
    return response;
  }) as typeof fetch;
  failNpm(h);
  const result = await smoke(options(h));
  expect(result.exitCode).toBe(9);
  expect(result.output.version_id).toBe(CANDIDATE);
  expect(application(h).at(-1)!.url).toBe(`${priorUrl}/health/ready`);
  expect(application(h).at(-1)!.auth).toBeNull();
  expect((await smoke(options(h))).exitCode).toBe(9);
  expect(rollbacks(h)).toHaveLength(1);
});

it.each([true, false, null])('prints revision, dirty=%s and artifact hash', async (dirty) => {
  await change((a) => {
    a.build_info = { ...a.build_info, gitSha: 'd'.repeat(40), dirty };
  });
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await runCloudflareSmoke(options(harness(), { dryRun: true }))).toBe(0);
  expect(log.mock.calls.flat()).toContain(`revision: ${'d'.repeat(40)}; dirty: ${dirty}`);
  expect(log.mock.calls.flat()).toContain(`artifact_sha256: ${'a'.repeat(64)}`);
});

it('prints planned paths and the rollback result in human-readable mode', async () => {
  const h = harness();
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await runCloudflareSmoke(options(h, { dryRun: true }))).toBe(0);
  expect(error.mock.calls.flat().join('\n')).toContain(`${URL}/pb-smoke-unassigned/npm/-/ping`);
  expect(error.mock.calls.flat()).toContain('rollback: eligible');
  failNpm(h);
  error.mockClear();
  log.mockClear();
  expect(await runCloudflareSmoke(options(h))).toBe(9);
  expect(error.mock.calls.flat()).toContain('rollback: succeeded');
  expect(error.mock.calls.flat().join('\n')).not.toContain(TOKEN);
});

it.each(['canonical preview', 'unsafe workers.dev', 'persistent previews'] as const)(
  'rejects an unsafe receipt before requests: %s',
  async (mode) => {
    const h = harness();
    await gradual(h);
    await change((a) => {
      if (mode === 'canonical preview') a.candidate_probe_url = a.worker_url;
      if (mode === 'unsafe workers.dev') a.intended_settings.endpoints.enabled = true;
      if (mode === 'persistent previews') a.intended_settings.endpoints.previews_enabled = true;
    });
    expect((await smoke(options(h))).exitCode).toBe(2);
    expect(h.calls).toHaveLength(0);
  },
);

it.each(['candidate', 'prior'] as const)(
  'R1 reconciles restrictive rollback_pending endpoints with %s live',
  async (live) => {
    await change((a) => {
      a.phase = 'rollback_pending';
      a.rollback = 'unknown';
      a.smoke = 'failed';
      a.prior_settings.endpoints.enabled = false;
    });
    const h = harness();
    h.endpoints.enabled = false;
    h.live = [{ version_id: live === 'prior' ? OLD : CANDIDATE, percentage: 100 }];
    const result = await smoke(options(h));
    expect(result.exitCode).toBe(live === 'prior' ? 9 : 10);
    expect(result.output.rollback.status).toBe(live === 'prior' ? 'succeeded' : 'unknown');
    expect(rollbacks(h)).toHaveLength(0);
    expect(h.endpoints).toEqual({ enabled: false, previews_enabled: false });
    if (live === 'prior') {
      expect((await store.read())!.deployment!.attempt.phase).toBe('rolled_back');
      expect(result.output.checks.at(-1)).toMatchObject({
        name: 'rollback_ready',
        status: 'passed',
      });
    }
  },
);

it.each(['receipt', 'interrupted migration'] as const)(
  'R2 first-deployment failure precedes contract boundary in %s',
  async (where) => {
    const j = (await store.read())!;
    const a = j.deployment!.attempt;
    a.previous_version_id = null;
    a.previous_deployment_id = null;
    a.previous_distribution = [];
    const target = where === 'receipt' ? a : j.migrations;
    target.rollback_compatible = false;
    target.contract_ids = ['core:0002_contract'];
    await store.write(j);
    const h = harness();
    for (const noRollback of [false, true]) {
      const plan = await smoke(options(h, { dryRun: true, noRollback }));
      expect(plan.exitCode).toBe(0);
      expect(plan.output.rollback).toEqual({
        status: 'unavailable_first_deploy',
        target_version_id: null,
      });
      expect(application(h)).toHaveLength(0);
    }
    failNpm(h);
    for (const noRollback of [false, true]) {
      const result = await smoke(options(h, { noRollback }));
      expect(result.exitCode).toBe(12);
      expect(result.output.rollback).toEqual({
        status: 'unavailable_first_deploy',
        target_version_id: null,
      });
      expect(result.output.error?.code).toBe('rollback_unavailable_first_deploy');
    }
    expect(mutations(h)).toHaveLength(0);
    expect(h.live).toEqual([{ version_id: CANDIDATE, percentage: 100 }]);
  },
);

it.each(['schedules', 'consumer', 'routes', 'domain', 'unsettled restoration'] as const)(
  'R3 rechecks persisted rollback success against restored %s without activation',
  async (drift) => {
    const h = harness();
    failNpm(h);
    expect((await smoke(options(h))).exitCode).toBe(9);
    const j = (await store.read())!;
    const a = j.deployment!.attempt;
    if (drift === 'schedules') h.schedules = [];
    if (drift === 'consumer') {
      j.resources.jobs = {
        ...j.resources.d1!,
        id: '5'.repeat(32),
        name: `${identity.script_name}-jobs`,
      };
      j.resources.dlq = {
        ...j.resources.d1!,
        id: '6'.repeat(32),
        name: `${identity.script_name}-jobs-dlq`,
      };
      h.consumers = [
        {
          consumer_id: 'consumer-id',
          type: 'worker',
          script_name: identity.script_name,
          dead_letter_queue: `${identity.script_name}-jobs-dlq`,
          settings: { batch_size: 10, max_wait_time_ms: 1000, max_retries: 3, max_concurrency: 1 },
        },
      ];
    }
    if (drift === 'routes') {
      const route = {
        id: 'route-id',
        zone_id: 'b'.repeat(32),
        pattern: 'broker.example.test/*',
        script: identity.script_name,
      };
      a.prior_settings.routes = [route];
      a.intended_settings.routes = [route];
      a.prior_settings.endpoints.enabled = false;
      a.intended_settings.endpoints.enabled = false;
      h.endpoints.enabled = false;
    }
    if (drift === 'domain') {
      a.prior_settings.domain = {
        id: 'domain-id',
        zone_id: 'b'.repeat(32),
        hostname: 'broker.example.test',
        service: identity.script_name,
        environment: 'production',
      };
      a.intended_settings.domain = a.prior_settings.domain;
      a.prior_settings.endpoints.enabled = false;
      a.intended_settings.endpoints.enabled = false;
      h.endpoints.enabled = false;
    }
    if (drift === 'unsettled restoration')
      a.changes = [{ kind: 'schedules', state: 'applied', restoration: 'unknown' }];
    await store.write(j);
    const count = mutations(h).length;
    const result = await smoke(options(h));
    expect(result.exitCode).toBe(10);
    expect(result.output.rollback.status).toBe('failed');
    expect((await store.read())!.deployment!.attempt.rollback).toBe('failed');
    expect(rollbacks(h)).toHaveLength(1);
    expect(mutations(h)).toHaveLength(count);
  },
);

it('R3 verifies retained first-install attachments on persisted rollback success', async () => {
  await change((a) => {
    a.prior_settings.schedules = [];
    a.changes = [{ kind: 'schedules', state: 'applied', restoration: 'not_needed' }];
  });
  const h = harness();
  failNpm(h);
  expect((await smoke(options(h))).exitCode).toBe(9);
  expect((await store.read())!.deployment!.attempt.changes[0]!.restoration).toBe(
    'retained_first_install',
  );
  expect((await smoke(options(h))).exitCode).toBe(9);
  h.schedules = [];
  const result = await smoke(options(h));
  expect(result.exitCode).toBe(10);
  expect(result.output.rollback.status).toBe('failed');
  expect(rollbacks(h)).toHaveLength(1);
});

it.each([false, true])(
  'R4 detects standalone distribution changes with failing probes=%s',
  async (failing) => {
    const j = (await store.read())!;
    j.deployment = null;
    await store.write(j);
    const h = harness();
    h.app = (url) => {
      h.live = [{ version_id: OTHER, percentage: 100 }];
      if (failing) return runtimeError('misconfigured', 503);
      return url.pathname === '/health/ready' ? json({ status: 'ready' }) : unauthorized(url);
    };
    const result = await smoke(options(h));
    expect(result.exitCode).toBe(8);
    expect(result.output.rollback).toEqual({ status: 'conflict', target_version_id: null });
    expect(result.output.previous_version_id).toBeNull();
    expect(mutations(h)).toHaveLength(0);
    expect(h.live).toEqual([{ version_id: OTHER, percentage: 100 }]);
  },
);

it.each(['domain', 'route origin', 'domain with workers.dev origin'] as const)(
  'R5 rejects standalone workers.dev exposure for %s',
  async (kind) => {
    const j = (await store.read())!;
    j.deployment = null;
    await store.write(j);
    const h = harness();
    h.canonical = kind === 'domain with workers.dev origin' ? URL : 'https://broker.example.test';
    if (kind !== 'route origin')
      h.domain = {
        id: 'domain-id',
        zone_id: 'b'.repeat(32),
        hostname: 'broker.example.test',
        service: identity.script_name,
        environment: 'production',
      };
    const before = await readFile(store.path, 'utf8');
    for (const dryRun of [true, false]) {
      const result = await smoke(options(h, { dryRun }));
      expect(result.exitCode).toBe(9);
      expect(application(h)).toHaveLength(0);
    }
    expect(mutations(h)).toHaveLength(0);
    expect(await readFile(store.path, 'utf8')).toBe(before);
    expect(h.calls.some((c) => c.url.includes('/workers/domains'))).toBe(true);
  },
);

it.each(['https://broker.example.test', URL])(
  'R5 accepts safe standalone policy for %s',
  async (canonical) => {
    const j = (await store.read())!;
    j.deployment = null;
    await store.write(j);
    const h = harness();
    h.canonical = canonical;
    h.endpoints.enabled = canonical === URL;
    const result = await smoke(options(h));
    expect(result.exitCode).toBe(0);
    expect(result.output.previous_version_id).toBeNull();
    expect(mutations(h)).toHaveLength(0);
  },
);

it('R1 reconciles intended endpoint policy before applying the restrictive restored policy', async () => {
  await change((a) => {
    a.phase = 'rollback_pending';
    a.rollback = 'unknown';
    a.smoke = 'failed';
    a.prior_settings.endpoints.enabled = false;
  });
  const h = harness();
  h.live = [{ version_id: OLD, percentage: 100 }];
  const result = await smoke(options(h));
  expect(result.exitCode).toBe(9);
  expect(result.output.rollback.status).toBe('succeeded');
  expect(h.endpoints).toEqual({ enabled: false, previews_enabled: false });
  expect(rollbacks(h)).toHaveLength(0);
});

it.each(['receipt', 'interrupted migration'] as const)(
  'R2 runtime first-deployment failure precedes contract boundary in %s',
  async (where) => {
    const j = (await store.read())!;
    const a = j.deployment!.attempt;
    a.previous_version_id = null;
    a.previous_deployment_id = null;
    a.previous_distribution = [];
    const target = where === 'receipt' ? a : j.migrations;
    target.rollback_compatible = false;
    target.contract_ids = ['core:0002_contract'];
    await store.write(j);
    const h = harness();
    failNpm(h);
    const result = await smoke(options(h));
    expect(result.exitCode).toBe(12);
    expect(result.output.rollback).toEqual({
      status: 'unavailable_first_deploy',
      target_version_id: null,
    });
    expect(mutations(h)).toHaveLength(0);
  },
);

it.each(['script_name', 'script'] as const)(
  'R3 verifies a restored queue consumer and detects settings drift without replay (%s)',
  async (scriptField) => {
    const j = (await store.read())!;
    j.resources.jobs = {
      ...j.resources.d1!,
      id: '5'.repeat(32),
      name: `${identity.script_name}-jobs`,
    };
    j.resources.dlq = {
      ...j.resources.d1!,
      id: '6'.repeat(32),
      name: `${identity.script_name}-jobs-dlq`,
    };
    const a = j.deployment!.attempt;
    const consumer = {
      consumer_id: 'consumer-id',
      script_name: identity.script_name,
      dead_letter_queue: `${identity.script_name}-jobs-dlq`,
      batch_size: 10,
      max_wait_time_ms: 1000,
      max_retries: 3,
      max_concurrency: 1,
    };
    a.prior_settings.consumer = consumer;
    a.intended_settings.consumer = consumer;
    a.phase = 'rolled_back';
    a.rollback = 'succeeded';
    a.smoke = 'failed';
    await store.write(j);
    const h = harness();
    h.live = [{ version_id: OLD, percentage: 100 }];
    const { consumer_id, script_name, dead_letter_queue, ...settings } = consumer;
    h.consumers = [
      { consumer_id, type: 'worker', [scriptField]: script_name, dead_letter_queue, settings },
    ];
    expect((await smoke(options(h))).exitCode).toBe(9);
    const consumerReads = h.calls.filter((c) => c.url.includes('/consumers'));
    expect(consumerReads.length).toBeGreaterThan(0);
    expect(consumerReads.every((c) => !c.url.includes('?'))).toBe(true);
    settings.max_retries = 9;
    const result = await smoke(options(h));
    expect(result.exitCode).toBe(10);
    expect(result.output.rollback.status).toBe('failed');
    expect(mutations(h)).toHaveLength(0);
  },
);

it('round 2 P1 accepts the kernel npm unauthorized envelope without rollback', async () => {
  const h = harness();
  const result = await smoke(options(h));
  expect(result.exitCode).toBe(0);
  expect(result.output.checks).toEqual([
    expect.objectContaining({ name: 'canonical_ready', status: 'passed' }),
    expect.objectContaining({ name: 'canonical_composer_unauthorized', status: 'passed' }),
    expect.objectContaining({ name: 'canonical_npm_unauthorized', status: 'passed' }),
  ]);
  expect(rollbacks(h)).toHaveLength(0);
  expect((await store.read())!.deployment!.last_verified?.version_id).toBe(CANDIDATE);
});

it.each(['nested npm', 'flat Composer', 'wrong code', 'missing request id'] as const)(
  'round 2 P1 rejects invalid unauthorized envelopes: %s',
  async (invalid) => {
    const h = harness();
    h.app = async (url) => {
      if (url.pathname === '/health/ready') return json({ status: 'ready' });
      if (invalid === 'flat Composer') return runtimeError('unauthorized', 401, 'npm');
      if (url.pathname.endsWith('/packages.json')) return unauthorized(url);
      if (invalid === 'nested npm') return runtimeError('unauthorized', 401);
      if (invalid === 'wrong code') return runtimeError('forbidden', 401, 'npm');
      const body = (await runtimeError('unauthorized', 401, 'npm').json()) as Record<
        string,
        unknown
      >;
      delete body.requestId;
      return json(body, 401);
    };
    const result = await smoke(options(h, { noRollback: true }));
    expect(result.exitCode).toBe(9);
    expect(result.output.checks.at(-1)).toMatchObject({
      name:
        invalid === 'flat Composer'
          ? 'canonical_composer_unauthorized'
          : 'canonical_npm_unauthorized',
      status: 'failed',
    });
    expect(rollbacks(h)).toHaveLength(0);
  },
);

it.each(['receipt and journal', 'interrupted journal'] as const)(
  'round 2 P2 advances verified compatibility while retaining the prior boundary: %s',
  async (boundary) => {
    const j = (await store.read())!;
    j.migrations.ledger = [
      { id: 'core:0002_contract', checksum: 'd'.repeat(64), phase: 'contract' },
    ];
    j.migrations.applied_this_transaction = ['core:0002_contract'];
    j.migrations.rollback_compatible = false;
    j.migrations.contract_ids = ['core:0002_contract'];
    if (boundary === 'receipt and journal') {
      j.deployment!.attempt.rollback_compatible = false;
      j.deployment!.attempt.contract_ids = ['core:0002_contract'];
    }
    await store.write(j);
    const h = harness();
    expect((await smoke(options(h))).exitCode).toBe(0);
    const verified = (await store.read())!;
    expect(verified.migrations).toEqual({
      ...j.migrations,
      rollback_compatible: true,
      contract_ids: [],
    });
    for (const a of [verified.deployment!.attempt, verified.deployment!.last_verified!]) {
      expect(a).toMatchObject({ rollback_compatible: false, contract_ids: ['core:0002_contract'] });
    }

    failNpm(h);
    expect((await smoke(options(h))).exitCode).toBe(11);
    expect(rollbacks(h)).toHaveLength(0);

    // Mirror deploy's snapshot of migration compatibility for a later candidate.
    const next = (await store.read())!;
    next.deployment!.attempt = {
      ...receipt(),
      version_id: OTHER,
      previous_version_id: CANDIDATE,
      previous_distribution: [{ version_id: CANDIDATE, percentage: 100 }],
      rollback_compatible: next.migrations.rollback_compatible,
      contract_ids: [...next.migrations.contract_ids],
    };
    await store.write(next);
    h.live = [{ version_id: OTHER, percentage: 100 }];
    const transport: typeof fetch = async (input, init) =>
      String(input).endsWith(`/versions/${OTHER}`)
        ? ok({
            id: OTHER,
            annotations: {
              'pb-operation': 'candidate-operation',
              'pb-artifact-sha256': 'a'.repeat(64),
            },
          })
        : h.fetch(input, init);
    const recovered = await smoke(options(h, { fetch: transport }));
    expect(recovered.exitCode).toBe(9);
    expect(recovered.output.rollback).toMatchObject({
      status: 'succeeded',
      target_version_id: CANDIDATE,
    });
    expect(h.live).toEqual([{ version_id: CANDIDATE, percentage: 100 }]);
    expect(rollbacks(h)).toHaveLength(1);
  },
);

it('round 2 P2 leaves the migration boundary intact after failed verification', async () => {
  const j = (await store.read())!;
  j.migrations.rollback_compatible = false;
  j.migrations.contract_ids = ['core:0002_contract'];
  await store.write(j);
  const h = harness();
  failNpm(h);
  expect((await smoke(options(h))).exitCode).toBe(11);
  expect((await store.read())!.migrations).toEqual(j.migrations);
});

it.each([3999, 4000])(
  'round 2 P3 bounds rollback rerun evidence at %i entries and preserves candidate failure',
  async (count) => {
    const h = harness();
    failNpm(h);
    expect((await smoke(options(h))).exitCode).toBe(9);
    const j = (await store.read())!;
    const a = j.deployment!.attempt;
    const candidateChecks = a.smoke_checks!.filter((c) => c.name !== 'rollback_ready');
    expect(candidateChecks.at(-1)).toMatchObject({
      name: 'canonical_npm_unauthorized',
      status: 'failed',
    });
    const recovery = a.smoke_checks!.find((c) => c.name === 'rollback_ready')!;
    a.smoke_checks = [
      ...candidateChecks,
      ...Array.from({ length: count - candidateChecks.length }, () => ({ ...recovery })),
    ];
    await store.write(j);
    const priorRequests = application(h).length;
    for (let run = 0; run < 3; run++) {
      const result = await smoke(options(h));
      expect(result.exitCode).toBe(9);
      expect(result.output.rollback.status).toBe('succeeded');
      expect(result.output.checks.at(-1)).toMatchObject({
        name: 'rollback_ready',
        status: 'passed',
      });
      const stored = (await store.read())!.deployment!.attempt;
      expect(stored.smoke).toBe('failed');
      expect(stored.smoke_checks!.length).toBeLessThanOrEqual(4000);
      expect(stored.smoke_checks!.filter((c) => c.name !== 'rollback_ready')).toEqual(
        candidateChecks,
      );
    }
    expect(
      application(h)
        .slice(priorRequests)
        .map((c) => new globalThis.URL(c.url).pathname),
    ).toEqual(['/health/ready', '/health/ready', '/health/ready']);
    expect(rollbacks(h)).toHaveLength(1);
    h.app = () => runtimeError('misconfigured', 503);
    const unhealthy = await smoke(options(h));
    expect(unhealthy.exitCode).toBe(10);
    expect(unhealthy.output.rollback.status).toBe('failed');
    const stored = (await store.read())!.deployment!.attempt;
    expect(stored.smoke_checks!.filter((c) => c.name !== 'rollback_ready')).toEqual(
      candidateChecks,
    );
    expect(stored.smoke_checks!.length).toBeLessThanOrEqual(4000);
    expect(rollbacks(h)).toHaveLength(1);
  },
);

it('refuses a restored-consumer snapshot that advertises more pages', async () => {
  const j = (await store.read())!;
  j.resources.jobs = {
    ...j.resources.d1!,
    id: '5'.repeat(32),
    name: `${identity.script_name}-jobs`,
  };
  j.resources.dlq = {
    ...j.resources.d1!,
    id: '6'.repeat(32),
    name: `${identity.script_name}-jobs-dlq`,
  };
  const a = j.deployment!.attempt;
  a.phase = 'rolled_back';
  a.rollback = 'succeeded';
  a.smoke = 'failed';
  await store.write(j);
  const h = harness();
  h.live = [{ version_id: OLD, percentage: 100 }];
  const inner = h.fetch;
  let consumerReads = 0;
  h.fetch = (async (input: unknown, init?: RequestInit) => {
    if (!String(input).includes('/consumers')) return inner(input as never, init);
    consumerReads++;
    return json({ success: true, result: [], result_info: { total_pages: 2 } });
  }) as typeof fetch;
  const result = await smoke(options(h));
  expect(result.exitCode).toBe(10);
  expect(consumerReads).toBe(1);
});
