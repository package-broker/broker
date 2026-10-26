import { afterEach, expect, it, vi } from 'vitest';
import { newSessionSecrets } from '@package-broker/core/auth/session';
import type { Statement } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import { IMPORT_RUN_JOB } from '@package-broker/core/import/run-service';
import type { BlobStore } from '@package-broker/core/platform/blob';
import type { PluginDefinition } from '@package-broker/core/plugin';
import { resolveRegistryConfig } from '@package-broker/core/registry/registry-config';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { parseMasterKey } from '@package-broker/core/secrets/master-key';
import {
  createPackageDescription,
  type SourceProvider,
} from '@package-broker/core/sources/provider';
import { createBlobRepository } from '@package-broker/db-sqlite/repositories/blob';
import { createJobRepository } from '@package-broker/db-sqlite/repositories/job';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { openMigratedDatabase } from '@package-broker/db-sqlite/testing/migrated-database';
import { createLruCache } from './cache/lru.js';
import { createNodeServer } from './index.js';
import { createJobLoop } from './jobs/loop.js';
import { createLocalLoginSeed } from './testing/local-login.js';

const ORIGIN = 'https://broker.test';
const KEY = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function testImport(legacy: boolean) {
  const db = await openMigratedDatabase();
  cleanup.push(db.close);
  const orgId = ulid();
  const userId = ulid();
  const roleId = ulid();
  const credentialId = ulid();
  const now = new Date().toISOString();
  const s = (sql: string, ...params: Statement['params']): Statement => ({ sql, params });
  await createOrganizationBootstrap(db.executor).bootstrap({
    id: orgId,
    slug: 'acme',
    name: 'Acme',
    now,
  });
  await db.executor.batch([
    s(
      'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
      userId,
      orgId,
      'admin@example.test',
    ),
  ]);
  const keyring = createKeyring([parseMasterKey(KEY, 'PB_MASTER_KEY')]);
  const { sealed, aad, passwordHash } = await createLocalLoginSeed(db.executor, keyring, {
    orgId,
    userId,
    credentialId,
  });
  const session = await newSessionSecrets();
  await db.executor.batch([
    s(
      "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES (?, ?, 'totp', ?, ?, ?, ?)",
      credentialId,
      orgId,
      sealed.ciphertext,
      sealed.nonce,
      sealed.keyVersion,
      aad,
    ),
    s(
      'INSERT INTO local_login (user_id, org_id, password_hash, totp_credential_id, totp_enabled_at) VALUES (?, ?, ?, ?, ?)',
      userId,
      orgId,
      passwordHash,
      credentialId,
      now,
    ),
    s(
      "INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, 'importer', 'Importer', 'organization', 1)",
      roleId,
      orgId,
    ),
    ...['org:import:write', 'org:import:approve', 'org:sources:write', 'project:packages:read'].map(
      (permission) =>
        s(
          'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
          orgId,
          roleId,
          permission,
        ),
    ),
    s(
      "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id) VALUES (?, ?, 'email', 'admin@example.test', 'organization', ?)",
      ulid(),
      orgId,
      roleId,
    ),
    s(
      'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, expires_at, reauth_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ulid(),
      orgId,
      userId,
      session.secretHash,
      session.csrfHash,
      new Date(Date.now() + 3_600_000).toISOString(),
      now,
    ),
  ]);

  const metadata = createBlobRepository(db.executor);
  const objects = new Map<string, Uint8Array>();
  const blobs: BlobStore = {
    async put(org, sha, body, info) {
      objects.set(`${org.orgId}:${sha}`, new Uint8Array(await new Response(body).arrayBuffer()));
      const generation = await metadata.reserve(org, sha);
      const row = await metadata.publish(org, { ...info, sha256: sha, generation });
      if (row === null) throw new Error('blob publication refused');
      return row;
    },
    async get(org, sha) {
      const bytes = objects.get(`${org.orgId}:${sha}`);
      return bytes === undefined
        ? null
        : {
            body: new Response(bytes).body!,
            info: {
              sha256: sha,
              generation: '',
              size: bytes.length,
              mediaType: 'application/json',
              purgeAfter: null,
            },
          };
    },
    head: async () => null,
  };
  const describe = vi.fn<SourceProvider['describe']>(async (_context, _source, name) => ({
    kind: 'found',
    description: createPackageDescription({
      name,
      snapshot: { id: '"git-fixture"' },
      validators: {},
      documentsComplete: true,
      members: (async function* () {
        yield {
          ordinal: 0,
          version: '1.0.0',
          form: 'composer-p2' as const,
          raw: JSON.stringify({
            name,
            version: '1.0.0',
            dist: { type: 'zip', url: 'https://git.example.test/acme/widget/archive.zip' },
          }),
        };
      })(),
    }),
  }));
  const plugin: PluginDefinition = {
    id: 'import-git-fixture',
    package: '@test/import-git-fixture',
    apiVersion: 3,
    platforms: ['node'],
    binds: ['source'],
    sourceProviders: () => [
      {
        id: 'git',
        sourceTypes: ['vcs'],
        ecosystems: ['composer'],
        describe,
        openDist: async () => {
          throw new Error('unused');
        },
      },
    ],
  };
  const records: Readonly<Record<string, unknown>>[] = [];
  const broker = createNodeServer([plugin], {
    executor: db.executor,
    auth: { keyring, publicOrigin: ORIGIN, env: {} },
    platformServices: {
      blob: blobs,
      cache: createLruCache({}),
      jobStore: createJobRepository(db.executor),
    },
    registry: { config: resolveRegistryConfig(undefined, 'node', ORIGIN) },
    log: (record) => {
      records.push(record);
    },
  });
  cleanup.push(() => broker.close());
  const kernel = await broker.ready();
  const request = (path: string, method = 'GET', body?: unknown) =>
    kernel.fetch(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: {
          cookie: `__Host-pb_session=${session.secret}; __Host-pb_csrf=${session.csrf}`,
          origin: ORIGIN,
          'x-csrf-token': session.csrf,
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const config = {
    provider: 'git',
    repository: 'https://git.example.test/acme/widget.git',
    installationId: null,
    packageName: null,
    refs: { tags: true, branches: ['main'] },
  };
  const created = await request('/_pb/import-runs', 'POST', {
    version: 1,
    source_system: 'test',
    widening: [],
    items: [
      { type: 'project', external_ref: 'project', slug: 'imported', name: 'Imported' },
      {
        type: 'source',
        external_ref: 'source',
        name: 'generic-git',
        ecosystem: 'composer',
        source_type: 'vcs',
        project: null,
        url: null,
        credential_ref: null,
        config,
      },
      {
        type: 'name',
        external_ref: 'name',
        source: { ref: 'source' },
        ecosystem: 'composer',
        pattern: 'acme/*',
      },
      {
        type: 'attachment',
        external_ref: 'attachment',
        project: { ref: 'project' },
        source: { ref: 'source' },
        precedence: 10,
      },
    ],
  });
  expect(created.status).toBe(201);
  const run = (await created.json()) as { id: string; planHash: string };
  expect(
    (await request(`/_pb/import-runs/${run.id}/approve`, 'POST', { planHash: run.planHash }))
      .status,
  ).toBe(204);
  expect((await request(`/_pb/import-runs/${run.id}/apply`, 'POST')).status).toBe(204);
  const loop = createJobLoop({
    executor: db.executor,
    jobs: kernel.registration.jobs.filter((job) => job.qualifiedName === IMPORT_RUN_JOB.apply),
    scope: kernel.jobScope,
    observability: { log: () => undefined, counter: () => undefined, histogram: () => undefined },
  });
  cleanup.push(() => loop.stop());
  loop.start();
  await vi.waitFor(
    async () => {
      expect(
        await db.executor.all(
          s('SELECT state FROM import_run WHERE org_id = ? AND id = ?', orgId, run.id),
        ),
      ).toEqual([{ state: 'applied' }]);
    },
    { timeout: 15000, interval: 25 },
  );
  const [source] = await db.executor.all<{ id: string; status: string; config_json: string }>(
    s(
      'SELECT id, status, config_json FROM source WHERE org_id = ? AND name = ?',
      orgId,
      'generic-git',
    ),
  );
  expect(source).toMatchObject({ status: 'paused' });
  expect(JSON.parse(source!.config_json)).toEqual({
    provider: config.provider,
    repository: config.repository,
    refs: config.refs,
  });
  if (legacy) {
    // Reproduce the JSON written before import configs were converted for storage.
    await db.executor.batch([
      s(
        'UPDATE source SET config_json = ? WHERE org_id = ? AND id = ?',
        JSON.stringify(config),
        orgId,
        source!.id,
      ),
    ]);
  }
  expect((await request(`/_pb/sources/${source!.id}/enable`, 'POST')).status).toBe(204);
  await loop.stop();
  // An unsynced catalogue entry makes the metadata request exercise registry binding.
  const packageId = ulid();
  await db.executor.batch([
    s(
      "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES (?, ?, ?, 'composer', 'acme/widget')",
      packageId,
      orgId,
      source!.id,
    ),
    s(
      "INSERT INTO project_package (org_id, project_id, package_id, origin, ecosystem, name) SELECT org_id, id, ?, 'subscription', 'composer', 'acme/widget' FROM project WHERE org_id = ? AND slug = 'imported'",
      packageId,
      orgId,
    ),
  ]);
  const response = await request('/imported/p2/acme/widget.json');
  expect(records).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ reason_code: 'config_invalid' })]),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    packages: { 'acme/widget': [{ version: '1.0.0' }] },
  });
  expect(describe).toHaveBeenCalled();
  expect(describe.mock.calls[0]![1]).toMatchObject({
    id: source!.id,
    type: 'vcs',
    config: {
      provider: 'git',
      repository: config.repository,
      refs: config.refs,
    },
  });
  expect(describe.mock.calls[0]![1].config).not.toHaveProperty('installationId');
  expect(describe.mock.calls[0]![1].config).not.toHaveProperty('packageName');
}

it.each([false, true])(
  'applies, enables and binds generic Git (legacy stored nulls: %s)',
  testImport,
);
