import { createSecretCipher, credentialAad } from '@package-broker/core/secrets/cipher';
import { createCredentialStore } from '@package-broker/core/secrets/credential-store';
import { createCredentialRepository } from '@package-broker/db-sqlite/repositories/credential';
import { createHash } from 'node:crypto';
import { createLocalLoginSeed } from './testing/local-login.js';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newSessionSecrets } from '@package-broker/core/auth/session';
import { orgContext, type SqlValue } from '@package-broker/core/db/port';
import { systemClock, ulid } from '@package-broker/core/ids';
import { createBlobStore, createBlobUploadAdmission } from '@package-broker/core/platform/blob';
import type { ObsRecord } from '@package-broker/core/platform/observability';
import type { FetchLike } from '@package-broker/core/platform/tracing';
import { resolveRegistryConfig } from '@package-broker/core/registry/registry-config';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { parseMasterKey } from '@package-broker/core/secrets/master-key';
import { createBlobRepository } from '@package-broker/db-sqlite/repositories/blob';
import { createJobRepository } from '@package-broker/db-sqlite/repositories/job';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import {
  openMigratedDatabase,
  type MigratedDatabase,
} from '@package-broker/db-sqlite/testing/migrated-database';
import { openFilesystemByteStore } from './blob/filesystem.js';
import { createLruCache } from './cache/lru.js';
import { createNodeServer, type NodeBroker } from './index.js';
import { createJobLoop, type JobLoop } from './jobs/loop.js';
import { createNodeServerWithSeams } from './testing/node-server.js';

const budget = vi.hoisted(() => ({ exhausted: false }));
vi.mock('@package-broker/db-sqlite/repositories/catalogue-writer', async (original) => {
  const actual =
    await original<typeof import('@package-broker/db-sqlite/repositories/catalogue-writer')>();
  return {
    ...actual,
    createCatalogueWriter: (...args: Parameters<typeof actual.createCatalogueWriter>) => {
      const writer = actual.createCatalogueWriter(...args);
      return {
        ...writer,
        get statementBudget() {
          return budget.exhausted
            ? { ...writer.statementBudget, markListing: 1000 }
            : writer.statementBudget;
        },
      };
    },
  };
});

const ORIGIN = 'https://broker.test';
const TTL = 900;
const MODIFIED = 'Mon, 19 Oct 2026 10:00:00 GMT';
const SYNC = 'core:package-sync:v1';
const AUDIT = ['core:audit-seal:v1', 'core:audit-verify:v1'];
const AUTH_JOBS = [
  'core:import-verify:v1',
  'core:import-apply:v1',
  'core:import-rollback:v1',
  'core:oidc-replay-expire:v1',
  'core:npm-login-expire:v1',
  'core:pat-offboarding:v1',
  'core:pat-offboarding-sweep:v1',
];

function remote(ecosystem: 'npm' | 'composer', count: number, requestedKey?: string) {
  const key = requestedKey ?? (ecosystem === 'npm' ? 'widget' : 'acme/widget');
  const versions = Array.from({ length: count }, (_, n) => `1.0.${n}`);
  const calls: Request[] = [];
  const state = { changed: false, notModified: false };
  const transport: FetchLike = async (input, init) => {
    const request = new Request(input, init);
    calls.push(request);
    const url = new URL(request.url);
    expect(url.origin).toBe(
      ecosystem === 'npm' ? 'https://registry.npmjs.org' : 'https://repo.packagist.org',
    );
    expect(request.headers.get('user-agent')).toBeTruthy();
    if (state.notModified) return new Response(null, { status: 304 });
    const published = state.changed ? [...versions, '2.0.0'] : versions;
    const members = published.map((version) => ({
      name: key,
      version,
      description: state.changed ? 'Updated package' : 'Original package',
      ...(ecosystem === 'npm'
        ? {
            dist: {
              tarball: `https://registry.npmjs.org/widget/-/widget-${version}.tgz`,
              shasum: 'a'.repeat(40),
            },
          }
        : {
            version_normalized: `${version}.0`,
            type: 'library',
            time: '2026-01-01T00:00:00+00:00',
            dist: {
              type: 'zip',
              url: 'https://api.github.com/repos/acme/widget/zipball/abc123',
              reference: 'abc123',
              shasum: '',
            },
          }),
    }));
    const body =
      ecosystem === 'npm'
        ? {
            name: key,
            versions: Object.fromEntries(members.map((member) => [member.version, member])),
            'dist-tags': { latest: published.at(-1) },
            time: Object.fromEntries(published.map((version) => [version, '2026-01-01T00:00:00Z'])),
          }
        : { packages: { [key]: url.pathname.endsWith('~dev.json') ? [] : members } };
    return Response.json(body, {
      headers: { etag: state.changed ? '"v2"' : '"v1"', 'last-modified': MODIFIED },
    });
  };
  return { key, versions, calls, state, transport };
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

describe('Node package-sync wiring', () => {
  let db: MigratedDatabase;
  let directory: string;
  let broker: NodeBroker | undefined;
  let loop: JobLoop | undefined;
  let orgId: string;
  let cookie: string;
  let sources: { npm: string; composer: string };
  let records: ObsRecord[];

  async function sql<T extends object = object>(
    statement: string,
    params: readonly SqlValue[] = [],
  ) {
    return db.executor.all<T>({ sql: statement, params: [...params] });
  }

  beforeEach(async () => {
    budget.exhausted = false;
    records = [];
    db = await openMigratedDatabase({ d1PatternLimit: true });
    directory = await realpath(await mkdtemp(join(tmpdir(), 'pb-package-sync-')));
    const org = await createOrganizationBootstrap(db.executor).bootstrap({
      id: ulid(),
      slug: 'acme',
      name: 'Acme',
      now: new Date().toISOString(),
    });
    orgId = org.id;
    const projectId = ulid();
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
    const { sealed, aad, passwordHash } = await createLocalLoginSeed(
      db.executor,
      createKeyring([
        parseMasterKey('pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', 'PB_MASTER_KEY'),
      ]),
      { orgId, userId, credentialId },
    );
    await sql(
      "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES (?, ?, 'totp', ?, ?, ?, ?)",
      [credentialId, orgId, sealed.ciphertext, sealed.nonce, sealed.keyVersion, aad],
    );
    await sql(
      'INSERT INTO local_login (user_id, org_id, password_hash, totp_credential_id, totp_enabled_at) VALUES (?, ?, ?, ?, ?)',
      [userId, orgId, passwordHash, credentialId, new Date().toISOString()],
    );
    await sql(
      "INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, 'reader', 'Reader', 'organization', 1)",
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
    sources = { npm: ulid(), composer: ulid() };
    for (const [ecosystem, sourceId] of Object.entries(sources)) {
      await sql(
        'INSERT INTO source (id, org_id, name, ecosystem, type, url) VALUES (?, ?, ?, ?, ?, ?)',
        [
          sourceId,
          orgId,
          ecosystem,
          ecosystem,
          ecosystem === 'npm' ? 'npmjs_proxy' : 'packagist_proxy',
          ecosystem === 'npm' ? 'https://registry.npmjs.org' : 'https://repo.packagist.org',
        ],
      );
      await sql('INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)', [
        orgId,
        projectId,
        sourceId,
      ]);
    }
  });

  afterEach(async () => {
    await loop?.stop();
    loop = undefined;
    await broker?.close();
    broker = undefined;
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function boot(transport: FetchLike, registry = true) {
    const bytes = await openFilesystemByteStore({ root: join(directory, 'blobs') });
    broker = createNodeServerWithSeams(
      [],
      {
        executor: db.executor,
        auth: {
          keyring: createKeyring([
            parseMasterKey('pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', 'PB_MASTER_KEY'),
          ]),
          publicOrigin: ORIGIN,
          env: {},
        },
        platformServices: {
          blob: createBlobStore(
            bytes,
            createBlobRepository(db.executor, { purgeLeaseSeconds: 900 }),
            { admission: createBlobUploadAdmission(), maxBytes: 4_194_304 },
          ),
          cache: createLruCache({}),
          jobStore: createJobRepository(db.executor),
        },
        ...(registry
          ? {
              registry: {
                config: resolveRegistryConfig(
                  { timers: { metadataTtlSeconds: TTL } },
                  'node',
                  ORIGIN,
                ),
              },
            }
          : {}),
        observability: {
          sink: { emit: (record) => void records.push(record) },
          deploymentId: 'test',
          trustInboundTraceparent: false,
        },
      },
      { transport },
    );
    return broker.ready();
  }

  async function get(ecosystem: 'npm' | 'composer', key: string) {
    const kernel = await broker!.ready();
    const path = ecosystem === 'npm' ? `/alpha/npm/${key}` : `/alpha/p2/${key}.json`;
    return kernel.fetch(new Request(`${ORIGIN}${path}`, { headers: { cookie } }));
  }

  async function syncRows() {
    return sql<{ id: string; state: string; last_error: string | null }>(
      'SELECT id, state, last_error FROM job WHERE org_id = ? AND type = ? ORDER BY id',
      [orgId, SYNC],
    );
  }

  async function startLoop() {
    const kernel = await broker!.ready();
    loop = createJobLoop({
      executor: db.executor,
      jobs: kernel.registration.jobs,
      scope: (job, claim) => kernel.jobScope(job, claim),
      observability: {
        log: () => undefined,
        counter: () => undefined,
        histogram: () => undefined,
      },
    });
    loop.start();
  }

  async function completed() {
    await vi.waitFor(
      async () => {
        const rows = await syncRows();
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((row) => row.state === 'succeeded')).toBe(true);
      },
      { timeout: 15_000, interval: 25 },
    );
    await loop!.stop();
    loop = undefined;
  }

  async function enqueue(key: string, sourceId = sources.npm) {
    return createJobRepository(db.executor).enqueue(orgContext(orgId), {
      id: ulid(),
      type: SYNC,
      payloadJson: JSON.stringify({ sourceId, key }),
      idempotencyKey: ulid(),
      resourceKey: null,
      runAt: null,
      maxAttempts: 25,
      projectId: null,
      initiatorTokenId: null,
    });
  }

  it.each([
    ['npm', 'npmjs_proxy', 'widget'],
    ['composer', 'packagist_proxy', 'acme/widget'],
    ['npm', 'npm_registry', '@acme/widget'],
  ] as const)(
    'manually adds a %s package from %s and publishes its versions through the existing sync job',
    async (ecosystem, type, key) => {
      await sql(
        "INSERT INTO role_permission (org_id, role_id, permission) SELECT org_id, id, 'project:sources:write' FROM role WHERE org_id = ? AND key = 'reader'",
        [orgId],
      );
      if (type === 'npm_registry') {
        await sql('UPDATE source SET type = ?, config_json = ? WHERE org_id = ? AND id = ?', [
          type,
          JSON.stringify({ scopes: ['@acme'] }),
          orgId,
          sources.npm,
        ]);
        await sql(
          "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, ?, 'npm', '@acme/*')",
          [ulid(), orgId, sources.npm],
        );
      }
      const upstream = remote(ecosystem, 75, key);
      const kernel = await boot(upstream.transport);
      const add = () =>
        kernel.fetch(
          new Request(`${ORIGIN}/_pb/projects/alpha/sources/${sources[ecosystem]}/packages`, {
            method: 'POST',
            headers: {
              cookie,
              origin: ORIGIN,
              'content-type': 'application/json',
              'x-csrf-token': cookie.split('__Host-pb_csrf=')[1]!,
            },
            body: JSON.stringify({ name: upstream.key }),
          }),
        );
      const response = await add();
      expect(response.status).toBe(202);
      const body = (await response.json()) as { name: string; state: string; jobId: string };
      expect(body).toEqual({ name: upstream.key, state: 'queued', jobId: expect.any(String) });
      const queued = await sql<{ payload_json: string }>(
        'SELECT payload_json FROM job WHERE org_id = ? AND id = ?',
        [orgId, body.jobId],
      );
      expect(JSON.parse(queued[0]!.payload_json)).toEqual({
        sourceId: sources[ecosystem],
        key: upstream.key,
      });
      await startLoop();
      await completed();
      expect(
        await sql(
          'SELECT id FROM package WHERE org_id = ? AND source_id = ? AND name = ? AND last_synced_at IS NOT NULL',
          [orgId, sources[ecosystem], upstream.key],
        ),
      ).toHaveLength(1);
      expect(
        await sql(
          'SELECT v.id FROM version v JOIN package p ON p.id = v.package_id WHERE v.org_id = ? AND p.org_id = ? AND p.source_id = ?',
          [orgId, orgId, sources[ecosystem]],
        ),
      ).toHaveLength(75);
      const list = await kernel.fetch(
        new Request(`${ORIGIN}/_pb/projects/alpha/packages`, { headers: { cookie } }),
      );
      expect(list.status).toBe(200);
      expect(await list.text()).toContain(upstream.key);
      const upstreamCalls = upstream.calls.length;
      const repeated = await add();
      expect(repeated.status).toBe(200);
      expect(await repeated.json()).toEqual({ name: upstream.key, state: 'present' });
      expect(upstream.calls).toHaveLength(upstreamCalls);
    },
  );

  it.each(['npm', 'composer', 'private'] as const)(
    'returns a %s upstream 404 without creating a job',
    async (kind) => {
      const ecosystem = kind === 'private' ? 'npm' : kind;
      if (kind === 'private') {
        await sql('UPDATE source SET type = ?, config_json = ? WHERE org_id = ? AND id = ?', [
          'npm_registry',
          JSON.stringify({ scopes: ['@acme'] }),
          orgId,
          sources.npm,
        ]);
        await sql(
          "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, ?, 'npm', '@acme/*')",
          [ulid(), orgId, sources.npm],
        );
      }
      await sql(
        "INSERT INTO role_permission (org_id, role_id, permission) SELECT org_id, id, 'project:sources:write' FROM role WHERE org_id = ? AND key = 'reader'",
        [orgId],
      );
      const kernel = await boot(async () =>
        Response.json(ecosystem === 'npm' ? { error: 'Not found' } : { packages: [] }, {
          status: 404,
        }),
      );
      const response = await kernel.fetch(
        new Request(`${ORIGIN}/_pb/projects/alpha/sources/${sources[ecosystem]}/packages`, {
          method: 'POST',
          headers: {
            cookie,
            origin: ORIGIN,
            'content-type': 'application/json',
            'x-csrf-token': cookie.split('__Host-pb_csrf=')[1]!,
          },
          body: JSON.stringify({
            name:
              kind === 'private'
                ? '@acme/missing'
                : ecosystem === 'npm'
                  ? 'missing'
                  : 'acme/missing',
          }),
        }),
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: 'package_not_found' } });
      expect(await syncRows()).toEqual([]);
    },
  );

  it('hides a source belonging to another organization without querying upstream', async () => {
    await sql(
      "INSERT INTO role_permission (org_id, role_id, permission) SELECT org_id, id, 'project:sources:write' FROM role WHERE org_id = ? AND key = 'reader'",
      [orgId],
    );
    const foreign = await createOrganizationBootstrap(db.executor).bootstrap({
      id: ulid(),
      slug: 'foreign',
      name: 'Foreign',
      now: new Date().toISOString(),
    });
    const sourceId = ulid();
    await sql(
      "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, ?, 'foreign-npm', 'npm', 'npmjs_proxy')",
      [sourceId, foreign.id],
    );
    const transport = vi.fn(async () => Response.json({}));
    const kernel = await boot(transport);
    const response = await kernel.fetch(
      new Request(`${ORIGIN}/_pb/projects/alpha/sources/${sourceId}/packages`, {
        method: 'POST',
        headers: {
          cookie,
          origin: ORIGIN,
          'content-type': 'application/json',
          'x-csrf-token': cookie.split('__Host-pb_csrf=')[1]!,
        },
        body: JSON.stringify({ name: 'widget' }),
      }),
    );
    expect(response.status).toBe(404);
    expect(transport).not.toHaveBeenCalled();
    expect(await syncRows()).toEqual([]);
  });

  it.each([false, true])(
    'opens the Packagist bearer credential only when githubToken is %s',
    async (githubToken) => {
      const credentialId = await createCredentialStore({
        repository: createCredentialRepository(db.executor),
        cipher: createSecretCipher(
          createKeyring([
            parseMasterKey('pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', 'PB_MASTER_KEY'),
          ]),
          'credential-encryption',
        ),
        ids: { ulid },
        clock: systemClock,
      }).put(orgContext(orgId), {
        kind: 'bearer',
        projectId: null,
        plaintext: new TextEncoder().encode(JSON.stringify({ token: 'packagist-test-token' })),
      });
      await sql(
        'UPDATE source SET credential_id = ?, config_json = ? WHERE org_id = ? AND id = ?',
        [credentialId, JSON.stringify({ githubToken }), orgContext(orgId).orgId, sources.composer],
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
        const kernel = await boot(transport);
        const response = await get('composer', 'acme/widget');
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          packages: Record<string, { dist: { url: string } }[]>;
        };
        const dist = await kernel.fetch(
          new Request(body.packages['acme/widget']![0]!.dist.url, { headers: { cookie } }),
        );
        expect(dist.status).toBe(200);
        expect(await dist.text()).toBe('archive');
        const aad = credentialAad({
          id: credentialId,
          orgId: orgContext(orgId).orgId,
          kind: 'bearer',
        });
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
    'activates and job-syncs a %s Composer repository, then serves its archive',
    async (mode) => {
      const upstream = composerRepositoryFixture(
        mode,
        false,
        'https://dist.example.com/archive.zip',
      );
      const sourceId = sources.composer;
      await sql(
        "UPDATE source SET type = 'composer_repository', url = ?, config_json = ?, status = 'paused' WHERE org_id = ? AND id = ?",
        [
          upstream.origin,
          JSON.stringify({
            selection: { packages: [upstream.key], patterns: [] },
            distHosts: ['dist.example.com'],
          }),
          orgId,
          sourceId,
        ],
      );
      await sql(
        "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, ?, 'composer', 'acme/*')",
        [ulid(), orgId, sourceId],
      );
      await sql(
        "INSERT INTO role_permission (org_id, role_id, permission) SELECT org_id, id, 'org:sources:write' FROM role WHERE org_id = ? AND key = 'reader'",
        [orgId],
      );

      const credentialId = await createCredentialStore({
        repository: createCredentialRepository(db.executor),
        cipher: createSecretCipher(
          createKeyring([
            parseMasterKey('pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', 'PB_MASTER_KEY'),
          ]),
          'credential-encryption',
        ),
        ids: { ulid },
        clock: systemClock,
      }).put(orgContext(orgId), {
        kind: 'bearer',
        projectId: null,
        plaintext: new TextEncoder().encode(JSON.stringify({ token: 'composer-private-token' })),
      });
      await sql('UPDATE source SET credential_id = ? WHERE org_id = ? AND id = ?', [
        credentialId,
        orgContext(orgId).orgId,
        sourceId,
      ]);
      const kernel = await boot(upstream.transport);
      const enabled = await kernel.fetch(
        new Request(`${ORIGIN}/_pb/sources/${sourceId}/enable`, {
          method: 'POST',
          headers: {
            cookie,
            origin: ORIGIN,
            'x-csrf-token': /__Host-pb_csrf=([^;]+)/.exec(cookie)![1]!,
          },
        }),
      );
      expect(enabled.status).toBe(204);
      await createJobRepository(db.executor).enqueue(orgContext(orgId), {
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
      await startLoop();
      await completed();
      const response = await get('composer', upstream.key);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        packages: Record<string, { version: string; dist: { url: string } }[]>;
      };
      expect(body.packages[upstream.key]!.map((member) => member.version)).toEqual(['1.0.0']);
      const dist = await kernel.fetch(
        new Request(body.packages[upstream.key]![0]!.dist.url, { headers: { cookie } }),
      );
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
        await sql('SELECT name FROM package WHERE org_id = ? AND source_id = ?', [orgId, sourceId]),
      ).toEqual([{ name: upstream.key }]);
      expect(await sql('SELECT count(*) AS n FROM blob WHERE org_id = ?', [orgId])).toEqual([
        { n: 1 },
      ]);
      await sql('UPDATE source SET config_json = ? WHERE org_id = ? AND id = ?', [
        JSON.stringify({ selection: { packages: [], patterns: ['other/*'] } }),
        orgId,
        sourceId,
      ]);
      await createJobRepository(db.executor).enqueue(orgContext(orgId), {
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
      await startLoop();
      await vi.waitFor(
        async () =>
          expect(
            await sql("SELECT state FROM job WHERE org_id = ? AND type = 'core:source-sync:v1'", [
              orgId,
            ]),
          ).toEqual([{ state: 'succeeded' }, { state: 'succeeded' }]),
        { timeout: 5000 },
      );
      expect((await get('composer', upstream.key)).status).toBe(200);
    },
    30_000,
  );

  it('records Composer repository poll backoff when root fetching fails', async () => {
    const sourceId = sources.composer;
    await sql(
      "UPDATE source SET type = 'composer_repository', url = 'https://composer.example.com', config_json = ?, poll_interval_seconds = 3600 WHERE org_id = ? AND id = ?",
      [JSON.stringify({ selection: { packages: ['acme/widget'] } }), orgId, sourceId],
    );
    await boot(async () => new Response(null, { status: 503 }));
    await createJobRepository(db.executor).enqueue(orgContext(orgId), {
      id: ulid(),
      type: 'core:source-sync:v1',
      payloadJson: JSON.stringify({ sourceId, reason: 'poll' }),
      idempotencyKey: ulid(),
      resourceKey: `source:${sourceId}`,
      runAt: null,
      maxAttempts: 25,
      projectId: null,
      initiatorTokenId: null,
    });
    const before = Date.now();
    await startLoop();
    await vi.waitFor(
      async () => {
        const [row] = await sql<{
          consecutive_failures: number;
          last_error: string;
          next_poll_at: string;
        }>(
          'SELECT consecutive_failures, last_error, next_poll_at FROM source WHERE org_id = ? AND id = ?',
          [orgId, sourceId],
        );
        expect(row!.consecutive_failures).toBe(1);
        expect(row!.last_error).toBe('http_error');
        expect(Date.parse(row!.next_poll_at) - before).toBeGreaterThanOrEqual(299_000);
      },
      { timeout: 5000 },
    );
    const retriedAt = Date.now();
    await createJobRepository(db.executor).enqueue(orgContext(orgId), {
      id: ulid(),
      type: 'core:source-sync:v1',
      payloadJson: JSON.stringify({ sourceId, reason: 'poll' }),
      idempotencyKey: ulid(),
      resourceKey: `source:${sourceId}`,
      runAt: null,
      maxAttempts: 25,
      projectId: null,
      initiatorTokenId: null,
    });
    await vi.waitFor(
      async () => {
        const [row] = await sql<{ consecutive_failures: number; next_poll_at: string }>(
          'SELECT consecutive_failures, next_poll_at FROM source WHERE org_id = ? AND id = ?',
          [orgId, sourceId],
        );
        expect(row!.consecutive_failures).toBe(2);
        expect(Date.parse(row!.next_poll_at) - retriedAt).toBeGreaterThanOrEqual(599_000);
      },
      { timeout: 5000 },
    );
  });

  it.each(['shasum', 'host', 'redirect'] as const)(
    'rejects a Composer archive with invalid %s over HTTP',
    async (issue) => {
      const upstream = composerRepositoryFixture(
        'inline',
        issue === 'shasum',
        issue === 'host' ? 'https://foreign.example.com/archive.zip' : undefined,
      );
      const sourceId = sources.composer;
      await sql(
        "UPDATE source SET type = 'composer_repository', url = ?, config_json = ? WHERE org_id = ? AND id = ?",
        [
          upstream.origin,
          JSON.stringify({ selection: { packages: [upstream.key] } }),
          orgId,
          sourceId,
        ],
      );
      await sql(
        "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, ?, 'composer', 'acme/*')",
        [ulid(), orgId, sourceId],
      );
      const calls: Request[] = [];
      const kernel = await boot(async (input, init) => {
        const request = new Request(input, init);
        calls.push(request);
        if (issue === 'redirect' && request.url.endsWith('/archive.zip'))
          return new Response(null, {
            status: 302,
            headers: { location: 'https://foreign.example.com/stolen.zip' },
          });
        return upstream.transport(input, init);
      });
      await enqueue(upstream.key, sourceId);
      await startLoop();
      await completed();
      const response = await get('composer', upstream.key);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        packages: Record<string, { dist: { url: string } }[]>;
      };
      const dist = await kernel.fetch(
        new Request(body.packages[upstream.key]![0]!.dist.url, { headers: { cookie } }),
      );
      expect(dist.status).toBe(502);
      expect(await sql('SELECT count(*) AS n FROM blob WHERE org_id = ?', [orgId])).toEqual([
        { n: 0 },
      ]);
      if (issue === 'shasum')
        expect(await sql('SELECT status FROM version WHERE org_id = ?', [orgId])).toEqual([
          { status: 'quarantined' },
        ]);
      else {
        expect(calls.some((call) => call.url.includes('foreign.example.com'))).toBe(false);
        expect(
          records.filter(
            (record) => record.kind === 'log' && record.record.event === 'upstream.refused',
          ),
        ).toEqual([
          expect.objectContaining({ record: expect.objectContaining({ level: 'debug' }) }),
        ]);
      }
    },
  );

  it('registers package-sync alongside the audit jobs and preserves existing auth jobs', async () => {
    const kernel = await boot(remote('npm', 1).transport);
    expect(kernel.registration.jobs.map((job) => job.qualifiedName).sort()).toEqual(
      [
        ...AUDIT,
        ...AUTH_JOBS,
        'core:publish-approval-expire:v1',
        'core:publish-scan:v1',
        'core:publish-scan-sweep:v1',
        SYNC,
        'core:npm-vcs-build:v1',
        'core:package-access-expire:v1',
        'core:source-sync:v1',
        'core:source-poll:v1',
        'core:vulnerability-sync:v1',
      ].sort(),
    );
  });

  it('omits package-sync without registry options', async () => {
    const kernel = await boot(remote('npm', 1).transport, false);
    expect(kernel.registration.jobs.map((job) => job.qualifiedName).sort()).toEqual(
      [
        ...AUDIT,
        ...AUTH_JOBS,
        'core:publish-approval-expire:v1',
        'core:publish-scan:v1',
        'core:publish-scan-sweep:v1',
        'core:package-access-expire:v1',
        'core:vulnerability-sync:v1',
      ].sort(),
    );
    const bare = createNodeServer([]);
    try {
      expect((await bare.ready()).registration.jobs).toEqual([]);
    } finally {
      await bare.close();
    }
  });

  it.each(['npm', 'composer'] as const)(
    'completes a multi-chunk %s cold fill through the DB loop',
    async (ecosystem) => {
      const upstream = remote(ecosystem, 200);
      await boot(upstream.transport);
      const pending = await get(ecosystem, upstream.key);
      expect(pending.status).toBe(503);
      expect(Number(pending.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(await syncRows()).toHaveLength(1);
      await startLoop();
      await completed();
      expect((await syncRows()).length).toBeGreaterThan(1);
      const response = await get(ecosystem, upstream.key);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        versions: Record<string, unknown>;
        packages: Record<string, { version: string }[]>;
      };
      const served =
        ecosystem === 'npm'
          ? Object.keys(body.versions)
          : body.packages[upstream.key]!.map((version) => version.version);
      expect(served.sort()).toEqual([...upstream.versions].sort());
      expect(
        await sql(
          'SELECT state FROM ingest_session WHERE org_id = ? AND source_id = ? AND package_key = ?',
          [orgId, sources[ecosystem], upstream.key],
        ),
      ).toEqual([{ state: 'complete' }]);
    },
    60_000,
  );

  it.each(['changed', '304'] as const)(
    'serves stale and refreshes a %s upstream through the DB loop',
    async (mode) => {
      const upstream = remote('npm', 1);
      await boot(upstream.transport);
      expect((await get('npm', upstream.key)).status).toBe(200);
      const [before] = await sql<{ id: string; rev: number }>(
        'SELECT id, rev FROM package WHERE org_id = ? AND name = ?',
        [orgId, upstream.key],
      );
      const aged = '2026-01-01T00:00:00.000Z';
      await sql('UPDATE upstream_state SET fresh_until = ? WHERE org_id = ? AND package_id = ?', [
        aged,
        orgId,
        before!.id,
      ]);
      upstream.calls.length = 0;
      upstream.state.changed = mode === 'changed';
      upstream.state.notModified = mode === '304';
      const stale = await get('npm', upstream.key);
      expect(stale.status).toBe(200);
      expect(stale.headers.get('x-broker-stale')).toBe('1');
      await vi.waitFor(async () => expect(await syncRows()).toHaveLength(1));
      expect(upstream.calls).toHaveLength(0);
      await startLoop();
      await completed();
      expect(upstream.calls).toHaveLength(1);
      expect(upstream.calls[0]!.headers.get('if-none-match')).toBe('"v1"');
      expect(upstream.calls[0]!.headers.get('if-modified-since')).toBe(MODIFIED);
      const [after] = await sql<{ rev: number }>(
        'SELECT rev FROM package WHERE org_id = ? AND id = ?',
        [orgId, before!.id],
      );
      if (mode === 'changed') expect(after!.rev).toBeGreaterThan(before!.rev);
      else expect(after!.rev).toBe(before!.rev);
      const [state] = await sql<{ checked_at: string; fresh_until: string }>(
        'SELECT checked_at, fresh_until FROM upstream_state WHERE org_id = ? AND package_id = ?',
        [orgId, before!.id],
      );
      expect(Date.parse(state!.fresh_until)).toBeGreaterThan(Date.parse(aged));
      expect(Date.parse(state!.fresh_until) - Date.parse(state!.checked_at)).toBe(TTL * 1000);
      expect((await get('npm', upstream.key)).headers.get('x-broker-stale')).toBeNull();
    },
  );

  it('settles an org A job naming an org B source without transport or ingest writes', async () => {
    const upstream = remote('npm', 1);
    await boot(upstream.transport);
    const foreignOrg = ulid();
    const foreignSource = ulid();
    await sql('DROP INDEX organization_singleton');
    await sql("INSERT INTO organization (id, slug, name) VALUES (?, 'foreign', 'Foreign')", [
      foreignOrg,
    ]);
    await sql(
      "INSERT INTO source (id, org_id, name, ecosystem, type, url) VALUES (?, ?, 'foreign', 'npm', 'npmjs_proxy', 'https://registry.npmjs.org')",
      [foreignSource, foreignOrg],
    );
    await enqueue(upstream.key, foreignSource);
    await startLoop();
    await completed();
    expect(upstream.calls).toHaveLength(0);
    for (const table of ['package', 'version', 'upstream_state', 'ingest_session']) {
      expect(
        await sql(`SELECT count(*) AS n FROM ${table} WHERE org_id IN (?, ?)`, [orgId, foreignOrg]),
      ).toEqual([{ n: 0 }]);
    }
  });

  it('sends ingest budget exhaustion to the sink with job_id, package_key and source_id', async () => {
    const upstream = remote('npm', 1);
    await boot(upstream.transport);
    budget.exhausted = true;
    const job = await enqueue(upstream.key);
    await startLoop();
    await vi.waitFor(
      () => {
        expect(records).toContainEqual({
          kind: 'log',
          record: expect.objectContaining({
            event: 'ingest.budget_exhausted',
            reason_code: 'budget_exhausted',
            job_id: job.id,
            package_key: upstream.key,
            source_id: sources.npm,
          }),
        });
      },
      { timeout: 5000 },
    );
  });
});
