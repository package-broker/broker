import { createLocalLoginSeed } from './testing/local-login.js';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newSessionSecrets } from '@package-broker/core/auth/session';
import { orgContext, type SqlValue } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
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
  'core:pat-offboarding:v1',
  'core:pat-offboarding-sweep:v1',
];

function remote(ecosystem: 'npm' | 'composer', count: number) {
  const key = ecosystem === 'npm' ? 'widget' : 'acme/widget';
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

  it('registers package-sync alongside the audit jobs and preserves existing auth jobs', async () => {
    const kernel = await boot(remote('npm', 1).transport);
    expect(kernel.registration.jobs.map((job) => job.qualifiedName).sort()).toEqual(
      [...AUDIT, ...AUTH_JOBS, SYNC, 'core:source-sync:v1', 'core:source-poll:v1'].sort(),
    );
  });

  it('omits package-sync without registry options', async () => {
    const kernel = await boot(remote('npm', 1).transport, false);
    expect(kernel.registration.jobs.map((job) => job.qualifiedName).sort()).toEqual(
      [...AUDIT, ...AUTH_JOBS].sort(),
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
