import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { base32Decode, totpCode } from '@package-broker/core/auth/totp';
import { DEFAULT_ROLES, type DefaultRoleKey } from '@package-broker/core/authz/permissions';
import { orgContext } from '@package-broker/core/db/port';
import { systemClock, ulid } from '@package-broker/core/ids';
import * as kernelModule from '@package-broker/core/kernel/kernel';
import * as moduleNamespace from '@package-broker/core/registry/module';
import type { PlatformPortConfig } from '@package-broker/core/platform/port-config';
import { blobStorageKey } from '@package-broker/core/platform/blob';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { createSecretCipher } from '@package-broker/core/secrets/cipher';
import { createCredentialStore } from '@package-broker/core/secrets/credential-store';
import { readMasterKeys } from '@package-broker/core/secrets/master-key';
import { loadMigrationSource } from '@package-broker/db-sqlite/migrations/source';
import type { MigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { bootstrapAdmin } from '@package-broker/db-sqlite/repositories/admin-bootstrap';
import { createCredentialRepository } from '@package-broker/db-sqlite/repositories/credential';
import * as vulnerabilityModule from '@package-broker/db-sqlite/repositories/vulnerability';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import type { R2BucketLike } from './blob/r2.js';
import * as d1Module from './db/d1-executor.js';
import { createD1Executor, type D1DatabaseLike } from './db/d1-executor.js';
import { createWorker, type Env, type ExecutionContextLike, type WorkerOptions } from './index.js';

const KEY = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const PUBLIC_URL = 'https://broker.test';
const PASSWORD = 'correct horse battery staple 42';
const EMAIL = 'admin@example.test';
const HOUR = 3_600_000;
const VERSION_PREFIX = `01HZ${'Z'.repeat(21)}`;
const V1 = `${VERSION_PREFIX}1`;
const OTHER_VERSION = `${VERSION_PREFIX}9`;
const NPM_TOKEN = 'npm_0123456789abcdefghijklmnopqrstuvwxyz';

const platformPorts: PlatformPortConfig = {
  blob: { adapter: 'r2', binding: 'STORAGE', maxBytes: 1024 * 1024 },
  cache: { adapter: 'cache-api', namespace: 'registry-wiring' },
  jobs: { adapter: 'queues', binding: 'JOBS', maxRunning: 2 },
  observability: { adapter: 'workers', deploymentIdEnv: 'DEPLOYMENT_ID' },
};

const slots = Array.from({ length: 28 }, (_, index) => index);
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-10-01',
    d1Databases: slots.map((slot) => `RWDB${slot}`),
  } as Parameters<typeof convertV4MiniflareOptions>[0]),
);
let next = 0;
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

afterAll(async () => {
  await mf.dispose();
});

beforeEach(() => {
  Object.defineProperty(crypto, 'DigestStream', { value: DigestStreamShim, configurable: true });
  stubUpstream();
  vi.stubGlobal('FixedLengthStream', FixedLengthStreamShim);
});

afterEach(() => {
  Reflect.deleteProperty(crypto, 'DigestStream');
  vi.unstubAllGlobals();
});

const require = createRequire(import.meta.url);
const migrationsDirectory = join(
  dirname(require.resolve('@package-broker/db-sqlite/package.json')),
  'migrations',
);

async function migrationSources(): Promise<MigrationSource[]> {
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

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`${PUBLIC_URL}${path}`, init);
}

function post(path: string, body: unknown): Request {
  return request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: PUBLIC_URL },
    body: JSON.stringify(body),
  });
}

function sha(bytes: Uint8Array, algorithm: 'sha256' | 'sha512'): Buffer {
  return createHash(algorithm).update(bytes).digest();
}

const TARBALL = new TextEncoder().encode('left-pad tarball bytes');
const PACKUMENT = {
  name: 'left-pad',
  'dist-tags': { latest: '1.0.0' },
  versions: {
    '1.0.0': {
      name: 'left-pad',
      version: '1.0.0',
      dist: {
        tarball: 'https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz',
        integrity: `sha512-${sha(TARBALL, 'sha512').toString('base64')}`,
        shasum: createHash('sha1').update(TARBALL).digest('hex'),
      },
    },
  },
  time: { '1.0.0': '2026-01-01T00:00:00.000Z' },
};
function scopedPackument(name: string) {
  return {
    name,
    'dist-tags': { latest: '2.0.0' },
    versions: {
      '2.0.0': {
        name,
        version: '2.0.0',
        dist: {
          tarball: `https://npm.acme.test/${name}/-/x-2.0.0.tgz`,
          integrity: `sha512-${sha(TARBALL, 'sha512').toString('base64')}`,
        },
      },
    },
    time: { '2.0.0': '2026-01-01T00:00:00.000Z' },
  };
}

interface Seen {
  readonly url: string;
  readonly headers: Headers;
}

function stubUpstream() {
  const seen: Seen[] = [];
  const stub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const upstream = new Request(input, init);
    if (!/^https:\/\/(registry\.npmjs\.org|npm\.acme\.test)\//.test(upstream.url)) {
      return realFetch(input, init);
    }
    seen.push({ url: upstream.url, headers: upstream.headers });
    const url = new URL(upstream.url);
    if (url.pathname === '/left-pad') {
      return Response.json(PACKUMENT, { headers: { etag: '"v1"' } });
    }
    if (url.pathname.endsWith('.tgz')) return new Response(TARBALL);
    if (url.hostname === 'npm.acme.test') {
      return Response.json(scopedPackument(decodeURIComponent(url.pathname.slice(1))));
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', stub);
  return { seen, stub };
}

interface SourceSeed {
  readonly id: string;
  readonly ecosystem: 'composer' | 'npm';
  readonly type: string;
  readonly url: string | null;
  readonly config?: string;
  readonly credentialId?: string;
  readonly scope?: string;
  readonly project?: 'P1' | 'P4';
}

async function boot(
  options: {
    sources?: SourceSeed[];
    worker?: WorkerOptions;
    registry?: WorkerOptions['registry'];
  } = {},
) {
  const slot = next;
  next += 1;
  if (slots[slot] === undefined) throw new Error('out of bindings');
  const raw = (await mf.getD1Database(`RWDB${slot}`)) as unknown as D1DatabaseLike;
  const bucket = memoryBucket();
  const executor = createD1Executor(raw);
  await migrate(executor, await migrationSources(), { holder: 'registry-wiring-test' });
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
  const seed = async (sql: string, params: (string | number | null)[] = []) => {
    const results = await executor.batch([{ sql, params }]);
    if (/^INSERT INTO project_package \(/i.test(sql)) expect(results[0]?.changes).toBe(1);
    return results;
  };
  await seed('INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)', [
    'P1',
    orgId,
    'p1',
    'P1',
  ]);
  for (const [id, slug] of [
    ['P2', 'p2'],
    ['P3', 'p3'],
    ['P4', 'p4'],
  ] as const) {
    await seed('INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)', [
      id,
      orgId,
      slug,
      id,
    ]);
  }
  const sources: SourceSeed[] = [
    {
      id: 'S1',
      ecosystem: 'composer',
      type: 'composer_repository',
      url: 'https://composer.acme.test',
    },
    { id: 'NX1', ecosystem: 'npm', type: 'npmjs_proxy', url: 'https://registry.npmjs.org' },
    ...(options.sources ?? []),
  ];
  let precedence = 100;
  for (const source of sources) {
    await seed(
      `INSERT INTO source (id, org_id, project_id, name, ecosystem, type, url, config_json, credential_id, removal_policy)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'flag')`,
      [
        source.id,
        orgId,
        source.id,
        source.ecosystem,
        source.type,
        source.url,
        source.config ?? '{}',
        source.credentialId ?? null,
      ],
    );
    if (source.scope !== undefined) {
      await seed(
        'INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, ?, ?, ?)',
        [ulid(), orgId, source.id, 'npm', `${source.scope}/*`],
      );
    }
    await seed(
      'INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES (?, ?, ?, ?)',
      [
        orgId,
        source.project ?? (options.sources?.includes(source) ? 'P4' : 'P1'),
        source.id,
        source.type === 'npm_registry' ? 50 : (precedence += 100),
      ],
    );
  }
  await seed(
    "INSERT INTO package (id, org_id, source_id, ecosystem, name, last_synced_at) VALUES (?, ?, ?, ?, ?, '2026-10-19T00:00:00.000Z')",
    ['K1', orgId, 'S1', 'composer', 'acme/lib'],
  );
  await seed(
    "INSERT INTO package (id, org_id, source_id, ecosystem, name, last_synced_at) VALUES (?, ?, ?, ?, ?, '2026-10-19T00:00:00.000Z')",
    ['K2', orgId, 'S1', 'composer', 'acme/other'],
  );
  for (const id of ['K1', 'K2']) {
    await seed(
      'INSERT INTO project_package (org_id, project_id, package_id, origin, ecosystem, name) SELECT input.org_id, input.project_id, input.package_id, input.origin, p.ecosystem, p.name FROM (SELECT ? AS org_id, ? AS project_id, ? AS package_id, ? AS origin) AS input JOIN package AS p ON p.org_id = input.org_id AND p.id = input.package_id',
      [orgId, 'P1', id, 'subscription'],
    );
  }
  await seed(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3)
     INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at,
                          published_at_basis, metadata_json)
     SELECT ? || i, ?, 'K1', '1.0.' || i, '1.0.' || i || '.0', '2020-01-01T00:00:00.000Z',
            'import_time', '{"name":"acme/lib","source":{"type":"git","url":"https://git.acme.test/lib.git","reference":"r' || i || '"}}'
     FROM n`,
    [VERSION_PREFIX, orgId],
  );
  await seed(
    `INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at,
                          published_at_basis, metadata_json)
     VALUES (?, ?, 'K2', '1.0.0', '1.0.0.0', '2020-01-01T00:00:00.000Z', 'import_time',
             '{"name":"acme/other","source":{"type":"git","url":"https://git.acme.test/o.git","reference":"r"}}')`,
    [OTHER_VERSION, orgId],
  );
  const zip = new TextEncoder().encode('zip bytes');
  const digest = sha(zip, 'sha256').toString('hex');
  await bucket.put(blobStorageKey(orgId as never, digest as never), zip);
  await seed(
    `INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key, media_type)
     VALUES ('B1', ?, ?, ?, ?, 'application/zip')`,
    [orgId, digest, zip.byteLength, blobStorageKey(orgId as never, digest as never)],
  );
  await seed("UPDATE version SET blob_id = 'B1', dist_type = 'zip' WHERE id = ?", [V1]);

  const events: unknown[] = [];
  const environment: Env = {
    DB: raw,
    STORAGE: bucket,
    JOBS: { send: async () => undefined, sendBatch: async () => undefined },
    DEPLOYMENT_ID: 'registry-test',
    PB_MASTER_KEY: KEY,
    PB_PUBLIC_URL: PUBLIC_URL,
  };
  const worker = createWorker([], {
    platformPorts,
    cacheStorage,
    log: (record) => void events.push(record),
    console: {
      log: (record) => void events.push(record),
      error: (record) => void events.push(record),
    },
    ...(options.registry === undefined ? {} : { registry: options.registry }),
    ...options.worker,
  });
  const fetch = (input: Request, ctx?: ExecutionContextLike) =>
    worker.fetch(input, environment, ctx);

  const started = await fetch(post('/_pb/auth/local/setup/start', { token }));
  const { secret } = (await started.json()) as { secret: string };
  const totpSecret = base32Decode(secret);
  const step = Math.floor(Date.now() / 30_000);
  await fetch(
    post('/_pb/auth/local/setup/finish', {
      token,
      password: PASSWORD,
      code: await totpCode(totpSecret, step - 1),
    }),
  );
  const login = await fetch(
    post('/_pb/auth/local/login', {
      email: EMAIL,
      password: PASSWORD,
      code: await totpCode(totpSecret, step),
    }),
  );
  const cookie = login.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');
  return { worker, environment, fetch, cookie, orgId, executor, bucket, events, seed };
}

interface RegistryAssemblyEntry {
  readonly dependency: string;
  readonly routes: readonly string[];
  readonly jobs: readonly string[];
  readonly ownerPacket: string;
}

const NPM_PACKAGE_PATHS = [
  '/:project/npm/:a',
  '/:project/npm/:a/:b',
  '/:project/npm/:a/:b/:c',
  '/:project/npm/:a/:b/:c/:d',
];

// Management routes, dependencies and jobs are covered by api-mount.test.ts.
const REGISTRY_ASSEMBLY: readonly RegistryAssemblyEntry[] = Object.freeze([
  {
    dependency: 'composer routes over the catalogue reader, on-demand fill and dist service',
    routes: [
      '/:project/packages.json',
      '/:project/p2/:vendor/:file',
      '/:project/dist/:vendor/:name/:file',
    ],
    jobs: [],
    ownerPacket: 'T434n',
  },
  {
    dependency: 'npm routes over the catalogue reader, on-demand fill and dist service',
    routes: ['/:project/npm/-/whoami', '/:project/npm/-/v1/search', ...NPM_PACKAGE_PATHS],
    jobs: [],
    ownerPacket: 'T434n',
  },
  {
    dependency: 'scoped-admitting package resolver',
    routes: [],
    jobs: [],
    ownerPacket: 'T434n',
  },
  {
    dependency: 'package-sync job and webhook route',
    routes: [],
    jobs: [],
    ownerPacket: 'T432c',
  },
]);

describe('cloudflare registry wiring on Miniflare D1 and R2', () => {
  it('serves p2 for a seeded package', async () => {
    const { fetch, cookie } = await boot();
    const response = await fetch(request('/p1/p2/acme/lib.json', { headers: { cookie } }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { packages: Record<string, unknown[]> };
    expect(body.packages['acme/lib']).toHaveLength(3);
  });

  it('serves an npm packument through the policy fetch and a tarball in two passes', async () => {
    const { seen } = stubUpstream();
    const { fetch, cookie, bucket, orgId } = await boot();
    const packument = await fetch(request('/p1/npm/left-pad', { headers: { cookie } }));
    expect(packument.status).toBe(200);
    const body = (await packument.json()) as typeof PACKUMENT;
    const tarball = body.versions['1.0.0'].dist.tarball;
    expect(tarball.startsWith(`${PUBLIC_URL}/p1/npm/`)).toBe(true);
    expect(seen.map((entry) => entry.url)).toEqual(['https://registry.npmjs.org/left-pad']);
    expect(seen[0]!.headers.get('user-agent')).toBe('PackageBroker/2');

    const first = await fetch(request(new URL(tarball).pathname, { headers: { cookie } }));
    expect(first.status).toBe(200);
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(TARBALL);
    const fetched = seen.length;
    const second = await fetch(request(new URL(tarball).pathname, { headers: { cookie } }));
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(TARBALL);
    expect(seen).toHaveLength(fetched);
    const stored = await bucket.head(
      blobStorageKey(orgId as never, sha(TARBALL, 'sha256').toString('hex') as never),
    );
    expect(stored?.size).toBe(TARBALL.byteLength);
  });

  it('refuses anonymous requests before any handler or upstream call', async () => {
    const { stub } = stubUpstream();
    const { fetch } = await boot();
    for (const path of ['/p1/p2/acme/lib.json', '/p1/npm/left-pad', '/p1/packages.json']) {
      expect((await fetch(request(path))).status).toBe(401);
    }
    expect(stub.mock.calls.filter(([input]) => String(input).includes('npmjs'))).toHaveLength(0);
  });

  it('answers a wrong project, an unadmitted name and a bad p2 file with 404 and no upstream call', async () => {
    const { seen } = stubUpstream();
    const { fetch, cookie } = await boot();
    const get = (path: string) => fetch(request(path, { headers: { cookie } }));
    expect((await get('/p2/p2/acme/lib.json')).status).toBe(404);
    expect((await get('/p3/npm/left-pad')).status).toBe(404);
    expect((await get('/p3/npm/@acme%2Fx')).status).toBe(404);
    expect((await get('/p1/p2/acme/lib.txt')).status).toBe(404);
    expect((await get('/p1/p2/acme/missing.json')).status).toBe(404);
    expect(seen).toEqual([]);
  });

  it('admits a scoped name through the scoped-admitting resolver', async () => {
    const { seen } = stubUpstream();
    const { fetch, cookie } = await boot({
      sources: [
        {
          id: 'NR1',
          ecosystem: 'npm',
          type: 'npm_registry',
          url: 'https://npm.acme.test',
          config: '{"scopes":["@acme"]}',
          scope: '@acme',
        },
      ],
    });
    const response = await fetch(request('/p4/npm/@acme%2Fx', { headers: { cookie } }));
    expect(response.status).toBe(200);
    expect(seen.map((entry) => entry.url)).toEqual(['https://npm.acme.test/@acme%2fx']);
    const other = await fetch(request('/p4/npm/@other%2Fx', { headers: { cookie } }));
    expect(other.status).toBe(404);
    expect(seen).toHaveLength(1);
  });

  it('opens a stored credential for the upstream request and never echoes it', async () => {
    const { seen } = stubUpstream();
    const { fetch, cookie, executor, orgId, seed, events } = await boot();
    const store = createCredentialStore({
      repository: createCredentialRepository(executor),
      cipher: createSecretCipher(
        createKeyring(readMasterKeys({ current: KEY, previous: undefined })),
        'credential-encryption',
      ),
      ids: { ulid },
      clock: systemClock,
    });
    const credentialId = await store.put(orgContext(orgId), {
      kind: 'npm_token',
      projectId: null,
      plaintext: new TextEncoder().encode(JSON.stringify({ token: NPM_TOKEN })),
    });
    await seed(
      `INSERT INTO source (id, org_id, project_id, name, ecosystem, type, url, config_json, credential_id, removal_policy)
       VALUES ('NR2', ?, NULL, 'NR2', 'npm', 'npm_registry', 'https://npm.acme.test', '{"scopes":["@cred"]}', ?, 'flag')`,
      [orgId, credentialId],
    );
    await seed(
      "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, 'NR2', 'npm', '@cred/*')",
      [ulid(), orgId],
    );
    await seed(
      "INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES (?, 'P4', 'NR2', 60)",
      [orgId],
    );
    const response = await fetch(request('/p4/npm/@cred%2Fx', { headers: { cookie } }));
    expect(response.status).toBe(200);
    expect(seen[0]!.headers.get('authorization')).toBe(`Bearer ${NPM_TOKEN}`);
    expect(await response.text()).not.toContain(NPM_TOKEN);
    expect(JSON.stringify(events)).not.toContain(NPM_TOKEN);
  });

  it('answers a transient database failure while opening a credential with a 5xx, not a 404', async () => {
    const { seen } = stubUpstream();
    const { worker, environment, cookie, executor, orgId, seed } = await boot();
    const store = createCredentialStore({
      repository: createCredentialRepository(executor),
      cipher: createSecretCipher(
        createKeyring(readMasterKeys({ current: KEY, previous: undefined })),
        'credential-encryption',
      ),
      ids: { ulid },
      clock: systemClock,
    });
    const credentialId = await store.put(orgContext(orgId), {
      kind: 'npm_token',
      projectId: null,
      plaintext: new TextEncoder().encode(JSON.stringify({ token: NPM_TOKEN })),
    });
    await seed(
      `INSERT INTO source (id, org_id, project_id, name, ecosystem, type, url, config_json, credential_id, removal_policy)
       VALUES ('NR3', ?, NULL, 'NR3', 'npm', 'npm_registry', 'https://npm.acme.test', '{"scopes":["@cred"]}', ?, 'flag')`,
      [orgId, credentialId],
    );
    await seed(
      "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, 'NR3', 'npm', '@cred/*')",
      [ulid(), orgId],
    );
    await seed(
      "INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES (?, 'P4', 'NR3', 60)",
      [orgId],
    );
    const db = environment.DB!;
    let failing = false;
    const flaky: Env = {
      ...environment,
      DB: {
        prepare: (sql: string) => {
          if (failing && /from\s+"?credential"?\s+where/i.test(sql))
            throw new Error('D1 transient failure');
          return db.prepare(sql);
        },
        batch: (statements: never) => db.batch(statements),
      },
    };
    const get = () => worker.fetch(request('/p4/npm/@cred%2Fx', { headers: { cookie } }), flaky);
    expect((await worker.fetch(request('/health/live'), flaky)).status).toBe(200);
    failing = true;
    const broken = await get();
    expect(broken.status).toBeGreaterThanOrEqual(500);
    expect(seen).toEqual([]);
    failing = false;
    expect((await get()).status).toBe(200);
  });

  it('answers an undecryptable credential with 503 and Retry-After, and a paused source with 404', async () => {
    const { seen } = stubUpstream();
    const { fetch, cookie, executor, orgId, seed, events } = await boot();
    const store = createCredentialStore({
      repository: createCredentialRepository(executor),
      cipher: createSecretCipher(
        createKeyring(readMasterKeys({ current: KEY, previous: undefined })),
        'credential-encryption',
      ),
      ids: { ulid },
      clock: systemClock,
    });
    const credentialId = await store.put(orgContext(orgId), {
      kind: 'npm_token',
      projectId: null,
      plaintext: new TextEncoder().encode(JSON.stringify({ token: NPM_TOKEN })),
    });
    await seed('UPDATE credential SET nonce = zeroblob(12) WHERE id = ?', [credentialId]);
    await seed(
      `INSERT INTO source (id, org_id, project_id, name, ecosystem, type, url, config_json, credential_id, removal_policy)
       VALUES ('NR4', ?, NULL, 'NR4', 'npm', 'npm_registry', 'https://npm.acme.test', '{"scopes":["@cred"]}', ?, 'flag')`,
      [orgId, credentialId],
    );
    await seed(
      "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, 'NR4', 'npm', '@cred/*')",
      [ulid(), orgId],
    );
    await seed(
      "INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES (?, 'P4', 'NR4', 60)",
      [orgId],
    );
    const get = () => fetch(request('/p4/npm/@cred%2Fx', { headers: { cookie } }));
    for (let i = 0; i < 2; i += 1) {
      const response = await get();
      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('60');
      const body = await response.text();
      expect(body).not.toContain('npm.acme.test');
      expect(body).not.toContain(credentialId);
    }
    expect(seen).toEqual([]);
    expect(
      await executor.all({
        sql: 'SELECT last_error, status, consecutive_failures FROM source WHERE org_id = ? AND id = ?',
        params: [orgId, 'NR4'],
      }),
    ).toEqual([
      { last_error: 'credential_unavailable', status: 'active', consecutive_failures: 0 },
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'source.unavailable',
        reason_code: 'credential_unavailable',
        source_id: 'NR4',
      }),
    );
    expect(JSON.stringify(events)).not.toContain('npm.acme.test');
    expect(JSON.stringify(events)).not.toContain(NPM_TOKEN);
    const hidden = await fetch(request('/p1/npm/@cred%2Fx', { headers: { cookie } }));
    expect(hidden.status).toBe(404);
    expect(hidden.headers.get('retry-after')).toBeNull();
    await seed("UPDATE source SET status = 'paused' WHERE id = 'NR4'", []);
    expect((await get()).status).toBe(404);
    expect(seen).toEqual([]);
  });

  it('fails startup on an invalid registry config without touching the database or upstream', async () => {
    const { stub } = stubUpstream();
    const prepare = vi.fn(() => {
      throw new Error('unexpected database query');
    });
    const worker = createWorker([], {
      platformPorts,
      cacheStorage,
      log: () => undefined,
      registry: { timers: { metadataTtlSeconds: -1 } },
    });
    const env: Env = {
      DB: { prepare, batch: vi.fn(async () => []) },
      STORAGE: {
        head: async () => null,
        get: async () => null,
        put: async () => null,
        delete: async () => undefined,
      } as unknown as R2BucketLike,
      JOBS: { send: async () => undefined, sendBatch: async () => undefined },
      DEPLOYMENT_ID: 'registry-test',
      PB_MASTER_KEY: KEY,
      PB_PUBLIC_URL: PUBLIC_URL,
    };
    const response = await worker.fetch(request('/health/live'), env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'misconfigured' } });
    expect(prepare).not.toHaveBeenCalled();
    expect(stub).not.toHaveBeenCalled();
  });

  it('fails startup when registry config is set without platformPorts or a database', async () => {
    const registry = { timers: { metadataTtlSeconds: 120 } };
    const bare = createWorker([], { registry, log: () => undefined });
    const noDb = createWorker([], { platformPorts, cacheStorage, registry, log: () => undefined });
    for (const worker of [bare, noDb]) {
      const response = await worker.fetch(request('/health/live'), { PB_MASTER_KEY: KEY });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: 'misconfigured' } });
    }
  });

  it('rejects a dist version id that belongs to another package or project', async () => {
    const { fetch, cookie } = await boot();
    const get = (path: string) => fetch(request(path, { headers: { cookie } }));
    const ok = await get(`/p1/dist/acme/lib/${V1}.1.zip`);
    expect(ok.status).toBe(200);
    expect(new TextDecoder().decode(await ok.arrayBuffer())).toBe('zip bytes');
    expect((await get(`/p1/dist/acme/other/${V1}.1.zip`)).status).toBe(404);
    expect((await get(`/p2/dist/acme/lib/${V1}.1.zip`)).status).toBe(404);
  });

  it('answers an archive of an unbindable source with 503 and Retry-After, and of a paused one with 404', async () => {
    const { seen } = stubUpstream();
    const { fetch, cookie, orgId, seed } = await boot();
    const path = `/p1/dist/acme/lib/${VERSION_PREFIX}2.1.zip`;
    await seed(
      "UPDATE version SET metadata_json = json_set(metadata_json, '$.dist.url', ?), dist_type = 'zip' WHERE org_id = ? AND id = ?",
      ['https://composer.acme.test/dist/lib-2.zip', orgId, `${VERSION_PREFIX}2`],
    );
    await seed(`UPDATE source SET config_json = '{"bogus":true}' WHERE org_id = ? AND id = 'S1'`, [
      orgId,
    ]);
    const response = await fetch(request(path, { headers: { cookie } }));
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(await response.text()).not.toContain('composer.acme.test');
    await seed("UPDATE source SET status = 'paused' WHERE org_id = ? AND id = 'S1'", [orgId]);
    const paused = await fetch(request(path, { headers: { cookie } }));
    expect(paused.status).toBe(404);
    expect(paused.headers.get('retry-after')).toBeNull();
    expect(seen).toEqual([]);
  });

  it('hands the Workers waitUntil to the kernel so a deferred revalidation outlives the response', async () => {
    const original = moduleNamespace.createRegistryModule;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const enqueue = vi.fn(async () => {
      await gate;
      return { id: 'job-1', created: true };
    });
    const spy = vi
      .spyOn(moduleNamespace, 'createRegistryModule')
      .mockImplementation((deps) =>
        original({ ...deps, ports: { ...deps.ports, jobs: { enqueue, get: async () => null } } }),
      );
    try {
      const { fetch, cookie, seed, orgId } = await boot({
        sources: [
          {
            id: 'PX1',
            ecosystem: 'composer',
            type: 'packagist_proxy',
            url: 'https://repo.packagist.org',
            project: 'P1',
          },
        ],
      });
      await seed(
        "INSERT INTO package (id, org_id, source_id, ecosystem, name, last_synced_at) VALUES ('K9', ?, 'PX1', 'composer', 'acme/proxied', '2026-10-19T00:00:00.000Z')",
        [orgId],
      );
      await seed(
        "INSERT INTO project_package (org_id, project_id, package_id, origin, ecosystem, name) SELECT input.org_id, input.project_id, input.package_id, input.origin, p.ecosystem, p.name FROM (SELECT ? AS org_id, 'P1' AS project_id, 'K9' AS package_id, 'subscription' AS origin) AS input JOIN package AS p ON p.org_id = input.org_id AND p.id = input.package_id",
        [orgId],
      );
      await seed(
        `INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at,
                              published_at_basis, metadata_json)
         VALUES (?, ?, 'K9', '1.0.0', '1.0.0.0', '2020-01-01T00:00:00.000Z', 'import_time',
                 '{"name":"acme/proxied","source":{"type":"git","url":"https://git.acme.test/p.git","reference":"r"}}')`,
        [`${VERSION_PREFIX}8`, orgId],
      );
      const waited: Promise<unknown>[] = [];
      const ctx: ExecutionContextLike = { waitUntil: (promise) => void waited.push(promise) };
      const response = await fetch(
        request('/p1/p2/acme/proxied.json', { headers: { cookie } }),
        ctx,
      );
      expect(response.status).toBe(200);
      await response.arrayBuffer();
      expect(waited.length).toBeGreaterThanOrEqual(2);
      await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
      let settled = false;
      const all = Promise.all(waited).then(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toBe(false);
      release();
      await all;
      expect(settled).toBe(true);
      expect(enqueue).toHaveBeenCalledWith(
        expect.anything(),
        'core:package-sync:v1',
        expect.objectContaining({ key: 'acme/proxied', sourceId: 'PX1' }),
        expect.anything(),
      );
    } finally {
      spy.mockRestore();
      release();
    }
  });

  it('hands the Workers waitUntil to the npm routes so a stale packument revalidates after the response', async () => {
    stubUpstream();
    const original = moduleNamespace.createRegistryModule;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const enqueue = vi.fn(async () => {
      await gate;
      return { id: 'job-2', created: true };
    });
    const spy = vi
      .spyOn(moduleNamespace, 'createRegistryModule')
      .mockImplementation((deps) =>
        original({ ...deps, ports: { ...deps.ports, jobs: { enqueue, get: async () => null } } }),
      );
    try {
      const { fetch, cookie, seed } = await boot();
      const first = await fetch(request('/p1/npm/left-pad', { headers: { cookie } }));
      expect(first.status).toBe(200);
      await first.arrayBuffer();
      await seed("UPDATE upstream_state SET fresh_until = '2020-01-01T00:00:00.000Z'");
      enqueue.mockClear();
      const waited: Promise<unknown>[] = [];
      const ctx: ExecutionContextLike = { waitUntil: (promise) => void waited.push(promise) };
      const stale = await fetch(request('/p1/npm/left-pad', { headers: { cookie } }), ctx);
      expect(stale.status).toBe(200);
      expect(stale.headers.get('x-broker-stale')).toBe('1');
      await stale.arrayBuffer();
      await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
      let settled = false;
      const all = Promise.all(waited).then(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toBe(false);
      release();
      await all;
      expect(enqueue).toHaveBeenCalledWith(
        expect.anything(),
        'core:package-sync:v1',
        expect.objectContaining({ key: 'left-pad' }),
        expect.anything(),
      );
    } finally {
      spy.mockRestore();
      release();
    }
  });

  it.each([undefined, 'info', 'debug'] as const)(
    'maps every fill path to upstream_refused at log level %s without contacting the sentinel',
    async (level) => {
      const { fetch, cookie, orgId, events, seed } = await boot({
        worker: { observability: level === undefined ? {} : { level } },
        sources: [
          {
            id: 'CP',
            ecosystem: 'composer',
            type: 'packagist_proxy',
            url: 'https://repo.packagist.org',
          },
        ],
      });
      await seed(
        "UPDATE source SET type = 'packagist_proxy', url = 'https://repo.packagist.org' WHERE org_id = ? AND id = 'S1'",
        [orgId],
      );
      const sentinel = vi.fn();
      let refusing = false;
      const normal = globalThis.fetch;
      vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('sentinel.invalid') || url.includes('127.0.0.1')) {
          sentinel();
          throw new Error('sentinel reached');
        }
        if (refusing) {
          if (url.includes('~dev.json')) return Response.json({ packages: {} });
          return Response.redirect('https://sentinel.invalid/private?token=private-secret', 302);
        }
        return normal(input, init);
      });
      const metadata = await fetch(request('/p1/npm/left-pad', { headers: { cookie } }));
      expect(metadata.status).toBe(200);
      const npm = (await metadata.json()) as {
        versions: Record<string, { dist: { tarball: string } }>;
      };
      await seed(
        "UPDATE version SET metadata_json = json_set(metadata_json, '$.dist.url', ?), dist_type = 'zip' WHERE org_id = ? AND id = ?",
        ['https://127.0.0.1/sentinel?token=private-secret', orgId, `${VERSION_PREFIX}2`],
      );
      refusing = true;
      for (const [path, sourceId, projectId, reason] of [
        [`/p1/dist/acme/lib/${VERSION_PREFIX}2.1.zip`, 'S1', 'P1', 'blocked_address'],
        ['/p4/p2/acme/fresh.json', 'CP', 'P4', 'redirect_refused'],
        [new URL(npm.versions['1.0.0']!.dist.tarball).pathname, 'NX1', 'P1', 'destination'],
        ['/p1/npm/fresh', 'NX1', 'P1', 'destination'],
      ]) {
        const before = events.length;
        const response = await fetch(request(path!, { headers: { cookie } }));
        expect(response.status, path).toBe(502);
        const body = await response.text();
        expect(body).toContain('upstream_refused');
        expect(body).not.toMatch(/https?:|sentinel|127\.0\.0\.1|private-secret/);
        const emitted = events
          .slice(before)
          .map((entry) =>
            typeof entry === 'string'
              ? (JSON.parse(entry) as Record<string, unknown>)
              : (entry as Record<string, unknown>),
          );
        const refused = emitted.filter((entry) => entry['event'] === 'upstream.refused');
        expect(refused, path).toHaveLength(level === 'debug' ? 1 : 0);
        if (level === 'debug')
          expect(refused[0]).toMatchObject({
            level: 'debug',
            source_id: sourceId,
            project_id: projectId,
            reason_code: `upstream.${reason}`,
          });
        expect(JSON.stringify(emitted)).not.toMatch(/sentinel|127\.0\.0\.1|private-secret/);
      }
      expect(sentinel).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['over the blob store cap', 'store'],
    ['declared over the policy fetch cap', 'declared'],
  ] as const)(
    'refuses a Composer dist %s with 502, quarantines the version and stores nothing',
    async (_label, mode) => {
      const { fetch, cookie, orgId, events, seed, bucket, executor } = await boot();
      const version = `${VERSION_PREFIX}2`;
      await seed(
        "UPDATE source SET type = 'packagist_proxy', url = 'https://repo.packagist.org' WHERE org_id = ? AND id = 'S1'",
        [orgId],
      );
      await seed(
        "UPDATE version SET metadata_json = json_set(metadata_json, '$.dist.url', ?), dist_type = 'zip' WHERE org_id = ? AND id = ?",
        ['https://codeload.github.com/acme/lib/legacy.zip/r2', orgId, version],
      );
      const archives: string[] = [];
      const normal = globalThis.fetch;
      vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
        const url = new Request(input, init).url;
        if (!url.startsWith('https://codeload.github.com/')) return normal(input, init);
        archives.push(url);
        return mode === 'store'
          ? new Response(new Uint8Array(1024 * 1024 + 1).fill(7))
          : new Response(new TextEncoder().encode('zip bytes'), {
              headers: { 'content-length': String(64 * 1024 * 1024 + 1) },
            });
      });
      const keys = [...bucket.objects.keys()];
      const blobs = async () =>
        executor.all<{ id: string }>({
          sql: 'SELECT id FROM blob WHERE org_id = ? ORDER BY id',
          params: [orgId],
        });
      const blobsBefore = await blobs();
      const before = events.length;
      const path = `/p1/dist/acme/lib/${version}.1.zip`;

      const response = await fetch(request(path, { headers: { cookie } }));
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ error: { code: 'bad_gateway' } });
      expect(archives.length).toBeGreaterThan(0);
      expect(
        await executor.all({
          sql: 'SELECT status, blob_id FROM version WHERE org_id = ? AND id = ?',
          params: [orgId, version],
        }),
      ).toEqual([{ status: 'quarantined', blob_id: null }]);
      expect(await blobs()).toEqual(blobsBefore);
      expect([...bucket.objects.keys()]).toEqual(keys);
      const quarantined = events
        .slice(before)
        .map((entry) =>
          typeof entry === 'string'
            ? (JSON.parse(entry) as Record<string, unknown>)
            : (entry as Record<string, unknown>),
        )
        .filter((entry) => entry['event'] === 'dist.quarantined');
      expect(quarantined).toEqual([
        expect.objectContaining({
          level: 'warn',
          reason_code: 'archive_too_large',
          source_id: 'S1',
          package_key: 'acme/lib',
        }),
      ]);

      const fetched = archives.length;
      expect((await fetch(request(path, { headers: { cookie } }))).status).not.toBe(200);
      expect(archives).toHaveLength(fetched);
    },
  );

  it('refuses sources that point at loopback, link-local and the broker itself without fetching', async () => {
    const { stub } = stubUpstream();
    const hosts = ['https://127.0.0.1', 'https://169.254.169.254', PUBLIC_URL];
    const { fetch, cookie, events } = await boot({
      sources: hosts.map((url, index) => ({
        id: `NG${index}`,
        ecosystem: 'npm',
        type: 'npm_registry',
        url,
        config: `{"scopes":["@g${index}"]}`,
        scope: `@g${index}`,
      })),
    });
    for (let index = 0; index < hosts.length; index += 1) {
      const before = events.length;
      const response = await fetch(request(`/p4/npm/@g${index}%2Fx`, { headers: { cookie } }));
      expect(response.status, hosts[index]).toBe(503);
      expect(response.headers.get('retry-after'), hosts[index]).toBe('60');
      const host = new URL(hosts[index]!).host;
      expect(await response.text(), hosts[index]).not.toContain(host);
      const emitted = events.slice(before);
      expect(JSON.stringify(emitted), hosts[index]).not.toContain(host);
      expect(emitted, hosts[index]).toContainEqual(
        expect.objectContaining({
          event: 'source.unavailable',
          reason_code: 'policy_denied',
          source_id: `NG${String(index)}`,
        }),
      );
    }
    const reached = stub.mock.calls.filter(([input]) => {
      const host = new Request(input).url;
      return (
        host.startsWith('https://127.0.0.1') ||
        host.startsWith('https://169.254.') ||
        host.startsWith(`${PUBLIC_URL}/@g`)
      );
    });
    expect(reached).toEqual([]);
  });

  it('flushes trailing blob access touches inside waitUntil', async () => {
    const { fetch, cookie, executor } = await boot();
    const lastAccessed = async () =>
      (
        await executor.all<{ last_accessed_at: string | null }>({
          sql: "SELECT last_accessed_at FROM blob WHERE id = 'B1'",
          params: [],
        })
      )[0]?.last_accessed_at ?? null;
    expect(await lastAccessed()).toBeNull();
    const waited: Promise<unknown>[] = [];
    const ctx: ExecutionContextLike = { waitUntil: (promise) => void waited.push(promise) };
    const response = await fetch(
      request(`/p1/dist/acme/lib/${V1}.1.zip`, { headers: { cookie } }),
      ctx,
    );
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    await Promise.all(waited);
    expect(await lastAccessed()).not.toBeNull();
  });

  it('registers the registry module visibility port as the kernel package resolver', async () => {
    const original = moduleNamespace.createRegistryModule;
    const modules: ReturnType<typeof original>[] = [];
    const moduleSpy = vi
      .spyOn(moduleNamespace, 'createRegistryModule')
      .mockImplementation((deps) => {
        const created = original(deps);
        modules.push(created);
        return created;
      });
    const kernelSpy = vi.spyOn(kernelModule, 'createKernel');
    try {
      const { worker, environment } = await boot();
      await worker.services(environment);
      expect(modules).toHaveLength(1);
      const options = kernelSpy.mock.calls.at(-1)![0];
      expect(options.packageResolver).toBe(modules[0]!.visibilityPort);
    } finally {
      moduleSpy.mockRestore();
      kernelSpy.mockRestore();
    }
  });

  it('keeps the assembly table in step with the routes the kernel mounts', async () => {
    const spy = vi.spyOn(kernelModule, 'createKernel');
    try {
      const { worker, environment } = await boot();
      await worker.services(environment);
      const options = spy.mock.calls.at(-1)![0];
      const mounted = (options.ecosystemRoutes ?? []).map((route) => route.path);
      expect(options.packageResolver).toBeDefined();
      for (const entry of REGISTRY_ASSEMBLY) {
        expect(entry.ownerPacket).toMatch(/^T\d+/);
        for (const path of entry.routes) expect(mounted).toContain(path);
      }
      expect(REGISTRY_ASSEMBLY.flatMap((entry) => entry.jobs)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('npm audit matrix', () => {
  afterEach(() => vi.restoreAllMocks());
  const endpoint = '/p1/npm/-/npm/v1/security/advisories/bulk';
  let app: Awaited<ReturnType<typeof boot>>;
  async function audit(body: unknown) {
    return app.fetch(
      request(endpoint, {
        method: 'POST',
        headers: {
          cookie: app.cookie,
          origin: PUBLIC_URL,
          'x-csrf-token': app.cookie.split('__Host-pb_csrf=')[1]!,
          'content-type': 'application/json',
          traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
        },
        body: JSON.stringify(body),
      }),
    );
  }

  it('forwards verified public pairs and refuses disclosure after a private claim or cap', async () => {
    const repositorySpy = vi.spyOn(vulnerabilityModule, 'createVulnerabilityRepository');
    let failEvidence = false;
    const originalExecutor = d1Module.createD1Executor;
    const executorSpy = vi.spyOn(d1Module, 'createD1Executor').mockImplementation((db) => {
      const executor = originalExecutor(db);
      return {
        driver: executor.driver,
        all: (statement) => executor.all(statement),
        batch: (statements) => {
          if (
            failEvidence &&
            statements.some((statement) => statement.sql.includes('evidence_bytes'))
          )
            throw new Error('evidence unavailable');
          return executor.batch(statements);
        },
      };
    });
    const sent: { body: unknown; headers: Headers }[] = [];
    const remote = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(input)).hostname !== 'registry.npmjs.org') return realFetch(input, init);
      const request = new Request(input, init);
      if (request.method !== 'POST') return remote(input, init);
      sent.push({ body: await request.json(), headers: request.headers });
      return Response.json({ 'left-pad': [{ id: 42 }], sentinel: [{ id: 43 }] });
    });
    app = await boot();
    executorSpy.mockRestore();
    expect(repositorySpy.mock.calls.length).toBeGreaterThan(0);
    for (const call of repositorySpy.mock.calls) expect(call[1]).toBe(systemClock);
    repositorySpy.mockRestore();
    expect(
      (await app.fetch(request('/p1/npm/left-pad', { headers: { cookie: app.cookie } }))).status,
    ).toBe(200);
    const response = await audit({ 'left-pad': ['1.0.0'], '@private/hidden': ['1.0.0'] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ 'left-pad': [{ id: 42 }] });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(sent.map(({ body }) => body)).toEqual([{ 'left-pad': ['1.0.0'] }]);
    for (const { headers } of sent) {
      expect(headers.has('cookie')).toBe(false);
      expect(headers.has('authorization')).toBe(false);
      expect(headers.has('x-csrf-token')).toBe(false);
      expect(headers.get('user-agent')).toBe('PackageBroker/2');
      expect(headers.has('traceparent')).toBe(false);
    }
    failEvidence = true;
    sent.length = 0;
    const unavailable = await audit({ 'left-pad': ['1.0.0'] });
    expect(unavailable.status).toBe(502);
    expect(await unavailable.json()).toMatchObject({ code: 'upstream_error' });
    expect(sent).toEqual([]);
    failEvidence = false;
    await app.seed(
      "INSERT INTO source (id, org_id, name, ecosystem, type, url, config_json) VALUES ('PRIVATE', ?, 'Private', 'npm', 'npm_registry', 'https://private.test', '{\"scopes\":[\"@private\"]}')",
      [app.orgId],
    );
    await app.seed(
      "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('HIDDEN', ?, 'PRIVATE', 'npm', 'left-pad')",
      [app.orgId],
    );
    sent.length = 0;
    const hiddenHolder = await audit({ 'left-pad': ['1.0.0'] });
    expect(hiddenHolder.status).toBe(200);
    expect(await hiddenHolder.json()).toEqual({});
    expect(sent).toEqual([]);
    await app.seed("UPDATE source SET status = 'paused' WHERE org_id = ? AND id = 'PRIVATE'", [
      app.orgId,
    ]);
    const pausedHolder = await audit({ 'left-pad': ['1.0.0'] });
    expect(pausedHolder.status).toBe(200);
    expect(await pausedHolder.json()).toEqual({});
    expect(sent).toEqual([]);
    await app.seed("DELETE FROM package WHERE org_id = ? AND id = 'HIDDEN'", [app.orgId]);
    await app.seed(
      "INSERT INTO source (id, org_id, name, ecosystem, type, url) VALUES ('CLAIM', ?, 'Claim', 'npm', 'vcs', 'https://private.test/repo.git')",
      [app.orgId],
    );
    await app.seed(
      'INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, ?, ?, ?)',
      [ulid(), app.orgId, 'CLAIM', 'npm', 'left-pad'],
    );
    sent.length = 0;
    const filtered = await audit({ 'left-pad': ['1.0.0'], '@private/hidden': ['1.0.0'] });
    expect(filtered.status).toBe(200);
    expect(await filtered.json()).toEqual({});
    expect(sent).toEqual([]);
    sent.length = 0;
    const privateOnly = await audit({ '@private/hidden': ['1.0.0'] });
    expect(privateOnly.status).toBe(200);
    expect(await privateOnly.json()).toEqual({});
    for (const body of [
      Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`pkg-${i}`, ['1.0.0']])),
      { 'left-pad': Array.from({ length: 2001 }, (_, i) => `1.0.${i}`) },
    ]) {
      const capped = await audit(body);
      expect(capped.status).toBe(413);
      expect(await capped.json()).toMatchObject({ code: 'payload_too_large' });
    }
    expect(sent).toEqual([]);
    expect(JSON.stringify(app.events)).not.toMatch(/@private|admin@example|__Host-pb_session/);
  });

  it('distinguishes no attached proxy from the disabled off switch without outbound traffic', async () => {
    const { seen } = stubUpstream();
    app = await boot();
    await app.seed(
      'DELETE FROM project_source WHERE org_id = ? AND project_id = ? AND source_id = ?',
      [app.orgId, 'P1', 'NX1'],
    );
    const absent = await audit({ 'left-pad': ['1.0.0'] });
    expect(absent.status).toBe(501);
    expect(await absent.json()).toMatchObject({
      code: 'unsupported',
      error: 'npm audit requires an npmjs.org proxy source in this project',
    });
    app = await boot({ registry: { npmAudit: { enabled: false } } });
    const disabled = await audit({ 'left-pad': ['1.0.0'] });
    expect(disabled.status).toBe(501);
    expect(await disabled.json()).toMatchObject({ code: 'npm_audit_disabled' });
    expect(seen).toEqual([]);
  });
});
