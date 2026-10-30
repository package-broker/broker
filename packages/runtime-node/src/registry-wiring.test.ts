import { formatToken } from '@package-broker/core/secrets/token-format';
import { hashToken } from '@package-broker/core/secrets/token-hash';
import { createNpmHandleOf } from '@package-broker/core/registry/module';
import type { RequestContext } from '@package-broker/core/plugin';
import { createUserRepository } from '@package-broker/db-sqlite/repositories/user';
import { createServicePrincipalRepository } from '@package-broker/db-sqlite/repositories/service-principal';
import { execFile } from 'node:child_process';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { createLocalLoginSeed } from './testing/local-login.js';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newSessionSecrets } from '@package-broker/core/auth/session';
import { orgContext, type SqlExecutor, type SqlValue } from '@package-broker/core/db/port';
import { systemClock, ulid } from '@package-broker/core/ids';
import { createBlobStore, createBlobUploadAdmission } from '@package-broker/core/platform/blob';
import type { CoreJobs as Jobs } from '@package-broker/core/platform/jobs';
import { filterLogLevel } from '@package-broker/core/platform/observability';
import type { FetchLike } from '@package-broker/core/platform/tracing';
import { resolveRegistryConfig } from '@package-broker/core/registry/registry-config';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { createSecretCipher } from '@package-broker/core/secrets/cipher';
import { createCredentialStore } from '@package-broker/core/secrets/credential-store';
import { parseMasterKey } from '@package-broker/core/secrets/master-key';
import { createBlobRepository } from '@package-broker/db-sqlite/repositories/blob';
import { createCredentialRepository } from '@package-broker/db-sqlite/repositories/credential';
import * as vulnerabilityModule from '@package-broker/db-sqlite/repositories/vulnerability';
import { createJobRepository } from '@package-broker/db-sqlite/repositories/job';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import {
  discoveredMigrations,
  openMigratedDatabase,
  type MigratedDatabase,
} from '@package-broker/db-sqlite/testing/migrated-database';
import { openFilesystemByteStore } from './blob/filesystem.js';
import { createLruCache } from './cache/lru.js';
import { type NodeBroker } from './index.js';
import { DnsGuardError } from './sources/dns-guard.js';
import { StartupConfigError, startNode } from './startup.js';
import { createNodeServerWithSeams, type RegistrySeams } from './testing/node-server.js';

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
    const { sealed, aad, passwordHash } = await createLocalLoginSeed(
      db.executor,
      createKeyring([parseMasterKey(KEY, 'PB_MASTER_KEY')]),
      { orgId, userId, credentialId },
    );
    await sql(
      "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES (?, ?, 'totp', ?, ?, ?, ?)",
      [credentialId, orgId, sealed.ciphertext, sealed.nonce, sealed.keyVersion, aad],
    );
    await sql(
      'INSERT INTO local_login (user_id, org_id, password_hash, totp_credential_id, totp_enabled_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)',
      [
        userId,
        orgId,
        passwordHash,
        credentialId,
        new Date().toISOString(),
        new Date().toISOString(),
      ],
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
      auditEnabled?: boolean;
      jobs?: Jobs;
      level?: 'info' | 'debug';
      executor?: SqlExecutor;
      closeDatabase?: () => Promise<void>;
      observeCredentials?: RegistrySeams['observeCredentials'];
      shutdownDeadlineMs?: number;
    } = {},
  ): Promise<NodeBroker> {
    const byteStore = await openFilesystemByteStore({ root: join(directory, 'blobs') });
    broker = createNodeServerWithSeams(
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
        registry: {
          config: resolveRegistryConfig(
            { npmAudit: { enabled: extra.auditEnabled ?? true } },
            'node',
            ORIGIN,
          ),
        },
        log: (record) => void logged.push(JSON.stringify(record)),
        ...(extra.level === undefined
          ? {}
          : {
              observability: {
                sink: filterLogLevel(
                  {
                    emit: (record) => {
                      if (record.kind === 'log') logged.push(JSON.stringify(record.record));
                    },
                  },
                  extra.level,
                ),
                deploymentId: 'registry-test',
                level: extra.level,
              },
            }),
      },
      {
        transport,
        ...(extra.jobs === undefined ? {} : { jobs: extra.jobs }),
        ...(extra.observeCredentials === undefined
          ? {}
          : { observeCredentials: extra.observeCredentials }),
        ...(extra.shutdownDeadlineMs === undefined
          ? {}
          : { shutdownDeadlineMs: extra.shutdownDeadlineMs }),
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

  it('authenticates whoami with personal and service bearer tokens and refuses an invalid token', async () => {
    await sql(
      "INSERT INTO role_permission (org_id, role_id, permission) SELECT org_id, id, 'project:read' FROM role WHERE org_id = ?",
      [orgId],
    );
    await sql('UPDATE user_account SET display_name = ? WHERE org_id = ?', ['reader', orgId]);
    const tokens = await seedWhoamiTokens(db.executor, orgId, projectId);
    await boot(upstream().transport);
    for (const { token, username } of tokens) {
      const response = await get('/alpha/npm/-/whoami', { authorization: `Bearer ${token}` });
      expect(response.status, username ?? 'invalid token').toBe(username === null ? 401 : 200);
      if (username !== null) expect(await response.json()).toEqual({ username });
    }
  });

  it('runs npm whoami through the Node HTTP entry', async () => {
    await sql(
      "INSERT INTO role_permission (org_id, role_id, permission) SELECT org_id, id, 'project:read' FROM role WHERE org_id = ?",
      [orgId],
    );
    await requireNpm();
    await sql('UPDATE user_account SET display_name = ? WHERE org_id = ?', ['reader', orgId]);
    const tokens = await seedWhoamiTokens(db.executor, orgId, projectId);
    await boot(upstream().transport);
    await npmWhoami(
      (path, headers) =>
        broker!
          .ready()
          .then((kernel) => kernel.fetch(new Request(`${ORIGIN}${path}`, { headers }))),
      '/alpha/npm/',
      tokens,
    );
  });

  it('serves whoami with a safe display name and the full fallback id', async () => {
    await sql(
      "INSERT INTO role_permission (org_id, role_id, permission) SELECT org_id, id, 'project:read' FROM role WHERE org_id = ?",
      [orgId],
    );
    await boot(upstream().transport);
    const [user] = await sql<{ id: string }>('SELECT id FROM user_account WHERE org_id = ?', [
      orgId,
    ]);
    for (const name of ['reader', null, '', 'reader@example.test', 'two words']) {
      await sql('UPDATE user_account SET display_name = ? WHERE org_id = ?', [name, orgId]);
      const response = await get('/alpha/npm/-/whoami');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        username: name === 'reader' ? name : `user-${user!.id.toLowerCase()}`,
      });
    }
    expect((await get('/alpha/npm/-/whoami', {})).status).toBe(401);
    const serviceId = ulid();
    await sql(
      'INSERT INTO service_principal (id, org_id, name, created_by_user_id) VALUES (?, ?, ?, ?)',
      [serviceId, orgId, 'build-bot', user!.id],
    );
    const handleOf = createNpmHandleOf(
      createUserRepository(db.executor),
      createServicePrincipalRepository(db.executor),
    );
    const ctx = {
      org: orgContext(orgId),
      principal: { kind: 'service', id: serviceId },
    } as RequestContext;
    expect(await handleOf(ctx)).toBe('build-bot');
    await sql('UPDATE service_principal SET name = ? WHERE id = ?', [
      'bot@example.test',
      serviceId,
    ]);
    expect(await handleOf(ctx)).toBe(`service-${serviceId.toLowerCase()}`);
    expect(await handleOf({ ...ctx, org: orgContext(ulid()) })).toBeNull();
    expect(
      await handleOf({
        ...ctx,
        principal: { kind: 'user', id: user!.id },
        org: orgContext(ulid()),
      }),
    ).toBeNull();
  });

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

  const brokerPath = (url: string): string => new URL(url).pathname;

  describe('npm audit matrix', () => {
    afterEach(() => vi.restoreAllMocks());
    const endpoint = '/alpha/npm/-/npm/v1/security/advisories/bulk';
    async function audit(body: unknown) {
      const kernel = await broker!.ready();
      return kernel.fetch(
        new Request(`${ORIGIN}${endpoint}`, {
          method: 'POST',
          headers: {
            cookie,
            origin: ORIGIN,
            'x-csrf-token': cookie.split('__Host-pb_csrf=')[1]!,
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
      const executor: SqlExecutor = {
        driver: db.executor.driver,
        all: (statement) => db.executor.all(statement),
        batch: (statements) => {
          if (
            failEvidence &&
            statements.some((statement) => statement.sql.includes('evidence_bytes'))
          )
            throw new Error('evidence unavailable');
          return db.executor.batch(statements);
        },
      };
      const remote = upstream();
      const sent: { body: unknown; headers: Headers }[] = [];
      await boot(
        async (input, init) => {
          const request = new Request(input, init);
          if (request.method !== 'POST') return remote.transport(input, init);
          sent.push({ body: await request.json(), headers: request.headers });
          return Response.json({ 'left-pad': [{ id: 42 }], sentinel: [{ id: 43 }] });
        },
        { executor },
      );
      expect(repositorySpy.mock.calls.length).toBeGreaterThan(0);
      for (const call of repositorySpy.mock.calls) expect(call[1]).toBe(systemClock);
      repositorySpy.mockRestore();
      expect((await get('/alpha/npm/left-pad')).status).toBe(200);
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
      await sql(
        "INSERT INTO source (id, org_id, name, ecosystem, type, url, config_json) VALUES ('PRIVATE', ?, 'Private', 'npm', 'npm_registry', 'https://private.test', '{\"scopes\":[\"@private\"]}')",
        [orgId],
      );
      await sql(
        "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('HIDDEN', ?, 'PRIVATE', 'npm', 'left-pad')",
        [orgId],
      );
      sent.length = 0;
      const hiddenHolder = await audit({ 'left-pad': ['1.0.0'] });
      expect(hiddenHolder.status).toBe(200);
      expect(await hiddenHolder.json()).toEqual({});
      expect(sent).toEqual([]);
      await sql("UPDATE source SET status = 'paused' WHERE org_id = ? AND id = 'PRIVATE'", [orgId]);
      const pausedHolder = await audit({ 'left-pad': ['1.0.0'] });
      expect(pausedHolder.status).toBe(200);
      expect(await pausedHolder.json()).toEqual({});
      expect(sent).toEqual([]);
      await sql("DELETE FROM package WHERE org_id = ? AND id = 'HIDDEN'", [orgId]);
      await sql(
        "INSERT INTO source (id, org_id, name, ecosystem, type, url) VALUES ('CLAIM', ?, 'Claim', 'npm', 'vcs', 'https://private.test/repo.git')",
        [orgId],
      );
      await sql(
        'INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, ?, ?, ?)',
        [ulid(), orgId, 'CLAIM', 'npm', 'left-pad'],
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
      expect(logged.join('')).not.toMatch(/@private|reader@example|__Host-pb_session/);
    });

    it('distinguishes no attached proxy from the disabled off switch without outbound traffic', async () => {
      const transport = vi.fn(async () => Response.json({}));
      await boot(transport);
      await sql(
        'DELETE FROM project_source WHERE org_id = ? AND project_id = ? AND source_id = ?',
        [orgId, projectId, sources.npm],
      );
      const absent = await audit({ 'left-pad': ['1.0.0'] });
      expect(absent.status).toBe(501);
      expect(await absent.json()).toMatchObject({
        code: 'unsupported',
        error: 'npm audit requires an npmjs.org proxy source in this project',
      });
      await broker!.close();
      broker = undefined;
      await boot(transport, { auditEnabled: false });
      const disabled = await audit({ 'left-pad': ['1.0.0'] });
      expect(disabled.status).toBe(501);
      expect(await disabled.json()).toMatchObject({ code: 'npm_audit_disabled' });
      expect(transport).not.toHaveBeenCalled();
    });
  });

  describe.each([undefined, 'info', 'debug'] as const)('refusals at level %s', (level) => {
    it.each([
      'composer-dist',
      'composer-metadata',
      'npm-tarball',
      'npm-tarball-foreign',
      'npm-packument',
    ] as const)(
      'returns a safe 502 and emits a refusal event only at debug for %s',
      async (fill) => {
        const remote = upstream();
        let refusing = false;
        const sentinel = vi.fn();
        const transport: FetchLike = async (input, init) => {
          const url = String(input);
          if (url.includes('sentinel.invalid') || url.includes('127.0.0.1')) {
            sentinel();
            throw new Error('sentinel reached');
          }
          if (refusing && (fill !== 'composer-metadata' || !url.includes('~dev.json'))) {
            if (fill === 'npm-packument') {
              throw new TypeError('fetch failed', { cause: new DnsGuardError('blocked_address') });
            }
            return Response.redirect('https://sentinel.invalid/private?token=private-secret', 302);
          }
          return remote.transport(input, init);
        };
        await boot(transport, level === undefined ? {} : { level });
        let path: string;
        if (fill === 'composer-dist') {
          const metadata = await get('/alpha/p2/acme/lib.json');
          const body = (await metadata.json()) as {
            packages: Record<string, { dist: { url: string } }[]>;
          };
          path = brokerPath(body.packages['acme/lib']![0]!.dist.url);
          await sql(
            "UPDATE version SET metadata_json = json_set(metadata_json, '$.dist.url', ?) WHERE org_id = ?",
            ['https://127.0.0.1/sentinel?token=private-secret', orgId],
          );
        } else if (fill.startsWith('npm-tarball')) {
          const metadata = await get('/alpha/npm/left-pad');
          const body = (await metadata.json()) as {
            versions: Record<string, { dist: { tarball: string } }>;
          };
          path = brokerPath(body.versions['1.0.0']!.dist.tarball);
          if (fill === 'npm-tarball-foreign')
            await sql(
              "UPDATE version SET metadata_json = json_set(metadata_json, '$.dist.tarball', ?) WHERE org_id = ?",
              ['https://sentinel.invalid/private?token=private-secret', orgId],
            );
        } else
          path = fill === 'composer-metadata' ? '/alpha/p2/acme/fresh.json' : '/alpha/npm/fresh';
        const before = logged.length;
        const auditBefore = await sql('SELECT seq FROM audit_event WHERE org_id = ?', [orgId]);
        refusing = true;
        const response = await get(path);
        expect(response.status).toBe(502);
        const body = await response.text();
        expect(body).toContain('upstream_refused');
        expect(body).not.toMatch(/https?:|sentinel|127\.0\.0\.1|private-secret/);
        const logs = logged
          .slice(before)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        const events = logs.filter((entry) => entry['event'] === 'upstream.refused');
        expect(events).toHaveLength(level === 'debug' ? 1 : 0);
        if (level === 'debug')
          expect(events[0]).toMatchObject({
            level: 'debug',
            source_id: fill.startsWith('composer') ? sources.composer : sources.npm,
            project_id: projectId,
            reason_code:
              fill === 'composer-metadata'
                ? 'upstream.redirect_refused'
                : fill.startsWith('npm-tarball')
                  ? 'upstream.destination'
                  : 'upstream.blocked_address',
          });
        expect(JSON.stringify(logs)).not.toMatch(/sentinel|127\.0\.0\.1|private-secret/);
        expect(sentinel).not.toHaveBeenCalled();
        expect(await sql('SELECT seq FROM audit_event WHERE org_id = ?', [orgId])).toEqual(
          auditBefore,
        );
      },
    );
  });

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

  describe('over-cap archive', () => {
    const BLOB_CAP = 1_048_576;
    const POLICY_CAP = 64 * 1024 * 1024;

    async function storedFiles(): Promise<string[]> {
      const entries = await readdir(join(directory, 'blobs'), {
        recursive: true,
        withFileTypes: true,
      }).catch(() => []);
      return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    }

    it.each([
      ['over the blob store cap', 'store'],
      ['declared over the policy fetch cap', 'declared'],
    ] as const)(
      'refuses a Composer dist %s with 502, quarantines the version and stores nothing',
      async (_label, mode) => {
        const remote = upstream();
        const archives: string[] = [];
        const transport: FetchLike = async (input, init) => {
          const url = new URL(new Request(input, init).url);
          if (url.hostname !== 'codeload.github.com') return remote.transport(input, init);
          archives.push(url.href);
          return mode === 'store'
            ? new Response(new Uint8Array(BLOB_CAP + 1).fill(7), {
                headers: { 'content-type': 'application/zip' },
              })
            : new Response(ZIP, {
                headers: {
                  'content-type': 'application/zip',
                  'content-length': String(POLICY_CAP + 1),
                },
              });
        };
        await boot(transport, { level: 'info' });
        const metadata = await get('/alpha/p2/acme/lib.json');
        const body = (await metadata.json()) as {
          packages: Record<string, { dist: { url: string } }[]>;
        };
        const path = brokerPath(body.packages['acme/lib']![0]!.dist.url);
        const before = logged.length;

        const response = await get(path);
        expect(response.status).toBe(502);
        expect(await response.json()).toMatchObject({ error: { code: 'bad_gateway' } });
        expect(
          await sql<{ status: string; blob_id: string | null }>(
            'SELECT status, blob_id FROM version WHERE org_id = ?',
            [orgId],
          ),
        ).toEqual([{ status: 'quarantined', blob_id: null }]);
        expect(await sql('SELECT id FROM blob WHERE org_id = ?', [orgId])).toEqual([]);
        expect(await storedFiles()).toEqual([]);
        const events = logged
          .slice(before)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .filter((entry) => entry['event'] === 'dist.quarantined');
        expect(events).toEqual([
          expect.objectContaining({
            level: 'warn',
            reason_code: 'archive_too_large',
            source_id: sources.composer,
            package_key: 'acme/lib',
          }),
        ]);

        const fetched = archives.length;
        expect((await get(path)).status).not.toBe(200);
        expect(archives).toHaveLength(fetched);
      },
    );
  });

  describe('upstream error with an over-cap declared length', () => {
    it.each([404, 503])(
      'keeps the version active and logs no quarantine when upstream answers %s',
      async (status) => {
        const remote = upstream();
        const transport: FetchLike = async (input, init) => {
          const url = new URL(new Request(input, init).url);
          if (url.hostname !== 'codeload.github.com') return remote.transport(input, init);
          return new Response('error page', {
            status,
            headers: { 'content-length': String(64 * 1024 * 1024 + 1) },
          });
        };
        await boot(transport, { level: 'info' });
        const metadata = await get('/alpha/p2/acme/lib.json');
        const body = (await metadata.json()) as {
          packages: Record<string, { dist: { url: string } }[]>;
        };
        const before = logged.length;
        const response = await get(brokerPath(body.packages['acme/lib']![0]!.dist.url));
        expect(response.status).not.toBe(200);
        expect(
          await sql<{ status: string }>('SELECT status FROM version WHERE org_id = ?', [orgId]),
        ).toEqual([{ status: 'active' }]);
        expect(
          logged
            .slice(before)
            .map((line) => JSON.parse(line) as Record<string, unknown>)
            .filter((entry) => entry['event'] === 'dist.quarantined'),
        ).toEqual([]);
      },
    );
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
      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('60');
      expect(await response.text()).not.toContain('tok-registry-secret-1');
      expect(remote.urls.some((url) => url.startsWith('https://npm.acme.test/'))).toBe(false);
      expect(logged.join('\n')).not.toContain('tok-registry-secret-1');
    });

    it('records credential_unavailable once on the source and logs the reason code', async () => {
      const remote = upstream();
      await scopedSource(await sealed(OTHER_KEY));
      await boot(remote.transport);
      const state = () =>
        sql<{ last_error: string | null; status: string; consecutive_failures: number }>(
          "SELECT last_error, status, consecutive_failures FROM source WHERE org_id = ? AND name = 'acme-npm'",
          [orgId],
        );
      const before = (await state())[0]!;
      await sql('CREATE TEMP TABLE last_error_writes (n INTEGER)');
      await sql(
        'CREATE TEMP TRIGGER count_last_error AFTER UPDATE OF last_error ON source BEGIN INSERT INTO last_error_writes VALUES (1); END',
      );
      for (let i = 0; i < 4; i += 1)
        expect((await get('/alpha/npm/@acme%2Fwidget')).status).toBe(503);
      expect(await sql('SELECT count(*) AS n FROM last_error_writes')).toEqual([{ n: 1 }]);
      expect(await state()).toEqual([{ ...before, last_error: 'credential_unavailable' }]);
      const events = logged.map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(events).toContainEqual(
        expect.objectContaining({
          event: 'source.unavailable',
          reason_code: 'credential_unavailable',
        }),
      );
      expect(logged.join('\n')).not.toContain('npm.acme.test');
      expect(logged.join('\n')).not.toContain('tok-registry-secret-1');
    });

    it('treats a source with a malformed url as unavailable without opening its credential', async () => {
      const statements: string[] = [];
      let access: Parameters<NonNullable<RegistrySeams['observeCredentials']>>[0] | undefined;
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

  describe('packagist proxy credential', () => {
    async function credentialedPackagist(): Promise<void> {
      await sql('UPDATE source SET credential_id = ?, config_json = ? WHERE id = ?', [
        await sealed(KEY),
        JSON.stringify({ githubToken: true }),
        sources.composer,
      ]);
    }

    async function fillAndDownload(remote: Upstream): Promise<void> {
      await credentialedPackagist();
      await boot(remote.transport);
      const metadata = (await (await get('/alpha/p2/acme/lib.json')).json()) as {
        packages: Record<string, { dist: { url: string } }[]>;
      };
      expect((await get(brokerPath(metadata.packages['acme/lib']![0]!.dist.url))).status).toBe(200);
    }

    it('sends the token to the GitHub dist origin', async () => {
      const remote = upstream();
      await fillAndDownload(remote);

      const github = [...remote.headers].filter(([url]) =>
        /^https:\/\/(api|codeload)\.github\.com\//.test(url),
      );
      expect(github.length).toBeGreaterThan(0);
      for (const [, headers] of github) {
        expect(headers.get('authorization')).toBe('Bearer tok-registry-secret-1');
      }
    });

    it('never sends the token to repo.packagist.org', async () => {
      const remote = upstream();
      await fillAndDownload(remote);

      const packagist = [...remote.headers].filter(([url]) =>
        url.startsWith('https://repo.packagist.org/'),
      );
      expect(packagist.length).toBeGreaterThan(0);
      for (const [, headers] of packagist) {
        expect(headers.get('authorization')).toBeNull();
      }
    });

    it('never logs the token', async () => {
      await fillAndDownload(upstream());

      expect(logged.join('\n')).not.toContain('tok-registry-secret-1');
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
      await boot(remote.transport, {
        jobs: {
          async enqueueStatements() {
            throw new Error('not_implemented');
          },
          enqueue,
          get: async () => null,
        },
      });

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

    it('closes within the deadline when an access touch never resolves, and still closes the database', async () => {
      const remote = upstream();
      const statements: string[] = [];
      let closed = false;
      const executor = spied(db.executor, statements);
      const hung: SqlExecutor = {
        driver: executor.driver,
        all: (statement) => executor.all(statement),
        batch: (batch) =>
          batch.some((statement) => statement.sql.includes('set "last_accessed_at"'))
            ? new Promise(() => undefined)
            : executor.batch(batch),
      };
      await boot(remote.transport, {
        executor: hung,
        shutdownDeadlineMs: 150,
        closeDatabase: async () => {
          closed = true;
        },
      });
      const metadata = (await (await get('/alpha/p2/acme/lib.json')).json()) as {
        packages: Record<string, { dist: { url: string } }[]>;
      };
      const dist = brokerPath(metadata.packages['acme/lib']![0]!.dist.url);
      expect((await get(dist)).status).toBe(200);

      const started = Date.now();
      await broker!.close();
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(closed).toBe(true);
    });

    it('closes within the deadline when kernel background work never settles', async () => {
      const remote = upstream();
      const enqueue = vi.fn(() => new Promise<{ id: string; created: boolean }>(() => undefined));
      let closed = false;
      await boot(remote.transport, {
        jobs: {
          async enqueueStatements() {
            throw new Error('not_implemented');
          },
          enqueue,
          get: async () => null,
        },
        shutdownDeadlineMs: 150,
        closeDatabase: async () => {
          closed = true;
        },
      });
      expect((await get('/alpha/p2/acme/lib.json')).status).toBe(200);
      await sql("UPDATE upstream_state SET fresh_until = '2000-01-01T00:00:00.000Z'");
      const kernel = await broker!.ready();
      const response = await kernel.fetch(
        new Request(`${ORIGIN}/alpha/p2/acme/lib.json`, { headers: { cookie } }),
      );
      expect(response.status).toBe(200);
      await vi.waitFor(() => expect(enqueue).toHaveBeenCalled());

      const started = Date.now();
      await broker!.close();
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(closed).toBe(true);
    });

    it('logs a fixed warn event when the drain deadline is hit', async () => {
      const remote = upstream();
      const hung: SqlExecutor = {
        driver: db.executor.driver,
        all: (statement) => db.executor.all(statement),
        batch: (batch) =>
          batch.some((statement) => statement.sql.includes('set "last_accessed_at"'))
            ? new Promise(() => undefined)
            : db.executor.batch(batch),
      };
      await boot(remote.transport, { executor: hung, shutdownDeadlineMs: 100 });
      const metadata = (await (await get('/alpha/p2/acme/lib.json')).json()) as {
        packages: Record<string, { dist: { url: string } }[]>;
      };
      expect((await get(brokerPath(metadata.packages['acme/lib']![0]!.dist.url))).status).toBe(200);
      await broker!.close();
      expect(
        logged.some((line) => line.includes('"event":"shutdown.registry_drain_timeout"')),
      ).toBe(true);
      expect(logged.find((line) => line.includes('registry_drain_timeout'))).toBe(
        JSON.stringify({ level: 'warn', event: 'shutdown.registry_drain_timeout' }),
      );
    });

    it('tracks the npm stale-while-revalidate background work through the execution port', async () => {
      const remote = upstream();
      const enqueue = vi.fn(async () => ({ id: 'job-1', created: true }));
      await boot(remote.transport, {
        jobs: {
          async enqueueStatements() {
            throw new Error('not_implemented');
          },
          enqueue,
          get: async () => null,
        },
      });
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
      await boot(remote.transport, {
        jobs: {
          async enqueueStatements() {
            throw new Error('not_implemented');
          },
          enqueue,
          get: async () => null,
        },
      });
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

async function requireNpm(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  try {
    await promisify(execFile)('npm', ['--version'], { env, timeout: 3000 });
  } catch {
    throw new Error('npm whoami CLI tests require npm on PATH');
  }
}

it('reports the npm on PATH requirement immediately when missing', async () => {
  await expect(requireNpm({ PATH: '' })).rejects.toThrow(
    'npm whoami CLI tests require npm on PATH',
  );
});

async function seedWhoamiTokens(executor: SqlExecutor, orgId: string, projectId: string) {
  const run = (sql: string, params: (string | number | null)[]) =>
    executor.batch([{ sql, params }]);
  const [user] = await executor.all<{ id: string }>({
    sql: 'SELECT id FROM user_account WHERE org_id = ?',
    params: [orgId],
  });
  const serviceId = ulid();
  await run(
    'INSERT INTO service_principal (id, org_id, name, project_id, created_by_user_id) VALUES (?, ?, ?, ?, ?)',
    [serviceId, orgId, 'build-bot', projectId, user!.id],
  );
  await run(
    'INSERT INTO service_principal_permission (org_id, service_principal_id, permission) VALUES (?, ?, ?)',
    [orgId, serviceId, 'project:read'],
  );
  const keyring = createKeyring([parseMasterKey(KEY, 'PB_MASTER_KEY')]);
  const cases: { token: string; username: string | null }[] = [];
  for (const kind of ['pat', 'svc'] as const) {
    const selector = kind === 'pat' ? 'aaaaaaaaaaaa' : 'bbbbbbbbbbbb';
    const token = formatToken(kind, selector, crypto.getRandomValues(new Uint8Array(32)));
    await run(
      `INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, read_only,
      user_id, service_principal_id, project_id, created_by_user_id, expires_at, project_mode, validation_kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ulid(),
        orgId,
        kind,
        selector,
        await hashToken(keyring, keyring.currentVersion, token),
        keyring.currentVersion,
        'whoami-fixture',
        '["read"]',
        kind === 'pat' ? user!.id : null,
        kind === 'svc' ? serviceId : null,
        kind === 'svc' ? projectId : null,
        user!.id,
        new Date(Date.now() + 3600000).toISOString(),
        'all',
        kind === 'pat' ? 'local' : null,
      ],
    );
    cases.push({ token, username: kind === 'pat' ? 'reader' : 'build-bot' });
  }
  cases.push({ token: formatToken('pat', 'cccccccccccc', new Uint8Array(32)), username: null });
  return cases;
}

async function npmWhoami(
  call: (path: string, headers: Headers) => Promise<Response>,
  prefix: string,
  cases: readonly { token: string; username: string | null }[],
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'pb-npm-whoami-'));
  const statuses: number[] = [];
  const server = createServer((request, response) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers as IncomingHttpHeaders)) {
      if (Array.isArray(value)) for (const entry of value) headers.append(name, entry);
      else if (value !== undefined) headers.set(name, value);
    }
    void call(request.url ?? '/', headers)
      .then(async (reply) => {
        statuses.push(reply.status);
        response.writeHead(reply.status, Object.fromEntries(reply.headers));
        response.end(await reply.text());
      })
      .catch(() => response.writeHead(500).end());
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as AddressInfo).port;
    for (const { token, username } of cases) {
      statuses.length = 0;
      await writeFile(
        join(directory, 'npmrc'),
        `//127.0.0.1:${port}${prefix}:_authToken=${token}\n`,
        { mode: 0o600 },
      );
      const result = await promisify(execFile)(
        'npm',
        [
          'whoami',
          `--registry=http://127.0.0.1:${port}${prefix}`,
          `--userconfig=${join(directory, 'npmrc')}`,
          `--globalconfig=${join(directory, 'global-npmrc')}`,
          '--update-notifier=false',
          '--fetch-retries=0',
          '--loglevel=silent',
        ],
        {
          timeout: 5000,
          env: { ...process.env, HOME: directory, npm_config_cache: join(directory, 'cache') },
        },
      ).then(
        ({ stdout }) => ({ ok: true, stdout }),
        () => ({ ok: false, stdout: '' }),
      );
      expect(statuses).toEqual([username === null ? 401 : 200]);
      expect(result.ok).toBe(username !== null);
      expect(result.stdout.trim()).toBe(username ?? '');
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}
