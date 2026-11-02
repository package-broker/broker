import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newSessionSecrets } from '@package-broker/core/auth/session';
import type { SqlValue } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import { createBlobStore, createBlobUploadAdmission } from '@package-broker/core/platform/blob';
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
import { openFilesystemByteStore } from '../blob/filesystem.js';
import { createLruCache } from '../cache/lru.js';
import type { NodeBroker } from '../index.js';
import { createLocalLoginSeed } from '../testing/local-login.js';
import { createNodeServerWithSeams } from '../testing/node-server.js';

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
const { POLICY_COMPOSER_PACKAGE, policyUpstream } = matrix;

const KEY = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const ORIGIN = 'https://broker.test';
const PERMISSIONS = [
  'org:read',
  'org:packages:read',
  'org:packages:manage',
  'org:settings:write',
  'project:read',
  'project:packages:read',
  'project:packages:manage',
  'project:settings:write',
];

interface Harness {
  readonly db: MigratedDatabase;
  readonly orgId: string;
  readonly sessionId: string;
  readonly cookie: string;
  readonly csrf: string;
  readonly directory: string;
  readonly upstream: PolicyUpstream;
  readonly calls: string[];
  readonly logs: string[];
  readonly brokers: NodeBroker[];
}

async function harness(): Promise<Harness> {
  const db = await openMigratedDatabase();
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'pb-policy-matrix-')));
  const sql = (statement: string, params: SqlValue[] = []) =>
    db.executor.all({ sql: statement, params });
  const org = await createOrganizationBootstrap(db.executor).bootstrap({
    id: ulid(),
    slug: 'acme',
    name: 'Acme',
    now: new Date().toISOString(),
  });
  const orgId = org.id;
  const userId = ulid();
  const roleId = ulid();
  const sessionId = ulid();
  const secrets = await newSessionSecrets();
  await sql('INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)', [
    userId,
    orgId,
    'manager@example.test',
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
  const now = new Date().toISOString();
  await sql(
    'INSERT INTO local_login (user_id, org_id, password_hash, totp_credential_id, totp_enabled_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)',
    [userId, orgId, passwordHash, credentialId, now, now],
  );
  await sql(
    "INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, 'manager', 'Manager', 'organization', 1)",
    [roleId, orgId],
  );
  for (const permission of PERMISSIONS) {
    await sql('INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)', [
      orgId,
      roleId,
      permission,
    ]);
  }
  await sql(
    "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id) VALUES (?, ?, 'email', ?, 'organization', ?)",
    [ulid(), orgId, 'manager@example.test', roleId],
  );
  await sql(
    'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    [
      sessionId,
      orgId,
      userId,
      secrets.secretHash,
      secrets.csrfHash,
      new Date(Date.now() + 3_600_000).toISOString(),
    ],
  );
  await sql("INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, 'alpha', 'Alpha')", [
    ulid(),
    orgId,
  ]);
  for (const [ecosystem, type, url] of [
    ['npm', 'npmjs_proxy', 'https://registry.npmjs.org'],
    ['composer', 'packagist_proxy', 'https://repo.packagist.org'],
  ] as const) {
    const sourceId = ulid();
    await sql(
      'INSERT INTO source (id, org_id, name, ecosystem, type, url, default_visible_to_new_projects) VALUES (?, ?, ?, ?, ?, ?, 1)',
      [sourceId, orgId, type, ecosystem, type, url],
    );
    await sql(
      "INSERT INTO project_source (org_id, project_id, source_id) SELECT ?, id, ? FROM project WHERE org_id = ? AND slug = 'alpha'",
      [orgId, sourceId, orgId],
    );
  }
  return {
    db,
    orgId,
    sessionId,
    cookie: `__Host-pb_session=${secrets.secret}; __Host-pb_csrf=${secrets.csrf}`,
    csrf: secrets.csrf,
    directory,
    upstream: await policyUpstream(new Date()),
    calls: [],
    logs: [],
    brokers: [],
  };
}

function transport(h: Harness): FetchLike {
  return async (input, init) => {
    const request = new Request(input, init);
    h.calls.push(request.url);
    const url = new URL(request.url);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json', etag: '"v1"' },
      });
    if (url.hostname === 'registry.npmjs.org' && url.pathname.endsWith('.tgz')) {
      const version = /-(\d+\.\d+\.\d+)\.tgz$/.exec(url.pathname)?.[1] ?? '';
      return new Response(h.upstream.tarball(version));
    }
    if (url.hostname === 'registry.npmjs.org') {
      return json(h.upstream.packument(decodeURIComponent(url.pathname.slice(1))));
    }
    if (url.hostname === 'repo.packagist.org') {
      return url.pathname.endsWith('~dev.json')
        ? json({ minified: 'composer/2.0', packages: { [POLICY_COMPOSER_PACKAGE]: [] } })
        : json(h.upstream.composer());
    }
    if (url.hostname === 'codeload.github.com' || url.hostname === 'api.github.com') {
      return new Response(h.upstream.zip, { headers: { 'content-type': 'application/zip' } });
    }
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  };
}

async function boot(h: Harness, enabled: boolean): Promise<NodeBroker> {
  const byteStore = await openFilesystemByteStore({ root: join(h.directory, 'blobs') });
  const broker = createNodeServerWithSeams(
    [],
    {
      executor: h.db.executor,
      auth: {
        keyring: createKeyring([parseMasterKey(KEY, 'PB_MASTER_KEY')]),
        publicOrigin: ORIGIN,
        env: {},
      },
      platformServices: {
        blob: createBlobStore(
          byteStore,
          createBlobRepository(h.db.executor, { purgeLeaseSeconds: 900 }),
          {
            admission: createBlobUploadAdmission(),
            maxBytes: 1_048_576,
          },
        ),
        cache: createLruCache({}),
        jobStore: createJobRepository(h.db.executor),
      },
      registry: {
        config: resolveRegistryConfig(
          enabled ? { policy: { enabled: true } } : undefined,
          'node',
          ORIGIN,
        ),
      },
      log: (record) => void h.logs.push(JSON.stringify(record)),
    },
    { transport: transport(h) },
  );
  h.brokers.push(broker);
  await broker.ready();
  return broker;
}

function brokerOf(h: Harness, broker: NodeBroker): PolicyBroker {
  const sql = <T extends object>(statement: string, params: SqlValue[] = []) =>
    h.db.executor.all<T>({ sql: statement, params });
  return {
    project: 'alpha',
    async fetch(path: string, init: PolicyRequestInit = {}) {
      const kernel = await broker.ready();
      const write = init.method !== undefined && init.method !== 'GET' && init.method !== 'HEAD';
      return kernel.fetch(
        new Request(`${ORIGIN}${path}`, {
          method: init.method ?? 'GET',
          headers: {
            ...(init.session === false
              ? {}
              : {
                  cookie: h.cookie,
                  ...(write ? { 'x-csrf-token': h.csrf, origin: ORIGIN } : {}),
                }),
            ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
            ...init.headers,
          },
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        }),
      );
    },
    async reauth() {
      await sql(
        "UPDATE session SET reauth_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
        [h.sessionId],
      );
    },
    async dropReauth() {
      await sql('UPDATE session SET reauth_at = NULL WHERE id = ?', [h.sessionId]);
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
      await sql(
        "CREATE TRIGGER refuse_read_denied BEFORE INSERT ON audit_pending WHEN NEW.action = 'policy.read_denied' BEGIN SELECT RAISE(ABORT, 'audit sink unavailable'); END",
      );
    },
    async restoreReadAudit() {
      await sql('DROP TRIGGER refuse_read_denied');
    },
    async expireRule(id) {
      await sql(
        "UPDATE registry_policy_rule SET created_at = '2026-01-01T00:00:00.000Z', updated_at = '2026-01-01T00:00:00.000Z', expires_at = '2026-01-02T00:00:00.000Z' WHERE org_id = ? AND id = ?",
        [h.orgId, id],
      );
    },
    async setVersionStatus(name, version, status) {
      await sql(
        'UPDATE version SET status = ? WHERE org_id = ? AND version = ? AND package_id IN (SELECT id FROM package WHERE org_id = ? AND name = ?)',
        [status, h.orgId, version, h.orgId, name],
      );
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
    logs: () => h.logs.join('\n'),
  };
}

describe('registry policy HTTP matrix on Node with SQLite and the filesystem blob store', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(async () => {
    for (const broker of h.brokers) await broker.close();
    await h.db.close();
    await rm(h.directory, { recursive: true, force: true });
  });

  it('filters warm metadata after real rule writes and keeps decision-aware validators (NPM27-53)', async () => {
    const broker = brokerOf(h, await boot(h, true));
    expect(await matrix.policyMetadataMatrix(broker)).toEqual(matrix.POLICY_METADATA_EXPECTED);
  });

  it('refuses cached and fresh deliveries after a real block (NPM27-54)', async () => {
    const broker = brokerOf(h, await boot(h, true));
    expect(await matrix.policyDistMatrix(broker)).toEqual(matrix.POLICY_DIST_EXPECTED);
  });

  it('audits overrides, keeps unrelated holds and leaks no planted secret (NPM27-55)', async () => {
    const broker = brokerOf(h, await boot(h, true));
    expect(await matrix.policyAdminMatrix(broker)).toEqual(matrix.POLICY_ADMIN_EXPECTED);
  });

  it('defaults off, enforces once enabled and keeps stored rules across flag changes (NPM27-57)', async () => {
    const result = await matrix.policyRolloutMatrix({
      boot: async (enabled) => {
        for (const broker of h.brokers.splice(0)) await broker.close();
        return brokerOf(h, await boot(h, enabled));
      },
      bootFails: async (enabled) => {
        try {
          await boot(h, enabled);
          return false;
        } catch {
          return true;
        } finally {
          for (const broker of h.brokers.splice(0)) await broker.close().catch(() => undefined);
        }
      },
      storedRules: async () =>
        (
          await h.db.executor.all<{ n: number }>({
            sql: 'SELECT count(*) AS n FROM registry_policy_rule WHERE org_id = ?',
            params: [h.orgId],
          })
        )[0]!.n,
      dropPolicySchema: async () => {
        await h.db.executor.all({ sql: 'DROP TABLE registry_policy_version', params: [] });
        await h.db.executor.all({ sql: 'DROP TABLE registry_policy_rule', params: [] });
      },
    });
    expect(result).toEqual(matrix.POLICY_ROLLOUT_EXPECTED);
  });

  describe('Node wiring and boot (NPM27-49)', () => {
    it('refuses to start with policy enabled when the policy migration is missing', async () => {
      await h.db.executor.all({ sql: 'DROP TABLE registry_policy_version', params: [] });
      await h.db.executor.all({ sql: 'DROP TABLE registry_policy_rule', params: [] });
      await expect(boot(h, true)).rejects.toMatchObject({
        name: 'KernelConfigError',
        message: 'registry.policy.enabled: the registry policy migration is missing',
      });
      await expect(boot(h, false)).resolves.toBeDefined();
    });

    it('registers the expiry job only with the flag on and the management routes whenever the schema exists', async () => {
      const on = await (await boot(h, true)).ready();
      const off = await (await boot(h, false)).ready();
      const jobs = (kernel: typeof on) => kernel.registration.jobs.map((job) => job.qualifiedName);
      expect(jobs(on)).toContain('core:registry-policy-expire:v1');
      expect(jobs(off)).not.toContain('core:registry-policy-expire:v1');
      const management = async (kernel: typeof on) =>
        (
          await kernel.fetch(
            new Request(`${ORIGIN}/_pb/policies`, { headers: { cookie: h.cookie } }),
          )
        ).status;
      expect(await management(on)).toBe(200);
      expect(await management(off)).toBe(200);
      await h.db.executor.all({ sql: 'DROP TABLE registry_policy_version', params: [] });
      await h.db.executor.all({ sql: 'DROP TABLE registry_policy_rule', params: [] });
      expect(await management(await (await boot(h, false)).ready())).toBe(404);
    });

    it('boots without a database whatever the flag says, as before the policy probe', async () => {
      for (const enabled of [false, true]) {
        const broker = createNodeServerWithSeams(
          [],
          {
            registry: {
              config: resolveRegistryConfig(
                enabled ? { policy: { enabled: true } } : undefined,
                'node',
                ORIGIN,
              ),
            },
          },
          {},
        );
        h.brokers.push(broker);
        await expect(broker.ready()).resolves.toBeDefined();
      }
    });
  });
});
