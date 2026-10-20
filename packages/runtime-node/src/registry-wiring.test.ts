import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newSessionSecrets } from '@package-broker/core/auth/session';
import { orgContext, type SqlExecutor, type SqlValue } from '@package-broker/core/db/port';
import { systemClock, ulid } from '@package-broker/core/ids';
import { createBlobStore, createBlobUploadAdmission } from '@package-broker/core/platform/blob';
import type { Jobs } from '@package-broker/core/platform/jobs';
import type { FetchLike } from '@package-broker/core/platform/tracing';
import { resolveRegistryConfig } from '@package-broker/core/registry/registry-config';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { createSecretCipher } from '@package-broker/core/secrets/cipher';
import { createCredentialStore } from '@package-broker/core/secrets/credential-store';
import { parseMasterKey } from '@package-broker/core/secrets/master-key';
import { createBlobRepository } from '@package-broker/db-sqlite/repositories/blob';
import { createCredentialRepository } from '@package-broker/db-sqlite/repositories/credential';
import { createJobRepository } from '@package-broker/db-sqlite/repositories/job';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import {
  discoveredMigrations,
  openMigratedDatabase,
  type MigratedDatabase,
} from '@package-broker/db-sqlite/testing/migrated-database';
import { openFilesystemByteStore } from './blob/filesystem.js';
import { createLruCache } from './cache/lru.js';
import { createNodeServer, type NodeBroker } from './index.js';
import { DnsGuardError } from './sources/dns-guard.js';
import { StartupConfigError, startNode } from './startup.js';

const KEY = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const OTHER_KEY = 'pbmk_v1_HxwdHBsaGRgXFhUUExIREA8ODQwLCgkIBwYFBAMCAQA';
const ORIGIN = 'https://broker.test';
const TARBALL = new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
const ZIP = new Uint8Array([0x50, 0x4b, 3, 4, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
const PUBLISHED = '2026-01-01T00:00:00.000Z';

const integrity = (bytes: Uint8Array): string =>
  `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

function packument(name: string): string {
  return JSON.stringify({
    name,
    'dist-tags': { latest: '1.0.0' },
    versions: {
      '1.0.0': {
        name,
        version: '1.0.0',
        dist: {
          tarball: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`,
          integrity: integrity(TARBALL),
        },
      },
    },
    time: { '1.0.0': PUBLISHED },
  });
}

function composerP2(name: string): string {
  return JSON.stringify({
    minified: 'composer/2.0',
    packages: {
      [name]: [
        {
          name,
          version: '1.0.0',
          version_normalized: '1.0.0.0',
          type: 'library',
          time: '2026-01-01T00:00:00+00:00',
          dist: {
            type: 'zip',
            url: `https://api.github.com/repos/${name}/zipball/abc123`,
            reference: 'abc123',
            shasum: '',
          },
        },
      ],
    },
  });
}

interface Upstream {
  readonly urls: string[];
  readonly headers: Map<string, Headers>;
  readonly transport: FetchLike;
}

function upstream(): Upstream {
  const urls: string[] = [];
  const headers = new Map<string, Headers>();
  const transport: FetchLike = async (input, init) => {
    const request = new Request(input, init);
    urls.push(request.url);
    headers.set(request.url, request.headers);
    const url = new URL(request.url);
    const json = (body: string) =>
      new Response(body, {
        headers: { 'content-type': 'application/json', etag: '"v1"' },
      });
    if (url.hostname === 'registry.npmjs.org' && url.pathname.endsWith('.tgz')) {
      return new Response(TARBALL, { headers: { 'content-type': 'application/octet-stream' } });
    }
    if (url.hostname === 'registry.npmjs.org') {
      return json(packument(decodeURIComponent(url.pathname.slice(1))));
    }
    if (url.hostname === 'repo.packagist.org') {
      const name = url.pathname.replace(/^\/p2\//, '').replace(/(~dev)?\.json$/, '');
      return url.pathname.endsWith('~dev.json')
        ? json(JSON.stringify({ minified: 'composer/2.0', packages: { [name]: [] } }))
        : json(composerP2(name));
    }
    if (url.hostname === 'codeload.github.com') {
      return new Response(ZIP, { headers: { 'content-type': 'application/zip' } });
    }
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  };
  return { urls, headers, transport };
}

type NodeSeams = NonNullable<Parameters<typeof createNodeServer>[2]>;

function spied(executor: SqlExecutor, statements: string[]): SqlExecutor {
  return {
    driver: executor.driver,
    all: (statement) => {
      statements.push(statement.sql);
      return executor.all(statement);
    },
    batch: (batch) => {
      for (const statement of batch) statements.push(statement.sql);
      return executor.batch(batch);
    },
  };
}

describe('node registry wiring', () => {
  let db: MigratedDatabase;
  let directory: string;
  let broker: NodeBroker | undefined;
  let orgId: string;
  let projectId: string;
  let cookie: string;
  let sources: { npm: string; composer: string };
  let logged: string[];

  async function sql<T extends object = object>(
    statement: string,
    params: readonly SqlValue[] = [],
  ): Promise<T[]> {
    return db.executor.all<T>({ sql: statement, params: [...params] });
  }

  beforeEach(async () => {
    logged = [];
    db = await openMigratedDatabase();
    directory = await realpath(await mkdtemp(join(tmpdir(), 'pb-registry-wiring-')));
    const org = await createOrganizationBootstrap(db.executor).bootstrap({
      id: ulid(),
      slug: 'acme',
      name: 'Acme',
      now: new Date().toISOString(),
    });
    orgId = org.id;
    projectId = ulid();
    const userId = ulid();
    const roleId = ulid();
    const secrets = await newSessionSecrets();
    cookie = `__Host-pb_session=${secrets.secret}; __Host-pb_csrf=${secrets.csrf}`;
    await sql('INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)', [
      userId,
      orgId,
      'reader@example.test',
    ]);
    const credentialId = ulid();
    await sql(
      "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES (?, ?, 'totp', ?, zeroblob(12), 1, 'fixture')",
      [credentialId, orgId, new Uint8Array([1])],
    );
    await sql(
      "INSERT INTO local_login (user_id, org_id, password_hash, totp_credential_id, totp_enabled_at, last_login_at) VALUES (?, ?, 'pbkdf2-sha256$fixture', ?, ?, ?)",
      [userId, orgId, credentialId, new Date().toISOString(), new Date().toISOString()],
    );
    await sql(
      "INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, 'fixture', 'Fixture', 'organization', 1)",
      [roleId, orgId],
    );
    await sql('INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)', [
      orgId,
      roleId,
      'project:packages:read',
    ]);
    await sql(
      "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id) VALUES (?, ?, 'email', ?, 'organization', ?)",
      [ulid(), orgId, 'reader@example.test', roleId],
    );
    await sql(
      'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      [
        ulid(),
        orgId,
        userId,
        secrets.secretHash,
        secrets.csrfHash,
        new Date(Date.now() + 3_600_000).toISOString(),
      ],
    );
    await sql("INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, 'alpha', 'Alpha')", [
      projectId,
      orgId,
    ]);
    await sql("INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, 'beta', 'Beta')", [
      ulid(),
      orgId,
    ]);
    sources = { npm: ulid(), composer: ulid() };
    await sql(
      "INSERT INTO source (id, org_id, name, ecosystem, type, url, default_visible_to_new_projects) VALUES (?, ?, 'npmjs', 'npm', 'npmjs_proxy', 'https://registry.npmjs.org', 1)",
      [sources.npm, orgId],
    );
    await sql(
      "INSERT INTO source (id, org_id, name, ecosystem, type, url, default_visible_to_new_projects) VALUES (?, ?, 'packagist', 'composer', 'packagist_proxy', 'https://repo.packagist.org', 1)",
      [sources.composer, orgId],
    );
    for (const source of Object.values(sources)) {
      for (const project of await sql<{ id: string }>('SELECT id FROM project WHERE org_id = ?', [
        orgId,
      ])) {
        await sql('INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)', [
          orgId,
          project.id,
          source,
        ]);
      }
    }
  });

  afterEach(async () => {
    await broker?.close();
    broker = undefined;
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function boot(
    transport: FetchLike,
    extra: {
      jobs?: Jobs;
      executor?: SqlExecutor;
      closeDatabase?: () => Promise<void>;
      observeCredentials?: NodeSeams['observeCredentials'];
    } = {},
  ): Promise<NodeBroker> {
    const byteStore = await openFilesystemByteStore({ root: join(directory, 'blobs') });
    broker = createNodeServer(
      [],
      {
        executor: extra.executor ?? db.executor,
        ...(extra.closeDatabase === undefined ? {} : { closeDatabase: extra.closeDatabase }),
        auth: {
          keyring: createKeyring([parseMasterKey(KEY, 'PB_MASTER_KEY')]),
          publicOrigin: ORIGIN,
          env: {},
        },
        platformServices: {
          blob: createBlobStore(
            byteStore,
            createBlobRepository(db.executor, { purgeLeaseSeconds: 900 }),
            { admission: createBlobUploadAdmission(), maxBytes: 1_048_576 },
          ),
          cache: createLruCache({}),
          jobStore: createJobRepository(db.executor),
        },
        registry: { config: resolveRegistryConfig(undefined, 'node', ORIGIN) },
        log: (record) => void logged.push(JSON.stringify(record)),
      },
      {
        transport,
        ...(extra.jobs === undefined ? {} : { jobs: extra.jobs }),
        ...(extra.observeCredentials === undefined
          ? {}
          : { observeCredentials: extra.observeCredentials }),
      },
    );
    await broker.ready();
    return broker;
  }

  async function get(
    path: string,
    headers: Record<string, string> = { cookie },
  ): Promise<Response> {
    const kernel = await broker!.ready();
    return kernel.fetch(new Request(`${ORIGIN}${path}`, { headers }));
  }

  const brokerPath = (url: string): string => new URL(url).pathname;

  describe('built output', () => {
    it('serves Composer metadata and dist for a seeded project', async () => {
      const remote = upstream();
      await boot(remote.transport);

      expect((await get('/alpha/packages.json', {})).status).toBe(401);
      const root = await get('/alpha/packages.json');
      expect(root.status).toBe(200);
      expect(await root.json()).toMatchObject({ 'metadata-url': '/alpha/p2/%package%.json' });

      const metadata = await get('/alpha/p2/acme/lib.json');
      expect(metadata.status).toBe(200);
      const body = (await metadata.json()) as {
        packages: Record<string, { dist: { url: string; type: string } }[]>;
      };
      const dist = body.packages['acme/lib']?.[0]?.dist;
      expect(dist?.url.startsWith(`${ORIGIN}/alpha/dist/acme/lib/`)).toBe(true);
      expect(remote.urls).toContain('https://repo.packagist.org/p2/acme/lib.json');

      const archive = await get(brokerPath(dist!.url));
      expect(archive.status).toBe(200);
      expect(new Uint8Array(await archive.arrayBuffer())).toEqual(ZIP);
    });

    it('serves an npm packument and tarball through the guarded policy fetch', async () => {
      const remote = upstream();
      await boot(remote.transport);

      expect((await get('/alpha/npm/left-pad', {})).status).toBe(401);
      const response = await get('/alpha/npm/left-pad');
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        versions: Record<string, { dist: { tarball: string } }>;
      };
      const tarball = body.versions['1.0.0']?.dist.tarball ?? '';
      expect(tarball.startsWith(`${ORIGIN}/alpha/npm/`)).toBe(true);

      const archive = await get(brokerPath(tarball));
      expect(archive.status).toBe(200);
      expect(new Uint8Array(await archive.arrayBuffer())).toEqual(TARBALL);
    });

    it('answers a version id from another package or project with the uniform 404', async () => {
      const remote = upstream();
      await boot(remote.transport);
      await sql("INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, 'gamma', 'Gamma')", [
        ulid(),
        orgId,
      ]);
      const distOf = async (name: string): Promise<string> => {
        const response = await get(`/alpha/p2/${name}.json`);
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          packages: Record<string, { dist: { url: string } }[]>;
        };
        return brokerPath(body.packages[name]![0]!.dist.url);
      };
      const own = await distOf('acme/lib');
      const other = await distOf('acme/other');
      expect((await get(own)).status).toBe(200);

      const unknown = await get(own.replace(/[0-9A-HJKMNP-TV-Z]{26}/, ulid()));
      expect(unknown.status).toBe(404);
      const normalise = async (response: Response) =>
        (await response.text()).replace(/"requestId":"[^"]*"/, '');
      const unknownBody = await normalise(unknown);

      const borrowedVersion = other.replace('/acme/other/', '/acme/lib/');
      const otherProject = own.replace('/alpha/', '/gamma/');
      for (const path of [borrowedVersion, otherProject]) {
        const refused = await get(path);
        expect(refused.status).toBe(404);
        expect(await normalise(refused)).toBe(unknownBody);
      }
    });

    it('registers the scoped-admitting resolver so an unseen covered scoped name reaches npm', async () => {
      const remote = upstream();
      const scoped = ulid();
      await sql(
        "INSERT INTO source (id, org_id, name, ecosystem, type, url, config_json, default_visible_to_new_projects) VALUES (?, ?, 'acme-npm', 'npm', 'npm_registry', 'https://npm.acme.test', ?, 1)",
        [scoped, orgId, JSON.stringify({ scopes: ['@acme'] })],
      );
      await sql(
        "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, ?, 'npm', '@acme/*')",
        [ulid(), orgId, scoped],
      );
      await sql('INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)', [
        orgId,
        projectId,
        scoped,
      ]);
      await boot(remote.transport);

      await get('/alpha/npm/@acme%2Fwidget');
      expect(remote.urls.some((url) => url.startsWith('https://npm.acme.test/'))).toBe(true);
      remote.urls.length = 0;
      await get('/alpha/npm/@other%2Fwidget');
      expect(remote.urls.some((url) => url.startsWith('https://npm.acme.test/'))).toBe(false);
    });
  });

  describe('credentialed sources', () => {
    async function scopedSource(credentialId: string | null): Promise<void> {
      const scoped = ulid();
      await sql(
        'INSERT INTO source (id, org_id, name, ecosystem, type, url, config_json, credential_id, default_visible_to_new_projects) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)',
        [
          scoped,
          orgId,
          'acme-npm',
          'npm',
          'npm_registry',
          'https://npm.acme.test',
          JSON.stringify({ scopes: ['@acme'] }),
          credentialId,
        ],
      );
      await sql(
        "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, ?, 'npm', '@acme/*')",
        [ulid(), orgId, scoped],
      );
      await sql('INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)', [
        orgId,
        projectId,
        scoped,
      ]);
    }

    async function sealed(key: string): Promise<string> {
      const store = createCredentialStore({
        repository: createCredentialRepository(db.executor),
        cipher: createSecretCipher(
          createKeyring([parseMasterKey(key, 'PB_MASTER_KEY')]),
          'credential-encryption',
        ),
        ids: { ulid },
        clock: systemClock,
      });
      return store.put(orgContext(orgId), {
        kind: 'bearer',
        projectId: null,
        plaintext: new TextEncoder().encode(JSON.stringify({ token: 'tok-registry-secret-1' })),
      });
    }

    it('opens the stored credential and binds it to the source origin only', async () => {
      const remote = upstream();
      await scopedSource(await sealed(KEY));
      await boot(remote.transport);

      await get('/alpha/npm/@acme%2Fwidget');
      const sent = [...remote.headers].filter(([url]) => url.startsWith('https://npm.acme.test/'));
      expect(sent.length).toBeGreaterThan(0);
      for (const [, headers] of sent) {
        expect(headers.get('authorization')).toBe('Bearer tok-registry-secret-1');
      }
      for (const [url, headers] of remote.headers) {
        if (!url.startsWith('https://npm.acme.test/')) {
          expect(headers.get('authorization')).toBeNull();
        }
      }
      expect(logged.join('\n')).not.toContain('tok-registry-secret-1');
    });

    it('treats a credential that cannot be opened as an unavailable source without leaking it', async () => {
      const remote = upstream();
      await scopedSource(await sealed(OTHER_KEY));
      await boot(remote.transport);

      const response = await get('/alpha/npm/@acme%2Fwidget');
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('tok-registry-secret-1');
      expect(remote.urls.some((url) => url.startsWith('https://npm.acme.test/'))).toBe(false);
      expect(logged.join('\n')).not.toContain('tok-registry-secret-1');
    });

    it('treats a source with a malformed url as unavailable without opening its credential', async () => {
      const statements: string[] = [];
      let access: Parameters<NonNullable<NodeSeams['observeCredentials']>>[0] | undefined;
      await boot(upstream().transport, {
        executor: spied(db.executor, statements),
        observeCredentials: (opened) => {
          access = opened;
        },
      });
      const credentialId = await sealed(KEY);
      statements.length = 0;

      const opened = await access!.forSource(orgContext(orgId), {
        credentialId,
        url: 'not a url',
      } as never);
      expect(opened).toBeNull();
      expect(statements.filter((statement) => /ciphertext/.test(statement))).toEqual([]);

      const valid = await access!.forSource(orgContext(orgId), {
        credentialId,
        url: 'https://npm.acme.test',
      } as never);
      expect(valid).not.toBeNull();
      expect(statements.filter((statement) => /ciphertext/.test(statement))).not.toEqual([]);
    });
  });

  describe('deferred background work', () => {
    it('keeps a deferred revalidation running past the response and drains it on close', async () => {
      const remote = upstream();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const enqueue = vi.fn(async () => {
        await gate;
        return { id: 'job-1', created: true };
      });
      await boot(remote.transport, { jobs: { enqueue, get: async () => null } });

      expect((await get('/alpha/p2/acme/lib.json')).status).toBe(200);
      await sql("UPDATE upstream_state SET fresh_until = '2000-01-01T00:00:00.000Z'");

      const stale = await get('/alpha/p2/acme/lib.json');
      expect(stale.status).toBe(200);
      await stale.arrayBuffer();
      await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));

      const closing = broker!.close();
      const early = await Promise.race([
        closing.then(() => 'closed'),
        new Promise((resolve) => setTimeout(() => resolve('pending'), 50)),
      ]);
      expect(early).toBe('pending');
      release();
      await closing;
    });

    it('flushes a pending access touch before the database closes', async () => {
      const remote = upstream();
      const statements: string[] = [];
      let closed = false;
      const touches = { before: 0, after: 0 };
      const executor = spied(db.executor, statements);
      const observed: SqlExecutor = {
        driver: executor.driver,
        all: (statement) => executor.all(statement),
        batch: (batch) => {
          if (batch.some((statement) => statement.sql.includes('set "last_accessed_at"'))) {
            if (closed) touches.after += 1;
            else touches.before += 1;
          }
          return executor.batch(batch);
        },
      };
      await boot(remote.transport, {
        executor: observed,
        closeDatabase: async () => {
          closed = true;
        },
      });
      const metadata = (await (await get('/alpha/p2/acme/lib.json')).json()) as {
        packages: Record<string, { dist: { url: string } }[]>;
      };
      const dist = brokerPath(metadata.packages['acme/lib']![0]!.dist.url);
      expect((await get(dist)).status).toBe(200);
      expect((await get(dist)).status).toBe(200);
      expect(touches).toEqual({ before: 0, after: 0 });

      await broker!.close();
      expect(closed).toBe(true);
      expect(touches.before).toBeGreaterThan(0);
      expect(touches.after).toBe(0);
    });

    it('tracks the npm stale-while-revalidate background work through the execution port', async () => {
      const remote = upstream();
      const enqueue = vi.fn(async () => ({ id: 'job-1', created: true }));
      await boot(remote.transport, { jobs: { enqueue, get: async () => null } });
      expect((await get('/alpha/npm/left-pad')).status).toBe(200);
      await sql("UPDATE upstream_state SET fresh_until = '2000-01-01T00:00:00.000Z'");

      const scheduled: Promise<unknown>[] = [];
      const kernel = await broker!.ready();
      const response = await kernel.fetch(
        new Request(`${ORIGIN}/alpha/npm/left-pad`, { headers: { cookie } }),
        { waitUntil: (promise) => void scheduled.push(promise) },
      );
      expect(response.status).toBe(200);
      expect(scheduled).toHaveLength(1);
      await Promise.all(scheduled);
      expect(enqueue).toHaveBeenCalledTimes(1);
    });

    it('hands the deferred work to an execution port when the caller supplies one', async () => {
      const remote = upstream();
      const enqueue = vi.fn(async () => ({ id: 'job-1', created: true }));
      await boot(remote.transport, { jobs: { enqueue, get: async () => null } });
      expect((await get('/alpha/p2/acme/lib.json')).status).toBe(200);
      await sql("UPDATE upstream_state SET fresh_until = '2000-01-01T00:00:00.000Z'");

      const scheduled: Promise<unknown>[] = [];
      const kernel = await broker!.ready();
      const response = await kernel.fetch(
        new Request(`${ORIGIN}/alpha/p2/acme/lib.json`, { headers: { cookie } }),
        { waitUntil: (promise) => void scheduled.push(promise) },
      );
      expect(response.status).toBe(200);
      expect(scheduled).toHaveLength(1);
      await Promise.all(scheduled);
      expect(enqueue).toHaveBeenCalledTimes(1);
    });
  });
});

describe('node registry startup', () => {
  let directory: string;
  const running: NodeBroker[] = [];

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'pb-registry-start-')));
  });

  afterEach(async () => {
    for (const broker of running.splice(0)) await broker.close();
    await rm(directory, { recursive: true, force: true });
  });

  const ports = {
    blob: { adapter: 'filesystem', rootEnv: 'PB_BLOB_ROOT', maxBytes: 1_048_576 },
    cache: { adapter: 'lru', maxBytes: 1_048_576 },
    jobs: { adapter: 'database', maxRunning: 1 },
    observability: { adapter: 'stdio', deploymentIdEnv: 'DEPLOYMENT_ID' },
  } as const;

  async function start(registry?: Parameters<typeof startNode>[0]['registry']) {
    return startNode({
      plugins: [],
      migrations: await discoveredMigrations(),
      env: {
        PB_SQLITE_PATH: join(directory, 'broker.sqlite'),
        PB_BLOB_ROOT: join(directory, 'blobs'),
        DEPLOYMENT_ID: 'registry-wiring',
        PB_ORG_SLUG: 'acme',
        PB_ORG_NAME: 'Acme',
        PB_MASTER_KEY: KEY,
        PB_PUBLIC_URL: 'http://127.0.0.1',
      },
      platformPorts: ports,
      stdout: { write: () => true, on: () => undefined },
      stderr: { write: () => true, on: () => undefined },
      ...(registry === undefined ? {} : { registry }),
    });
  }

  it('fails startup when the registry config is invalid', async () => {
    const failure = await start({ timers: { metadataTtlSeconds: -1 } }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(StartupConfigError);
    expect((failure as StartupConfigError).variable).toBe('registry');
    expect((failure as Error).message).toContain('metadataTtlSeconds');
  });

  it('fails startup when a registry config is given without platform ports', async () => {
    const failure = await startNode({
      plugins: [],
      migrations: await discoveredMigrations(),
      env: {
        PB_SQLITE_PATH: join(directory, 'broker.sqlite'),
        PB_ORG_SLUG: 'acme',
        PB_ORG_NAME: 'Acme',
        PB_MASTER_KEY: KEY,
        PB_PUBLIC_URL: 'http://127.0.0.1',
      },
      stdout: { write: () => true, on: () => undefined },
      stderr: { write: () => true, on: () => undefined },
      registry: {},
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StartupConfigError);
    expect((failure as StartupConfigError).variable).toBe('registry');
    expect((failure as Error).message).toBe('registry requires platformPorts');
  });

  it('refuses an outbound request to a loopback address through the guard', async () => {
    const broker = await start();
    running.push(broker);
    const { registry } = await broker.services();
    expect(registry).toBeDefined();
    for (const target of ['https://127.0.0.1/', 'https://169.254.169.254/latest']) {
      const failure = await registry!.outboundFetch(target).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(TypeError);
      const cause = (failure as TypeError).cause;
      expect(cause).toBeInstanceOf(DnsGuardError);
      expect((cause as DnsGuardError).reason).toBe('blocked_address');
    }
  });
});
