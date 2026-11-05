import { auditTrail } from '../audit-trail.test.support.js';
import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { base32Decode, totpCode } from '@package-broker/core/auth/totp';
import { DEFAULT_ROLES, type DefaultRoleKey } from '@package-broker/core/authz/permissions';
import { orgContext, type SqlValue } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import type { PlatformPortConfig } from '@package-broker/core/platform/port-config';
import { loadMigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { bootstrapAdmin } from '@package-broker/db-sqlite/repositories/admin-bootstrap';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import type { R2BucketLike } from '../blob/r2.js';
import { createD1Executor, type D1DatabaseLike } from '../db/d1-executor.js';
import { createWorker, type Env } from '../index.js';

/** The runtime-neutral matrices live in core test support, which no package export publishes. */
interface PolicyRequestInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly session?: boolean;
}
interface PolicyBroker {
  readonly project: string;
  fetch(path: string, init?: PolicyRequestInit): Promise<Response>;
  reauth(): Promise<void>;
  dropReauth(): Promise<void>;
  audits(): Promise<readonly { action: string; payload: string }[]>;
  breakReadAudit(): Promise<void>;
  restoreReadAudit(): Promise<void>;
  expireRule(id: string): Promise<void>;
  setVersionStatus(name: string, version: string, status: string): Promise<void>;
  versionStatus(name: string, version: string): Promise<string | null>;
  packageId(name: string): Promise<string | null>;
  upstreamCalls(): number;
  logs(): string;
}
interface PolicyUpstream {
  readonly packument: (name: string) => unknown;
  readonly tarball: (version: string) => Uint8Array;
  readonly composer: () => unknown;
  readonly zip: Uint8Array;
}
interface PolicyMatrix {
  readonly POLICY_COMPOSER_PACKAGE: string;
  policyUpstream(now: Date): Promise<PolicyUpstream>;
  policyMetadataMatrix(broker: PolicyBroker): Promise<unknown>;
  policyDistMatrix(broker: PolicyBroker): Promise<unknown>;
  policyAdminMatrix(broker: PolicyBroker): Promise<unknown>;
  policyRolloutMatrix(rollout: {
    boot(enabled: boolean): Promise<PolicyBroker>;
    bootFails(enabled: boolean): Promise<boolean>;
    storedRules(): Promise<number>;
    dropPolicySchema(): Promise<void>;
  }): Promise<unknown>;
  readonly POLICY_METADATA_EXPECTED: unknown;
  readonly POLICY_DIST_EXPECTED: unknown;
  readonly POLICY_ADMIN_EXPECTED: unknown;
  readonly POLICY_ROLLOUT_EXPECTED: unknown;
}
const matrix = (await import(
  new URL('../../../core/src/test-support/policy-matrix.ts', import.meta.url).href
)) as PolicyMatrix;

const KEY = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const PUBLIC_URL = 'https://broker.test';
const PASSWORD = 'correct horse battery staple 42';
const EMAIL = 'admin@example.test';
const HOUR = 3_600_000;

const platformPorts: PlatformPortConfig = {
  blob: { adapter: 'r2', binding: 'STORAGE', maxBytes: 1024 * 1024 },
  cache: { adapter: 'cache-api', namespace: 'policy-matrix' },
  jobs: { adapter: 'queues', binding: 'JOBS', maxRunning: 2 },
  observability: { adapter: 'workers', deploymentIdEnv: 'DEPLOYMENT_ID' },
};

const slots = Array.from({ length: 12 }, (_, index) => index);
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-10-01',
    d1Databases: slots.map((slot) => `PMDB${slot}`),
  } as Parameters<typeof convertV4MiniflareOptions>[0]),
);
let next = 0;
const realFetch = globalThis.fetch;

function memoryBucket() {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string | undefined }>();
  const view = (key: string, bytes: Uint8Array, contentType: string | undefined) => ({
    size: bytes.byteLength,
    httpMetadata: contentType === undefined ? {} : { contentType },
    body: new Response(bytes).body!,
    key,
  });
  return {
    async put(
      key: string,
      value: ReadableStream<Uint8Array> | Uint8Array,
      options?: { httpMetadata?: { contentType?: string } },
    ) {
      const bytes =
        value instanceof Uint8Array
          ? value
          : new Uint8Array(await new Response(value).arrayBuffer());
      objects.set(key, { bytes, contentType: options?.httpMetadata?.contentType });
      return { size: bytes.byteLength, httpMetadata: options?.httpMetadata ?? {} };
    },
    async get(key: string, options?: { range?: { offset: number; length: number } }) {
      const object = objects.get(key);
      if (object === undefined) return null;
      const bytes =
        options?.range === undefined
          ? object.bytes
          : object.bytes.slice(options.range.offset, options.range.offset + options.range.length);
      return view(key, bytes, object.contentType);
    },
    async head(key: string) {
      const object = objects.get(key);
      return object === undefined
        ? null
        : { ...view(key, object.bytes, object.contentType), body: undefined };
    },
    async delete(key: string) {
      objects.delete(key);
    },
  } as unknown as R2BucketLike;
}

class DigestStreamShim extends WritableStream<Uint8Array> {
  readonly digest: Promise<ArrayBuffer>;
  constructor(algorithm: string) {
    const hash = createHash(algorithm.replace('-', '').toLowerCase());
    let settle!: (value: ArrayBuffer) => void;
    const digest = new Promise<ArrayBuffer>((resolve) => {
      settle = resolve;
    });
    super({
      write(chunk) {
        hash.update(chunk);
      },
      close() {
        const out = hash.digest();
        settle(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer);
      },
    });
    this.digest = digest;
  }
}

class FixedLengthStreamShim {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  constructor() {
    const identity = new TransformStream<Uint8Array, Uint8Array>();
    this.readable = identity.readable;
    this.writable = identity.writable;
  }
}

const require = createRequire(import.meta.url);
const migrationsDirectory = join(
  dirname(require.resolve('@package-broker/db-sqlite/package.json')),
  'migrations',
);

async function migrationSources() {
  const names = (await readdir(migrationsDirectory)).filter((name) => name.endsWith('.sql')).sort();
  return Promise.all(
    names.map(async (name) =>
      loadMigrationSource('core', name, await readFile(join(migrationsDirectory, name), 'utf8')),
    ),
  );
}

const cacheStorage = {
  open: async () => ({
    match: async () => undefined,
    put: async () => undefined,
    delete: async () => false,
  }),
};

interface Harness {
  readonly raw: D1DatabaseLike;
  readonly executor: ReturnType<typeof createD1Executor>;
  readonly bucket: R2BucketLike;
  readonly orgId: string;
  readonly token: string;
  readonly calls: string[];
  readonly events: unknown[];
  cookie: string;
  csrf: string;
}

function stubUpstream(h: Harness, upstream: PolicyUpstream) {
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const json = (body: unknown) => Response.json(body, { headers: { etag: '"v1"' } });
    if (url.hostname === 'registry.npmjs.org') {
      h.calls.push(request.url);
      if (url.pathname.endsWith('.tgz')) {
        const version = /-(\d+\.\d+\.\d+)\.tgz$/.exec(url.pathname)?.[1] ?? '';
        return new Response(upstream.tarball(version));
      }
      return json(upstream.packument(decodeURIComponent(url.pathname.slice(1))));
    }
    if (url.hostname === 'repo.packagist.org') {
      h.calls.push(request.url);
      return url.pathname.endsWith('~dev.json')
        ? json({ minified: 'composer/2.0', packages: { [matrix.POLICY_COMPOSER_PACKAGE]: [] } })
        : json(upstream.composer());
    }
    if (url.hostname === 'codeload.github.com' || url.hostname === 'api.github.com') {
      h.calls.push(request.url);
      return new Response(upstream.zip, { headers: { 'content-type': 'application/zip' } });
    }
    return realFetch(input, init);
  });
}

async function harness(): Promise<Harness> {
  const slot = next;
  next += 1;
  if (slots[slot] === undefined) throw new Error('out of bindings');
  const raw = (await mf.getD1Database(`PMDB${slot}`)) as unknown as D1DatabaseLike;
  const executor = createD1Executor(raw);
  await migrate(executor, await migrationSources(), { holder: 'policy-matrix-test' });
  const orgId = ulid();
  const now = new Date();
  await createOrganizationBootstrap(executor).bootstrap({
    id: orgId,
    slug: 'acme',
    name: 'Acme',
    now: now.toISOString(),
  });
  const token = randomBytes(32).toString('base64url');
  const roleIds = Object.fromEntries(DEFAULT_ROLES.map((role) => [role.key, ulid()])) as Record<
    DefaultRoleKey,
    string
  >;
  await bootstrapAdmin(executor, orgContext(orgId), {
    email: EMAIL,
    userId: ulid(),
    setupHash: createHash('sha256').update(token).digest('hex'),
    setupExpiresAt: new Date(now.getTime() + HOUR).toISOString(),
    grantId: ulid(),
    roleIds,
    opId: ulid(),
    now: now.toISOString(),
  });
  const seed = (sql: string, params: (string | number | null)[] = []) =>
    executor.batch([{ sql, params }]);
  await seed("INSERT INTO project (id, org_id, slug, name) VALUES ('P1', ?, 'p1', 'P1')", [orgId]);
  for (const [id, ecosystem, type, url] of [
    ['NX1', 'npm', 'npmjs_proxy', 'https://registry.npmjs.org'],
    ['PX1', 'composer', 'packagist_proxy', 'https://repo.packagist.org'],
  ] as const) {
    await seed(
      `INSERT INTO source (id, org_id, project_id, name, ecosystem, type, url, config_json, removal_policy)
       VALUES (?, ?, NULL, ?, ?, ?, ?, '{}', 'flag')`,
      [id, orgId, id, ecosystem, type, url],
    );
    await seed(
      "INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES (?, 'P1', ?, 100)",
      [orgId, id],
    );
  }
  return {
    raw,
    executor,
    bucket: memoryBucket(),
    orgId,
    token,
    calls: [],
    events: [],
    cookie: '',
    csrf: '',
  };
}

function worker(h: Harness, enabled: boolean) {
  const environment: Env = {
    DB: h.raw,
    STORAGE: h.bucket,
    JOBS: { send: async () => undefined, sendBatch: async () => undefined },
    DEPLOYMENT_ID: 'policy-matrix',
    PB_MASTER_KEY: KEY,
    PB_PUBLIC_URL: PUBLIC_URL,
  };
  const app = createWorker([auditTrail()], {
    audit: {},
    platformPorts,
    cacheStorage,
    log: (record) => void h.events.push(record),
    console: {
      log: (record) => void h.events.push(record),
      error: (record) => void h.events.push(record),
    },
    registry: enabled ? { policy: { enabled: true } } : {},
  });
  return { app, fetch: (request: Request) => app.fetch(request, environment) };
}

function post(path: string, body: unknown): Request {
  return new Request(`${PUBLIC_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: PUBLIC_URL },
    body: JSON.stringify(body),
  });
}

async function login(h: Harness, fetch: (request: Request) => Promise<Response>) {
  const started = await fetch(post('/_pb/auth/local/setup/start', { token: h.token }));
  const { secret } = (await started.json()) as { secret: string };
  const totpSecret = base32Decode(secret);
  const step = Math.floor(Date.now() / 30_000);
  await fetch(
    post('/_pb/auth/local/setup/finish', {
      token: h.token,
      password: PASSWORD,
      code: await totpCode(totpSecret, step - 1),
    }),
  );
  const response = await fetch(
    post('/_pb/auth/local/login', {
      email: EMAIL,
      password: PASSWORD,
      code: await totpCode(totpSecret, step),
    }),
  );
  const cookies = response.headers.getSetCookie().map((line) => line.split(';')[0]!);
  h.cookie = cookies.join('; ');
  h.csrf = cookies.find((line) => line.startsWith('__Host-pb_csrf='))?.split('=')[1] ?? '';
}

function brokerOf(h: Harness, fetch: (request: Request) => Promise<Response>): PolicyBroker {
  const sql = async <T extends object>(statement: string, params: SqlValue[] = []) =>
    h.executor.all<T>({ sql: statement, params });
  return {
    project: 'p1',
    fetch(path, init = {}) {
      const write = init.method !== undefined && init.method !== 'GET' && init.method !== 'HEAD';
      return fetch(
        new Request(`${PUBLIC_URL}${path}`, {
          method: init.method ?? 'GET',
          headers: {
            ...(init.session === false
              ? {}
              : {
                  cookie: h.cookie,
                  ...(write ? { 'x-csrf-token': h.csrf, origin: PUBLIC_URL } : {}),
                }),
            ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
            ...init.headers,
          },
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        }),
      );
    },
    async reauth() {
      await h.executor.batch([
        {
          sql: "UPDATE session SET reauth_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE org_id = ?",
          params: [h.orgId],
        },
      ]);
    },
    async dropReauth() {
      await h.executor.batch([
        { sql: 'UPDATE session SET reauth_at = NULL WHERE org_id = ?', params: [h.orgId] },
      ]);
    },
    async audits() {
      return (
        await sql<{ action: string; payload_json: string }>(
          'SELECT action, payload_json FROM audit_pending WHERE org_id = ? ORDER BY id',
          [h.orgId],
        )
      ).map((row) => ({ action: row.action, payload: row.payload_json }));
    },
    async breakReadAudit() {
      await h.executor.batch([
        {
          sql: "CREATE TRIGGER refuse_read_denied BEFORE INSERT ON audit_pending WHEN NEW.action = 'policy.read_denied' BEGIN SELECT RAISE(ABORT, 'audit sink unavailable'); END",
          params: [],
        },
      ]);
    },
    async restoreReadAudit() {
      await h.executor.batch([{ sql: 'DROP TRIGGER refuse_read_denied', params: [] }]);
    },
    async expireRule(id) {
      await h.executor.batch([
        {
          sql: "UPDATE registry_policy_rule SET created_at = '2026-01-01T00:00:00.000Z', updated_at = '2026-01-01T00:00:00.000Z', expires_at = '2026-01-02T00:00:00.000Z' WHERE org_id = ? AND id = ?",
          params: [h.orgId, id],
        },
      ]);
    },
    async setVersionStatus(name, version, status) {
      await h.executor.batch([
        {
          sql: 'UPDATE version SET status = ? WHERE org_id = ? AND version = ? AND package_id IN (SELECT id FROM package WHERE org_id = ? AND name = ?)',
          params: [status, h.orgId, version, h.orgId, name],
        },
      ]);
    },
    async versionStatus(name, version) {
      const [row] = await sql<{ status: string }>(
        'SELECT v.status FROM version AS v JOIN package AS p ON p.id = v.package_id AND p.org_id = v.org_id WHERE v.org_id = ? AND p.name = ? AND v.version = ?',
        [h.orgId, name, version],
      );
      return row?.status ?? null;
    },
    async packageId(name) {
      const [row] = await sql<{ id: string }>(
        'SELECT id FROM package WHERE org_id = ? AND name = ?',
        [h.orgId, name],
      );
      return row?.id ?? null;
    },
    upstreamCalls: () => h.calls.length,
    logs: () => JSON.stringify(h.events),
  };
}

afterAll(async () => {
  await mf.dispose();
});

describe('registry policy HTTP matrix on Workers with Miniflare D1 and R2', () => {
  let h: Harness;
  beforeEach(async () => {
    Object.defineProperty(crypto, 'DigestStream', { value: DigestStreamShim, configurable: true });
    vi.stubGlobal('FixedLengthStream', FixedLengthStreamShim);
    h = await harness();
    stubUpstream(h, await matrix.policyUpstream(new Date()));
  });
  afterEach(() => {
    Reflect.deleteProperty(crypto, 'DigestStream');
    vi.unstubAllGlobals();
  });

  async function enabledBroker(): Promise<PolicyBroker> {
    const { fetch } = worker(h, true);
    await login(h, fetch);
    return brokerOf(h, fetch);
  }

  it('filters warm metadata after real rule writes and keeps decision-aware validators (NPM27-53)', async () => {
    expect(await matrix.policyMetadataMatrix(await enabledBroker())).toEqual(
      matrix.POLICY_METADATA_EXPECTED,
    );
  });

  it('refuses cached and fresh deliveries after a real block (NPM27-54)', async () => {
    expect(await matrix.policyDistMatrix(await enabledBroker())).toEqual(
      matrix.POLICY_DIST_EXPECTED,
    );
  });

  it('audits overrides, keeps unrelated holds and leaks no planted secret (NPM27-55)', async () => {
    expect(await matrix.policyAdminMatrix(await enabledBroker())).toEqual(
      matrix.POLICY_ADMIN_EXPECTED,
    );
  });

  it('defaults off, enforces once enabled and keeps stored rules across flag changes (NPM27-57)', async () => {
    let first = true;
    const result = await matrix.policyRolloutMatrix({
      boot: async (enabled) => {
        const { fetch } = worker(h, enabled);
        if (first) {
          await login(h, fetch);
          first = false;
        }
        return brokerOf(h, fetch);
      },
      bootFails: async (enabled) => {
        h.events.length = 0;
        const { fetch } = worker(h, enabled);
        try {
          const response = await fetch(new Request(`${PUBLIC_URL}/_pb/health`));
          return (
            response.status >= 500 && JSON.stringify(h.events).includes('startup.misconfigured')
          );
        } catch {
          return JSON.stringify(h.events).includes('startup.misconfigured');
        }
      },
      storedRules: async () =>
        (
          await h.executor.all<{ n: number }>({
            sql: 'SELECT count(*) AS n FROM registry_policy_rule WHERE org_id = ?',
            params: [h.orgId],
          })
        )[0]!.n,
      dropPolicySchema: async () => {
        await h.executor.batch([
          { sql: 'DROP TABLE registry_policy_version', params: [] },
          { sql: 'DROP TABLE registry_policy_rule', params: [] },
        ]);
      },
    });
    expect(result).toEqual(matrix.POLICY_ROLLOUT_EXPECTED);
  });

  describe('Workers wiring and boot (NPM27-50)', () => {
    it('serves without a database binding and never probes the policy schema', async () => {
      h.events.length = 0;
      const app = createWorker([], {
        log: (record) => void h.events.push(record),
        console: {
          log: (record) => void h.events.push(record),
          error: (record) => void h.events.push(record),
        },
      });
      const response = await app.fetch(new Request(`${PUBLIC_URL}/_pb/openapi.json`), {
        PB_PUBLIC_URL: PUBLIC_URL,
      } as Env);
      expect(response.status).toBe(200);
      expect(JSON.stringify(h.events)).not.toContain('startup.misconfigured');
    });

    it('refuses to start with policy enabled when the policy migration is missing', async () => {
      await h.executor.batch([
        { sql: 'DROP TABLE registry_policy_version', params: [] },
        { sql: 'DROP TABLE registry_policy_rule', params: [] },
      ]);
      const enabled = worker(h, true);
      await enabled.fetch(new Request(`${PUBLIC_URL}/_pb/health`)).catch(() => undefined);
      expect(h.events).toContainEqual(
        expect.objectContaining({
          event: 'startup.misconfigured',
          problems: ['registry.policy.enabled: the registry policy migration is missing'],
        }),
      );
      h.events.length = 0;
      const disabled = worker(h, false);
      expect((await disabled.fetch(new Request(`${PUBLIC_URL}/_pb/openapi.json`))).status).toBe(
        200,
      );
      expect(JSON.stringify(h.events)).not.toContain('startup.misconfigured');
    });
  });
});
