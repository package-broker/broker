import { createKeyring } from '@package-broker/core/secrets/keyring';
import { parseMasterKey } from '@package-broker/core/secrets/master-key';
import { createSecretCipher, credentialAad } from '@package-broker/core/secrets/cipher';
import { createCredentialStore } from '@package-broker/core/secrets/credential-store';
import { createCredentialRepository } from '@package-broker/db-sqlite/repositories/credential';
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { base32Decode, totpCode } from '@package-broker/core/auth/totp';
import { DEFAULT_ROLES, type DefaultRoleKey } from '@package-broker/core/authz/permissions';
import { orgContext, type SqlValue, type Statement } from '@package-broker/core/db/port';
import { systemClock, ulid } from '@package-broker/core/ids';
import { jobErrorCode, type JobContext } from '@package-broker/core/platform/jobs';
import { PlatformUnavailableError } from '@package-broker/core/platform/errors';
import * as kernelModule from '@package-broker/core/kernel/kernel';
import * as registryModule from '@package-broker/core/registry/module';
import * as coreJobsModule from '@package-broker/core/runtime/core-jobs';
import type { PlatformPortConfig } from '@package-broker/core/platform/port-config';
import { bootstrapAdmin } from '@package-broker/db-sqlite/repositories/admin-bootstrap';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { createJobRepository } from '@package-broker/db-sqlite/repositories/job';
import * as catalogueModule from '@package-broker/db-sqlite/repositories/catalogue-writer';
import { openNodeSqliteExecutor } from '@package-broker/db-sqlite/testing/node-sqlite-executor';
import { discoveredMigrations } from '@package-broker/db-sqlite/testing/migrated-database';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import type { R2BucketLike } from './blob/r2.js';
import {
  createD1Executor,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
} from './db/d1-executor.js';
import { createWorker, type Env } from './index.js';

const KEY = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const PUBLIC_URL = 'https://broker.test';
const EMAIL = 'admin@example.test';
const PASSWORD = 'correct horse battery staple 42';
const TYPE = 'core:package-sync:v1';
const TTL = 900;
const platformPorts: PlatformPortConfig = {
  blob: { adapter: 'r2', binding: 'STORAGE', maxBytes: 4 * 1024 * 1024 },
  cache: { adapter: 'cache-api', namespace: 'package-sync-wiring' },
  jobs: { adapter: 'queues', binding: 'JOBS', maxRunning: 2 },
  observability: { adapter: 'workers', deploymentIdEnv: 'DEPLOYMENT_ID' },
};
let mf: Miniflare | undefined;
let next = 0;
let open: () => Promise<D1DatabaseLike>;
let closeLocal: (() => void) | undefined;
async function miniflareBinding(): Promise<D1DatabaseLike> {
  mf ??= new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      compatibilityDate: '2026-10-01',
      d1Databases: Array.from({ length: 32 }, (_, i) => `SYNC${i}`),
    }),
  );
  return (await mf.getD1Database(`SYNC${next++}`)) as unknown as D1DatabaseLike;
}
async function localBinding(): Promise<D1DatabaseLike> {
  const opened = openNodeSqliteExecutor(undefined, { d1PatternLimit: true });
  closeLocal = opened.close;
  const statements = new WeakMap<D1PreparedStatementLike, Statement>();
  function prepare(statement: Statement): D1PreparedStatementLike {
    const bound: D1PreparedStatementLike = {
      bind: (...params) => prepare({ sql: statement.sql, params: params as SqlValue[] }),
      all: async () => ({ results: await opened.executor.all(statement) }),
    };
    statements.set(bound, statement);
    return bound;
  }
  return {
    prepare: (sql) => prepare({ sql, params: [] }),
    batch: async (batch) =>
      (await opened.executor.batch(batch.map((statement) => statements.get(statement)!))).map(
        (result) => ({ results: result.rows, meta: { changes: result.changes } }),
      ),
  };
}
const realFetch = globalThis.fetch;
interface StoredObject {
  readonly bytes: Uint8Array;
  readonly contentType: string | undefined;
}

function memoryBucket() {
  const objects = new Map<string, StoredObject>();
  const view = (key: string, object: StoredObject, range?: { offset: number; length: number }) => {
    const bytes =
      range === undefined
        ? object.bytes
        : object.bytes.slice(range.offset, range.offset + range.length);
    return {
      size: object.bytes.byteLength,
      httpMetadata: object.contentType === undefined ? {} : { contentType: object.contentType },
      ...(range === undefined ? {} : { range }),
      body: new Response(bytes).body!,
      key,
    };
  };
  const bucket = {
    objects,
    async put(
      key: string,
      value: ReadableStream<Uint8Array> | Uint8Array,
      options?: { sha256?: string | ArrayBuffer; httpMetadata?: { contentType?: string } },
    ) {
      const bytes =
        value instanceof Uint8Array
          ? value
          : new Uint8Array(await new Response(value).arrayBuffer());
      if (
        typeof options?.sha256 === 'string' &&
        sha(bytes, 'sha256').toString('hex') !== options.sha256
      ) {
        throw new Error('The SHA-256 checksum you specified did not match (10037)');
      }
      objects.set(key, { bytes, contentType: options?.httpMetadata?.contentType });
      return { size: bytes.byteLength, httpMetadata: options?.httpMetadata ?? {} };
    },
    async get(key: string, options?: { range?: { offset: number; length: number } }) {
      const object = objects.get(key);
      return object === undefined ? null : view(key, object, options?.range);
    },
    async head(key: string) {
      const object = objects.get(key);
      return object === undefined ? null : { ...view(key, object), body: undefined };
    },
    async delete(key: string) {
      objects.delete(key);
    },
  };
  return bucket as unknown as R2BucketLike & { objects: Map<string, StoredObject> };
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

const cacheStorage = {
  open: async () => ({
    match: async () => undefined,
    put: async () => undefined,
    delete: async () => false,
  }),
};
function sha(bytes: Uint8Array, algorithm: 'sha256' | 'sha512'): Buffer {
  return createHash(algorithm).update(bytes).digest();
}
afterAll(async () => {
  await mf?.dispose();
});
afterEach(() => {
  closeLocal?.();
  closeLocal = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(crypto, 'DigestStream');
});
beforeEach(() => {
  Object.defineProperty(crypto, 'DigestStream', { value: DigestStreamShim, configurable: true });
  vi.stubGlobal('FixedLengthStream', FixedLengthStreamShim);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
        return realFetch(input, init);
      throw new Error('unexpected upstream request');
    }),
  );
});

function upstream(ecosystem: 'npm' | 'composer', count: number) {
  let changed = false;
  let notModified = false;
  const key = ecosystem === 'npm' ? 'widget' : 'acme/widget';
  const versions = Array.from({ length: count }, (_, i) => `1.0.${i}`);
  const fetch = vi.mocked(globalThis.fetch);
  fetch.mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);
    if (
      url.origin !==
      (ecosystem === 'npm' ? 'https://registry.npmjs.org' : 'https://repo.packagist.org')
    )
      throw new Error('unexpected upstream origin');
    if (notModified) return new Response(null, { status: 304 });
    const metadata = versions.map((version) => ({
      name: key,
      version,
      description: changed ? 'changed' : 'original',
      ...(ecosystem === 'npm' && changed ? { deprecated: 'use the next release' } : {}),
      dist:
        ecosystem === 'npm'
          ? {
              tarball: `https://registry.npmjs.org/widget/-/widget-${version}.tgz`,
              integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
            }
          : { type: 'zip', url: `https://archives.example.test/widget-${version}.zip` },
    }));
    const body =
      ecosystem === 'npm'
        ? {
            name: key,
            versions: Object.fromEntries(metadata.map((m) => [m.version, m])),
            'dist-tags': { latest: versions.at(-1) },
          }
        : { packages: { [key]: url.pathname.includes('~dev') ? [] : metadata } };
    return Response.json(body, { headers: { etag: changed ? '"changed"' : '"original"' } });
  });
  return {
    key,
    versions,
    fetch,
    change: () => {
      changed = true;
    },
    notModified: () => {
      notModified = true;
    },
  };
}

function composerRepositoryFixture(
  mode: 'v2' | 'v1' | 'inline',
  badShasum = false,
  distUrl?: string,
) {
  const origin = 'https://composer.example.com';
  const key = 'acme/widget';
  const archive = 'composer fixture archive';
  const calls: Request[] = [];
  const member = {
    name: key,
    version: '1.0.0',
    version_normalized: '1.0.0.0',
    dist: {
      type: 'zip',
      url: distUrl ?? `${origin}/archive.zip`,
      reference: 'abc',
      shasum: badShasum ? '0'.repeat(40) : createHash('sha1').update(archive).digest('hex'),
    },
  };
  const body = JSON.stringify({ packages: { [key]: { '1.0.0': member } } });
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const include = JSON.stringify({ providers: { [key]: { sha256: digest(body) } } });
  const root =
    mode === 'v2'
      ? { 'metadata-url': '/p2/%package%.json', 'available-packages': [key, 'acme/ignored'] }
      : mode === 'v1'
        ? {
            'providers-url': '/p/%package%$%hash%.json',
            'provider-includes': { 'providers.json': { sha256: digest(include) } },
          }
        : {
            packages: {
              [key]: { '1.0.0': member },
              'acme/ignored': { '1.0.0': { ...member, name: 'acme/ignored' } },
            },
          };
  const transport = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    calls.push(request);
    if (url.origin === 'https://dist.example.com' && url.pathname === '/archive.zip')
      return new Response(archive);
    if (url.origin !== origin) throw new Error('unexpected fixture origin');
    if (url.pathname === '/packages.json') return Response.json(root);
    if (url.pathname === '/providers.json') return new Response(include);
    if (url.pathname === `/p/${key}%24${digest(body)}.json`) return new Response(body);
    if (url.pathname === `/p2/${key}.json`) return Response.json({ packages: { [key]: [member] } });
    if (url.pathname === `/p2/${key}~dev.json`) return Response.json({ packages: { [key]: [] } });
    if (url.pathname === '/archive.zip') return new Response(archive);
    return Response.json({}, { status: 404 });
  };
  return { origin, key, archive, transport, calls };
}

async function boot(ecosystem: 'npm' | 'composer' = 'npm') {
  const db = await open();
  const executor = createD1Executor(db);
  await migrate(executor, await discoveredMigrations(), { holder: 'package-sync-wiring' });
  const org = orgContext(ulid());
  const seed = (sql: string, params: SqlValue[] = []) => executor.batch([{ sql, params }]);
  await createOrganizationBootstrap(executor).bootstrap({
    id: org.orgId,
    slug: 'acme',
    name: 'Acme',
    now: new Date().toISOString(),
  });
  const token = randomBytes(32).toString('base64url');
  await bootstrapAdmin(executor, org, {
    email: EMAIL,
    userId: ulid(),
    setupHash: createHash('sha256').update(token).digest('hex'),
    setupExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    grantId: ulid(),
    roleIds: Object.fromEntries(DEFAULT_ROLES.map((role) => [role.key, ulid()])) as Record<
      DefaultRoleKey,
      string
    >,
    opId: ulid(),
    now: new Date().toISOString(),
  });
  await seed("INSERT INTO project (id, org_id, slug, name) VALUES ('P1', ?, 'p1', 'P1')", [
    org.orgId,
  ]);
  await seed(
    `INSERT INTO source (id, org_id, name, ecosystem, type, url, config_json, removal_policy)
    VALUES ('S1', ?, 'upstream', ?, ?, ?, '{}', 'flag')`,
    [
      org.orgId,
      ecosystem,
      ecosystem === 'npm' ? 'npmjs_proxy' : 'packagist_proxy',
      ecosystem === 'npm' ? 'https://registry.npmjs.org' : 'https://repo.packagist.org',
    ],
  );
  await seed(
    "INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES (?, 'P1', 'S1', 100)",
    [org.orgId],
  );
  const notifications: { v: number; org: string; job: string }[] = [];
  const events: unknown[] = [];
  const env: Env = {
    DB: db,
    STORAGE: memoryBucket(),
    JOBS: {
      send: async (body) => {
        notifications.push(body as (typeof notifications)[number]);
      },
      sendBatch: async (batch) => {
        notifications.push(...batch.map(({ body }) => body as (typeof notifications)[number]));
      },
    },
    DEPLOYMENT_ID: 'package-sync-test',
    PB_MASTER_KEY: KEY,
    PB_PUBLIC_URL: PUBLIC_URL,
  };
  const newWorker = () =>
    createWorker([], {
      platformPorts,
      cacheStorage,
      registry: { timers: { metadataTtlSeconds: TTL, waitBudgetMs: 1 } },
      log: (event) => void events.push(event),
      console: {
        log: (event) => void events.push(event),
        error: (event) => void events.push(event),
      },
    });
  const worker = newWorker();
  const post = (path: string, body: unknown) =>
    worker.fetch(
      new Request(`${PUBLIC_URL}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: PUBLIC_URL },
        body: JSON.stringify(body),
      }),
      env,
    );
  const start = await post('/_pb/auth/local/setup/start', { token });
  const { secret } = (await start.json()) as { secret: string };
  const totp = base32Decode(secret);
  const step = Math.floor(Date.now() / 30_000);
  expect(
    (
      await post('/_pb/auth/local/setup/finish', {
        token,
        password: PASSWORD,
        code: await totpCode(totp, step - 1),
      })
    ).status,
  ).toBe(204);
  const login = await post('/_pb/auth/local/login', {
    email: EMAIL,
    password: PASSWORD,
    code: await totpCode(totp, step),
  });
  expect(login.status).toBe(204);
  const cookie = login.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');
  const get = async (key: string, target = worker) => {
    const waited: Promise<unknown>[] = [];
    const response = await target.fetch(
      new Request(`${PUBLIC_URL}/p1/${ecosystem === 'npm' ? `npm/${key}` : `p2/${key}.json`}`, {
        headers: { cookie },
      }),
      env,
      { waitUntil: (promise) => void waited.push(promise) },
    );
    await Promise.all(waited);
    return response;
  };
  const repository = createJobRepository(executor);
  const deliver = async (notification: (typeof notifications)[number], target = worker) => {
    const ack = vi.fn();
    const retry = vi.fn();
    await target.queue({ messages: [{ body: notification, ack, retry }] }, env);
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  };
  const drain = async (target = worker) => {
    let delivered = 0;
    while (notifications.length > 0) {
      expect(++delivered).toBeLessThan(40);
      const notification = notifications.shift()!;
      await deliver(notification, target);
      expect(await repository.status(org, notification.job)).toMatchObject({ state: 'succeeded' });
    }
    return delivered;
  };
  const enqueue = async (key: string, sourceId = 'S1') => {
    const row = await repository.enqueue(org, {
      id: ulid(),
      type: TYPE,
      payloadJson: JSON.stringify({ sourceId, key }),
      idempotencyKey: ulid(),
      resourceKey: null,
      runAt: null,
      maxAttempts: 25,
      projectId: null,
      initiatorTokenId: null,
    });
    return { v: 1, org: org.orgId, job: row.id };
  };
  const catalogue = () =>
    executor.all({
      sql: 'SELECT * FROM version WHERE org_id = ? ORDER BY id',
      params: [org.orgId],
    });
  return {
    worker,
    env,
    newWorker,
    get,
    org,
    executor,
    seed,
    notifications,
    events,
    repository,
    deliver,
    drain,
    enqueue,
    catalogue,
    request: (request: Request) =>
      worker.fetch(
        new Request(request, {
          headers: {
            ...Object.fromEntries(request.headers),
            cookie,
            origin: PUBLIC_URL,
            'x-csrf-token': /__Host-pb_csrf=([^;]+)/.exec(cookie)![1]!,
          },
        }),
        env,
      ),
  };
}

const BASE_JOBS = [
  'core:publish-approval-expire:v1',
  'core:vulnerability-sync:v1',
  'core:source-sync:v1',
  'core:npm-vcs-build:v1',
  'core:source-poll:v1',
  'core:retention-scan:v1',
  'core:blob-purge:v1',
  'core:package-access-expire:v1',
  'core:audit-seal:v1',
  'core:audit-verify:v1',
  'core:import-verify:v1',
  'core:import-apply:v1',
  'core:import-rollback:v1',
  'core:npm-login-expire:v1',
  'core:pat-offboarding:v1',
  'core:pat-offboarding-sweep:v1',
];

it('leaves job registration empty when the registry cannot be built', async () => {
  const kernel = vi.spyOn(kernelModule, 'createKernel');
  const worker = createWorker([], { log: () => undefined });
  const response = await worker.fetch(new Request(`${PUBLIC_URL}/health/live`));
  expect(response.status).toBe(200);
  expect(kernel.mock.calls.at(-1)![0].registration!.jobs).toEqual([]);
});

describe.each([
  ['node:sqlite D1 binding', localBinding],
  ['Miniflare D1', miniflareBinding],
] as const)('Worker package-sync wiring with in-memory R2: %s', (_name, binding) => {
  beforeEach(() => {
    open = binding;
  });

  it.each([false, true])(
    'opens the Packagist bearer credential only when githubToken is %s',
    async (githubToken) => {
      const h = await boot('composer');
      const credentialId = await createCredentialStore({
        repository: createCredentialRepository(h.executor),
        cipher: createSecretCipher(
          createKeyring([
            parseMasterKey('pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', 'PB_MASTER_KEY'),
          ]),
          'credential-encryption',
        ),
        ids: { ulid },
        clock: systemClock,
      }).put(h.org, {
        kind: 'bearer',
        projectId: null,
        plaintext: new TextEncoder().encode(JSON.stringify({ token: 'packagist-test-token' })),
      });
      await h.seed(
        'UPDATE source SET credential_id = ?, config_json = ? WHERE org_id = ? AND id = ?',
        [credentialId, JSON.stringify({ githubToken }), h.org.orgId, 'S1'],
      );
      const calls: Request[] = [];
      const transport = async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        calls.push(request);
        const url = new URL(request.url);
        if (url.origin === 'https://api.github.com')
          return new Response(null, {
            status: 302,
            headers: { location: 'https://codeload.github.com/acme/widget/zip/abc123' },
          });
        if (url.origin === 'https://codeload.github.com') return new Response('archive');
        expect(url.origin).toBe('https://repo.packagist.org');
        return Response.json({
          packages: {
            'acme/widget': url.pathname.includes('~dev')
              ? []
              : [
                  {
                    name: 'acme/widget',
                    version: '1.0.0',
                    version_normalized: '1.0.0.0',
                    type: 'library',
                    dist: {
                      type: 'zip',
                      url: 'https://api.github.com/repos/acme/widget/zipball/abc123?archive=1',
                      reference: 'abc123',
                      shasum: '',
                    },
                  },
                ],
          },
        });
      };
      const decrypt = vi.spyOn(crypto.subtle, 'decrypt');
      try {
        vi.mocked(globalThis.fetch).mockImplementation(transport);
        const response = await h.get('acme/widget');
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          packages: Record<string, { dist: { url: string } }[]>;
        };
        const dist = await h.request(new Request(body.packages['acme/widget']![0]!.dist.url));
        expect(dist.status).toBe(200);
        expect(await dist.text()).toBe('archive');
        const aad = credentialAad({ id: credentialId, orgId: h.org.orgId, kind: 'bearer' });
        const opens = decrypt.mock.calls.filter(
          ([algorithm]) =>
            typeof algorithm === 'object' &&
            'additionalData' in algorithm &&
            algorithm.additionalData instanceof Uint8Array &&
            new TextDecoder().decode(algorithm.additionalData) === aad,
        );
        if (githubToken) expect(opens.length).toBeGreaterThan(0);
        else expect(opens).toHaveLength(0);
        for (const origin of [
          'https://repo.packagist.org',
          'https://api.github.com',
          'https://codeload.github.com',
        ]) {
          const requests = calls.filter((call) => new URL(call.url).origin === origin);
          expect(requests.length).toBeGreaterThan(0);
          for (const request of requests)
            expect(request.headers.get('authorization')).toBe(
              githubToken && origin !== 'https://repo.packagist.org'
                ? 'Bearer packagist-test-token'
                : null,
            );
        }
      } finally {
        decrypt.mockRestore();
      }
    },
  );

  it.each(['v2', 'v1', 'inline'] as const)(
    'activates and syncs a %s Composer repository through the assembled Worker',
    async (mode) => {
      const upstream = composerRepositoryFixture(
        mode,
        false,
        'https://dist.example.com/archive.zip',
      );
      const h = await boot('composer');
      vi.mocked(globalThis.fetch).mockImplementation(upstream.transport);
      const sourceId = ulid();
      await h.seed(
        "INSERT INTO source (id, org_id, name, ecosystem, type, url, config_json, status) VALUES (?, ?, 'composer', 'composer', 'composer_repository', ?, ?, 'paused')",
        [
          sourceId,
          h.org.orgId,
          upstream.origin,
          JSON.stringify({
            selection: { packages: [upstream.key], patterns: [] },
            distHosts: ['dist.example.com'],
          }),
        ],
      );
      await h.seed(
        "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, ?, 'composer', 'acme/*')",
        [ulid(), h.org.orgId, sourceId],
      );
      await h.seed("DELETE FROM project_source WHERE org_id = ? AND project_id = 'P1'", [
        h.org.orgId,
      ]);
      await h.seed(
        "INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, 'P1', ?)",
        [h.org.orgId, sourceId],
      );

      const credentialId = await createCredentialStore({
        repository: createCredentialRepository(h.executor),
        cipher: createSecretCipher(
          createKeyring([
            parseMasterKey('pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', 'PB_MASTER_KEY'),
          ]),
          'credential-encryption',
        ),
        ids: { ulid },
        clock: systemClock,
      }).put(h.org, {
        kind: 'bearer',
        projectId: null,
        plaintext: new TextEncoder().encode(JSON.stringify({ token: 'composer-private-token' })),
      });
      await h.seed('UPDATE source SET credential_id = ? WHERE org_id = ? AND id = ?', [
        credentialId,
        h.org.orgId,
        sourceId,
      ]);
      expect(
        (
          await h.request(
            new Request(`${PUBLIC_URL}/_pb/sources/${sourceId}/enable`, { method: 'POST' }),
          )
        ).status,
      ).toBe(204);
      const row = await h.repository.enqueue(h.org, {
        id: ulid(),
        type: 'core:source-sync:v1',
        payloadJson: JSON.stringify({ sourceId, reason: 'admin' }),
        idempotencyKey: ulid(),
        resourceKey: `source:${sourceId}`,
        runAt: null,
        maxAttempts: 25,
        projectId: null,
        initiatorTokenId: null,
      });
      await h.deliver({ v: 1, org: h.org.orgId, job: row.id });
      await h.drain();
      const response = await h.get(upstream.key);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        packages: Record<string, { version: string; dist: { url: string } }[]>;
      };
      expect(body.packages[upstream.key]!.map((member) => member.version)).toEqual(['1.0.0']);
      const dist = await h.request(new Request(body.packages[upstream.key]![0]!.dist.url));
      expect(dist.status).toBe(200);
      expect(await dist.text()).toBe(upstream.archive);
      expect(upstream.calls.some((call) => call.url.startsWith('https://dist.example.com/'))).toBe(
        true,
      );
      expect(
        upstream.calls.every(
          (call) => call.headers.get('authorization') === 'Bearer composer-private-token',
        ),
      ).toBe(true);
      expect(
        await h.executor.all({
          sql: 'SELECT name FROM package WHERE org_id = ? AND source_id = ?',
          params: [h.org.orgId, sourceId],
        }),
      ).toEqual([{ name: upstream.key }]);
    },
    30_000,
  );

  it.each(['shasum', 'host', 'redirect'] as const)(
    'rejects a Composer archive with invalid %s through the assembled Worker',
    async (issue) => {
      const upstream = composerRepositoryFixture(
        'inline',
        issue === 'shasum',
        issue === 'host' ? 'https://foreign.example.com/archive.zip' : undefined,
      );
      const h = await boot('composer');
      const calls: Request[] = [];
      vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
        const request = new Request(input, init);
        calls.push(request);
        if (issue === 'redirect' && request.url.endsWith('/archive.zip'))
          return new Response(null, {
            status: 302,
            headers: { location: 'https://foreign.example.com/stolen.zip' },
          });
        return upstream.transport(input, init);
      });
      await h.seed(
        "UPDATE source SET type = 'composer_repository', url = ?, config_json = ? WHERE org_id = ? AND id = 'S1'",
        [upstream.origin, JSON.stringify({ selection: { packages: [upstream.key] } }), h.org.orgId],
      );
      await h.seed(
        "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, 'S1', 'composer', 'acme/*')",
        [ulid(), h.org.orgId],
      );
      await h.deliver(await h.enqueue(upstream.key));
      await h.drain();
      const response = await h.get(upstream.key);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        packages: Record<string, { dist: { url: string } }[]>;
      };
      const dist = await h.request(new Request(body.packages[upstream.key]![0]!.dist.url));
      expect(dist.status).toBe(502);
      expect(
        await h.executor.all({
          sql: 'SELECT count(*) AS n FROM blob WHERE org_id = ?',
          params: [h.org.orgId],
        }),
      ).toEqual([{ n: 0 }]);
      if (issue === 'shasum')
        expect(
          await h.executor.all({
            sql: 'SELECT status FROM version WHERE org_id = ?',
            params: [h.org.orgId],
          }),
        ).toEqual([{ status: 'quarantined' }]);
      else expect(calls.some((call) => call.url.includes('foreign.example.com'))).toBe(false);
    },
  );

  async function proxySource(h: Awaited<ReturnType<typeof boot>>) {
    const [project, id] = [ulid(), ulid()];
    await h.seed("INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, 'p2', 'P2')", [
      project,
      h.org.orgId,
    ]);
    await h.seed(
      `INSERT INTO source (id, org_id, name, ecosystem, type, url, config_json, removal_policy)
      VALUES (?, ?, 'npmjs', 'npm', 'npmjs_proxy', 'https://registry.npmjs.org', '{}', 'flag')`,
      [id, h.org.orgId],
    );
    await h.seed(
      'INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES (?, ?, ?, 100)',
      [h.org.orgId, project, id],
    );
    return { project, id };
  }

  it('wakes the queue once after an accepted package request and not after a refusal', async () => {
    const h = await boot('npm');
    upstream('npm', 1);
    const source = await proxySource(h);
    const requestPackage = () =>
      h.request(
        new Request(`${PUBLIC_URL}/_pb/projects/p2/sources/${source.id}/packages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'widget' }),
        }),
      );
    const accepted = await requestPackage();
    expect(accepted.status).toBe(202);
    const { jobId } = (await accepted.json()) as { jobId: string };
    expect(h.notifications).toEqual([{ v: 1, org: h.org.orgId, job: jobId }]);
    expect(await h.repository.status(h.org, jobId)).toMatchObject({ state: 'queued' });
    h.notifications.length = 0;
    await h.seed('DELETE FROM project_source WHERE org_id = ? AND project_id = ?', [
      h.org.orgId,
      source.project,
    ]);
    expect((await requestPackage()).status).toBe(404);
    expect(h.notifications).toEqual([]);
  });

  it('answers 202 and keeps the job queued for Cron when the wake-up send fails', async () => {
    const h = await boot('npm');
    upstream('npm', 1);
    const source = await proxySource(h);
    const queue = h.env.JOBS as { send: (body: unknown) => Promise<void> };
    queue.send = () => Promise.reject(new Error('queue down https://user:secret@example.test'));
    const response = await h.request(
      new Request(`${PUBLIC_URL}/_pb/projects/p2/sources/${source.id}/packages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'widget' }),
      }),
    );
    expect(response.status).toBe(202);
    const { jobId } = (await response.json()) as { jobId: string };
    expect(await h.repository.status(h.org, jobId)).toMatchObject({ state: 'queued' });
    expect(h.events).toContainEqual(
      expect.objectContaining({ event: 'job.notify_failed', error_name: 'Error' }),
    );
    expect(JSON.stringify(h.events)).not.toContain('secret');
  });

  it('registers package-sync alongside the existing core jobs and fails closed before binding', async () => {
    const kernel = vi.spyOn(kernelModule, 'createKernel');
    const original = coreJobsModule.registerCoreJob;
    const early: Promise<unknown>[] = [];
    vi.spyOn(coreJobsModule, 'registerCoreJob').mockImplementation((definition) => {
      const registered = original(definition);
      if (definition.name === 'package-sync')
        early.push(
          definition
            .handler(definition.validate({ sourceId: 'S1', key: 'widget' }), {} as JobContext)
            .catch((error: unknown) => error),
        );
      return registered;
    });
    const h = await boot();
    expect(
      kernel.mock.calls
        .at(-1)![0]
        .registration!.jobs.map((job) => job.qualifiedName)
        .sort(),
    ).toEqual([...BASE_JOBS, TYPE].sort());
    expect(early).toHaveLength(1);
    const error = await early[0];
    expect(error).toBeInstanceOf(PlatformUnavailableError);
    expect(jobErrorCode(error)).toBe('handler_error');
    expect(await h.catalogue()).toEqual([]);
    expect(
      await h.executor.all({
        sql: 'SELECT * FROM ingest_session WHERE org_id = ?',
        params: [h.org.orgId],
      }),
    ).toEqual([]);
    expect(h.notifications).toEqual([]);
  });

  it('fails a queued attempt without catalogue writes when the bound module has no job', async () => {
    const original = registryModule.createRegistryModule;
    vi.spyOn(registryModule, 'createRegistryModule').mockImplementation((deps) => {
      const module = { ...original(deps) };
      delete module.packageSyncJob;
      return module;
    });
    const h = await boot();
    const notification = await h.enqueue('widget');
    await h.deliver(notification);
    expect(await h.repository.status(h.org, notification.job)).toMatchObject({
      state: 'queued',
      lastErrorCode: 'handler_error',
      history: [{ outcome: 'failed', errorCode: 'handler_error' }],
    });
    expect(await h.catalogue()).toEqual([]);
    expect(
      await h.executor.all({
        sql: 'SELECT * FROM ingest_session WHERE org_id = ?',
        params: [h.org.orgId],
      }),
    ).toEqual([]);
  });

  it.each(['npm', 'composer'] as const)(
    'completes a multi-chunk %s cold fill through the queue',
    async (ecosystem) => {
      const up = upstream(ecosystem, 600);
      const h = await boot(ecosystem);
      const first = await h.get(up.key);
      expect(first.status).toBe(503);
      expect(Number(first.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(h.notifications.length).toBeGreaterThan(0);
      expect((await h.catalogue()).length).toBeLessThan(up.versions.length);
      const delivered = await h.drain();
      expect(delivered).toBeGreaterThan(1);
      const later = await h.get(up.key, h.newWorker());
      expect(later.status).toBe(200);
      const body = (await later.json()) as {
        versions?: Record<string, unknown>;
        packages?: Record<string, { version: string }[]>;
      };
      const served =
        ecosystem === 'npm'
          ? Object.keys(body.versions!)
          : body.packages![up.key]!.map((v) => v.version);
      expect(served.sort()).toEqual([...up.versions].sort());
      expect(
        up.fetch.mock.calls.filter(([input]) => String(input).startsWith('https://')).length,
      ).toBe((delivered + 1) * (ecosystem === 'npm' ? 1 : 2));
    },
    60_000,
  );

  it('rejects the old isolate write after another isolate takes over the job lease', async () => {
    const up = upstream('npm', 600);
    const original = catalogueModule.createCatalogueWriter;
    let block = false;
    let reached!: () => void;
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(catalogueModule, 'createCatalogueWriter').mockImplementation((executor) => {
      const writer = original(executor);
      return {
        ...writer,
        async syncPackage(...args) {
          if (block) {
            block = false;
            reached();
            await gate;
          }
          return writer.syncPackage(...args);
        },
      };
    });
    const h = await boot();
    expect((await h.get(up.key)).status).toBe(503);
    expect(h.notifications).toHaveLength(1);
    const notification = h.notifications.shift()!;
    let secondReached!: () => void;
    let secondRelease!: () => void;
    const secondPaused = new Promise<void>((resolve) => {
      secondReached = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      secondRelease = resolve;
    });
    const originalModule = registryModule.createRegistryModule;
    block = true;
    const first = h.deliver(notification);
    let secondRun: Promise<void> | undefined;
    try {
      await paused;
      vi.spyOn(registryModule, 'createRegistryModule').mockImplementation((deps) => {
        const module = originalModule(deps);
        const job = module.packageSyncJob!;
        return {
          ...module,
          packageSyncJob: {
            ...job,
            async handler(payload, context) {
              secondReached();
              await secondGate;
              return job.handler(payload, context);
            },
          },
        };
      });

      const before = await h.executor.all<{ fence: number }>({
        sql: 'SELECT fence FROM job WHERE org_id = ? AND id = ?',
        params: [h.org.orgId, notification.job],
      });
      await h.seed(
        "UPDATE job SET lease_until = '2000-01-01T00:00:00.000Z' WHERE org_id = ? AND id = ?",
        [h.org.orgId, notification.job],
      );
      await h.repository.reap(h.org, 10);
      await h.seed(
        "UPDATE job SET run_at = '2000-01-01T00:00:00.000Z' WHERE org_id = ? AND id = ?",
        [h.org.orgId, notification.job],
      );
      const second = h.newWorker();
      secondRun = h.deliver(notification, second);
      await secondPaused;
      const after = await h.executor.all<{ fence: number }>({
        sql: 'SELECT fence FROM job WHERE org_id = ? AND id = ?',
        params: [h.org.orgId, notification.job],
      });
      expect(after[0]!.fence).toBeGreaterThan(before[0]!.fence);
      const published = async () => ({
        versions: await h.catalogue(),
        packages: await h.executor.all({
          sql: 'SELECT * FROM package WHERE org_id = ?',
          params: [h.org.orgId],
        }),
        validators: await h.executor.all({
          sql: 'SELECT * FROM upstream_state WHERE org_id = ?',
          params: [h.org.orgId],
        }),
      });
      const untouched = await published();
      release();
      await first;
      expect(await published()).toEqual(untouched);
      expect(h.events).toContainEqual(
        expect.objectContaining({ event: 'job.lease_lost', job_id: notification.job }),
      );
      secondRelease();
      await secondRun;
      await h.drain(second);
      expect(await h.catalogue()).toHaveLength(up.versions.length);
      expect((await h.get(up.key, second)).status).toBe(200);
    } finally {
      release();
      secondRelease();
      await first;
      await secondRun;
    }
  }, 60_000);

  it.each(['npm', 'composer'] as const)(
    'refreshes stale %s metadata and preserves its revision on 304',
    async (ecosystem) => {
      const up = upstream(ecosystem, 1);
      const h = await boot(ecosystem);
      expect((await h.get(up.key)).status).toBe(200);
      const revision = async () =>
        h.executor.all<{ revision: number }>({
          sql: 'SELECT rev AS revision FROM package WHERE org_id = ?',
          params: [h.org.orgId],
        });
      const before = await revision();
      const stale = () =>
        h.seed(
          "UPDATE upstream_state SET fresh_until = '2000-01-01T00:00:00.000Z' WHERE org_id = ?",
          [h.org.orgId],
        );
      await stale();
      up.change();
      expect((await h.get(up.key)).status).toBe(200);
      expect(h.notifications).toHaveLength(1);
      await h.drain();
      const changed = await revision();
      expect(changed[0]!.revision).toBeGreaterThan(before[0]!.revision);
      await stale();
      await h.seed('DELETE FROM job WHERE org_id = ? AND type = ?', [h.org.orgId, TYPE]);
      up.notModified();
      const callsBefore = up.fetch.mock.calls.length;
      expect((await h.get(up.key, h.newWorker())).status).toBe(200);
      expect(h.notifications).toHaveLength(1);
      await h.drain();
      expect(await revision()).toEqual(changed);
      const states = await h.executor.all<{ checked_at: string; fresh_until: string }>({
        sql: 'SELECT checked_at, fresh_until FROM upstream_state WHERE org_id = ?',
        params: [h.org.orgId],
      });
      expect(states).toHaveLength(ecosystem === 'npm' ? 1 : 2);
      for (const state of states) {
        expect(Date.parse(state.fresh_until) - Date.parse(state.checked_at)).toBe(TTL * 1000);
        expect(Date.parse(state.fresh_until)).toBeGreaterThan(Date.now());
      }
      const requests = up.fetch.mock.calls
        .slice(callsBefore)
        .filter(([input]) => String(input).startsWith('https://'));
      expect(requests).toHaveLength(ecosystem === 'npm' ? 1 : 2);
      for (const [, init] of requests)
        expect(new Headers(init?.headers).get('if-none-match')).toBe('"changed"');
    },
    60_000,
  );

  it('makes no upstream fetch for a job naming another organization source', async () => {
    const up = upstream('npm', 1);
    const h = await boot();
    const foreign = ulid();
    await h.seed('DROP INDEX organization_singleton');
    await h.seed("INSERT INTO organization (id, slug, name) VALUES (?, 'foreign', 'Foreign')", [
      foreign,
    ]);
    await h.seed(
      "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('FOREIGN', ?, 'foreign', 'npm', 'npmjs_proxy')",
      [foreign],
    );
    const calls = up.fetch.mock.calls.length;
    const notification = await h.enqueue(up.key, 'FOREIGN');
    await h.deliver(notification);
    expect(await h.repository.status(h.org, notification.job)).toMatchObject({
      state: 'succeeded',
    });
    expect(
      up.fetch.mock.calls.slice(calls).filter(([input]) => String(input).startsWith('https://')),
    ).toEqual([]);
    expect(await h.catalogue()).toEqual([]);
    expect(
      await h.executor.all({
        sql: 'SELECT * FROM ingest_session WHERE org_id = ?',
        params: [h.org.orgId],
      }),
    ).toEqual([]);
  });

  it('delivers an ingest budget event to the sink with job_id, package_key and source_id', async () => {
    const up = upstream('npm', 1);
    const original = catalogueModule.createCatalogueWriter;
    vi.spyOn(catalogueModule, 'createCatalogueWriter').mockImplementation((executor) => {
      const writer = original(executor);
      return { ...writer, statementBudget: { ...writer.statementBudget, openListing: 450 } };
    });
    const h = await boot();
    const notification = await h.enqueue(up.key);
    await h.deliver(notification);
    expect(h.events).toContainEqual(
      expect.objectContaining({
        event: 'ingest.budget_exhausted',
        reason_code: 'budget_exhausted',
        job_id: notification.job,
        package_key: up.key,
        source_id: 'S1',
      }),
    );
  });
});
