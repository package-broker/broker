import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importRoutes } from '@package-broker/core/api/routes/import';
import { SESSION_COOKIE } from '@package-broker/core/auth/cookies';
import { sha256Hex } from '@package-broker/core/auth/primitives';
import {
  createAuthorizationEngine,
  patValidationGate,
  type EngineTokenAccess,
} from '@package-broker/core/authz/engine';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { systemClock, ulid } from '@package-broker/core/ids';
import { createImportCredentialService } from '@package-broker/core/import/credentials';
import { createImportRunService } from '@package-broker/core/import/run-service';
import { createKernel } from '@package-broker/core/kernel/kernel';
import { createBlobStore, createBlobUploadAdmission } from '@package-broker/core/platform/blob';
import { createSecretCipher } from '@package-broker/core/secrets/cipher';
import { createCredentialStore } from '@package-broker/core/secrets/credential-store';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { auditPendingStatement } from './audit-pending.js';
import { createBlobRepository } from './blob.js';
import { createCredentialRepository } from './credential.js';
import { createImportCredentialRepository } from './import-credential.js';
import { createImportRunStore } from './import-run.js';

const ORIGIN = 'https://broker.test';
const ROOT = '/_pb/import-runs';
const SECRET = 'A'.repeat(43);
const CSRF = 'B'.repeat(43);
const MATERIAL = 'route-test-only-material';
const anchors = [
  {
    provider: 'oidc',
    anchor: 'oidc:https://idp.example.test',
    emailAuthoritative: true,
    emailAuthoritativeDomains: ['example.test'],
  },
];
const stmt = (sql: string, ...params: Statement['params']): Statement => ({ sql, params });
const source = (ref: string) => ({
  type: 'source',
  external_ref: ref,
  name: ref,
  ecosystem: 'composer',
  source_type: 'composer_repository',
  project: null,
  url: `https://${ref}.example.test/`,
  credential_ref: 'env:REGISTRY_TOKEN',
  config: {
    selection: { packages: [], patterns: [], expandPatterns: false },
    distHosts: [],
    mirrorsFallback: false,
  },
});
const manifest = { version: 1, source_system: 'test', items: [], widening: [] };
const withSources = { ...manifest, items: [source('alpha'), source('beta')] };

describe('import run routes on the SQLite store', () => {
  let database: MigratedDatabase;
  let executor: SqlExecutor;
  let ctx: OrgContext;
  let objects: Map<string, Uint8Array>;
  let barrier: { waiting: number; open: () => void; opened: Promise<void> } | null;
  let request: (
    method: string,
    path: string,
    input?: { body?: unknown; headers?: Record<string, string> },
  ) => Promise<Response>;

  beforeEach(async () => {
    database = await openMigratedDatabase({ twoOrganizations: true });
    executor = database.executor;
    if (database.orgs === null) throw new Error('missing organizations');
    ctx = database.orgs.a;
    await executor.batch([
      stmt(
        "INSERT INTO user_account (id, org_id, email) VALUES ('actor', ?, 'actor@example.test')",
        ctx.orgId,
      ),
      stmt(
        "INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, 'oidc', 'oidc:https://idp.example.test')",
        ctx.orgId,
      ),
      stmt(
        "INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES ('identity', ?, 'actor', 'oidc', 'subject', 'actor@example.test', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        ctx.orgId,
      ),
      stmt(
        "INSERT INTO role (id, org_id, key, name, scope) VALUES ('importer', ?, 'importer', 'Importer', 'organization')",
        ctx.orgId,
      ),
      stmt(
        "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'importer', 'org:import:write')",
        ctx.orgId,
      ),
      stmt(
        "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'importer', 'org:import:approve')",
        ctx.orgId,
      ),
      stmt(
        "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id) VALUES ('grant', ?, 'email', 'actor@example.test', 'organization', 'importer')",
        ctx.orgId,
      ),
      stmt(
        `INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, expires_at, last_seen_at, reauth_at)
        VALUES ('session', ?, 'actor', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour'),
        strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        ctx.orgId,
        'a'.repeat(64),
        'b'.repeat(64),
      ),
    ]);
    objects = new Map<string, Uint8Array>();
    barrier = null;
    const blobs = createBlobStore(
      {
        async putStaged() {
          throw new Error('not_implemented');
        },
        async openStaged() {
          throw new Error('not_implemented');
        },
        async promote() {
          throw new Error('not_implemented');
        },
        async discardStaged() {
          throw new Error('not_implemented');
        },
        async listStaged() {
          throw new Error('not_implemented');
        },
        async putVerified(key, body, input) {
          const gate = barrier;
          if (gate !== null) {
            gate.waiting -= 1;
            if (gate.waiting === 0) gate.open();
            await gate.opened;
          }
          objects.set(key, new Uint8Array(await new Response(body).arrayBuffer()));
          return { size: input.size, mediaType: input.mediaType };
        },
        async get(key) {
          const bytes = objects.get(key);
          return bytes === undefined
            ? null
            : {
                size: bytes.length,
                mediaType: 'application/json',
                range: null,
                body: new Response(bytes).body!,
              };
        },
        async head(key) {
          const bytes = objects.get(key);
          return bytes === undefined ? null : { size: bytes.length, mediaType: 'application/json' };
        },
        async remove(key) {
          objects.delete(key);
        },
      },
      createBlobRepository(executor),
      { admission: createBlobUploadAdmission() },
    );
    const routes = importRoutes({
      service: createImportRunService({
        store: createImportRunStore({ executor, blobs, providerAnchors: anchors }),
        ids: { ulid },
        clock: systemClock,
      }),
      credentials: createImportCredentialService({
        store: createImportCredentialRepository(executor, { blobs, providerAnchors: anchors }),
        credentials: createCredentialStore({
          repository: createCredentialRepository(executor),
          cipher: createSecretCipher(
            createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(7) }]),
            'credential-encryption',
          ),
          ids: { ulid },
          clock: systemClock,
        }),
        runtime: 'node',
        ids: { ulid },
        auditStatement: auditPendingStatement,
      }),
      clock: systemClock,
      ids: { ulid },
      clientIp: () => null,
      auditStatement: auditPendingStatement,
      tokenFence: () => Promise.reject(new Error('token requests are not used here')),
    });
    const csrfHash = await sha256Hex(CSRF);
    const app = await createKernel({
      platform: 'node',
      plugins: [],
      coreRoutes: routes,
      ports: { organizations: { get: async () => null }, clock: systemClock, ids: { ulid } },
      resolveOrg: async () => ctx,
      health: async () => true,
      log: () => undefined,
      authorization: createAuthorizationEngine({
        access: {
          lookupSession: async () => ({
            session: { id: 'session', csrfHash },
            user: { id: 'actor' },
            identity: null,
            protectedHolder: false,
            project: null,
            organizationPermissions: ['org:import:write', 'org:import:approve'],
            projectPermissions: [],
          }),
          lookupToken: async () => null as unknown as EngineTokenAccess,
          touchSession: async () => true,
          touchToken: async () => true,
        },
        tokenUse: {
          keyring: createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(9) }]),
          nowMs: () => Date.now(),
          dispatch: (task) => {
            void task();
          },
          log: () => undefined,
        },
        patValidation: patValidationGate,
        publicOrigin: ORIGIN,
        providerAnchors: async () => [],
      }),
    });
    request = (method, path, input = {}) => {
      const headers = new Headers({
        origin: ORIGIN,
        cookie: `${SESSION_COOKIE}=${SECRET}`,
        'x-csrf-token': CSRF,
        ...input.headers,
      });
      const body = input.body === undefined ? undefined : JSON.stringify(input.body);
      if (body !== undefined) headers.set('content-type', 'application/json');
      return app.fetch(
        new Request(ORIGIN + path, { method, headers, ...(body === undefined ? {} : { body }) }),
      );
    };
  });
  afterEach(async () => {
    await database.close();
  });

  const runs = async () =>
    executor.all<{ id: string }>(
      stmt('SELECT id FROM import_run WHERE org_id = ? ORDER BY id', ctx.orgId),
    );
  const create = async (body: unknown, key?: string) => {
    const response = await request('POST', ROOT, {
      body,
      ...(key === undefined ? {} : { headers: { 'idempotency-key': key } }),
    });
    return {
      status: response.status,
      replayed: response.headers.get('idempotent-replayed'),
      body: (await response.json()) as Record<string, unknown>,
    };
  };

  it('replays a retried creation with the same key and body without creating a second run', async () => {
    const first = await create(manifest, 'retry-1');
    expect(first).toMatchObject({ status: 201, replayed: null, body: { state: 'planned' } });
    const second = await create(manifest, 'retry-1');
    expect(second).toEqual({ status: 201, replayed: 'true', body: first.body });
    expect(await runs()).toEqual([{ id: first.body.id }]);
    expect(
      await executor.all(
        stmt('SELECT key, status FROM api_idempotency WHERE org_id = ?', ctx.orgId),
      ),
    ).toEqual([{ key: 'retry-1', status: 201 }]);
  });

  it('refuses the same key with a different body and keeps the original run', async () => {
    const first = await create(manifest, 'retry-2');
    const second = await create({ ...manifest, source_system: 'other' }, 'retry-2');
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ error: { code: 'idempotency_mismatch' } });
    expect(await runs()).toEqual([{ id: first.body.id }]);
  });

  it('creates one run per request without a key and per distinct key', async () => {
    const plain = [await create(manifest), await create(manifest)];
    const keyed = [await create(manifest, 'key-a'), await create(manifest, 'key-b')];
    const ids = [...plain, ...keyed].map((answer) => answer.body.id);
    expect(new Set(ids).size).toBe(4);
    expect(await runs()).toHaveLength(4);
  });

  it('shows the credential window only once the run is approved', async () => {
    const created = await create(manifest);
    const id = String(created.body.id);
    const planned = (await (await request('GET', `${ROOT}/${id}`)).json()) as Record<
      string,
      unknown
    >;
    expect(planned).toMatchObject({ id, credentialWindowUntil: null, credentials: [] });
    const approve = await request('POST', `${ROOT}/${id}/approve`, {
      body: { planHash: created.body.planHash },
    });
    expect(approve.status).toBe(204);
    const [row] = await executor.all<{ approved_at: string; credential_window_until: string }>(
      stmt(
        'SELECT approved_at, credential_window_until FROM import_run WHERE org_id = ? AND id = ?',
        ctx.orgId,
        id,
      ),
    );
    expect(Date.parse(row!.credential_window_until) - Date.parse(row!.approved_at)).toBe(3600000);
    const approved = (await (await request('GET', `${ROOT}/${id}`)).json()) as Record<
      string,
      unknown
    >;
    expect(approved.credentialWindowUntil).toBe(row!.credential_window_until);
    const list = (await (await request('GET', ROOT)).json()) as {
      items: Record<string, unknown>[];
    };
    expect(list.items).toEqual([
      expect.objectContaining({ id, credentialWindowUntil: row!.credential_window_until }),
    ]);
  });

  it('reports one bound and one unbound source after binding one of two credentials', async () => {
    const created = await create(withSources);
    const id = String(created.body.id);
    expect(
      (
        await request('POST', `${ROOT}/${id}/approve`, {
          body: { planHash: created.body.planHash },
        })
      ).status,
    ).toBe(204);
    await executor.batch(
      ['alpha', 'beta'].flatMap((ref) => [
        stmt(
          "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, ?, ?, 'composer', 'composer_repository')",
          `source-${ref}`,
          ctx.orgId,
          ref,
        ),
        stmt(
          "INSERT INTO import_ref (id, org_id, import_run_id, entity_type, entity_id, external_ref, action) VALUES (?, ?, ?, 'source', ?, ?, 'create')",
          `ref-${ref}`,
          ctx.orgId,
          id,
          `source-${ref}`,
          ref,
        ),
      ]),
    );
    const status = async () => {
      const response = await request('GET', `${ROOT}/${id}`);
      const text = await response.text();
      expect(text).not.toContain(MATERIAL);
      expect(text).not.toContain('REGISTRY_TOKEN');
      const body = JSON.parse(text) as { credentials: { sourceRef: string; bound: boolean }[] };
      return [...body.credentials].sort((a, b) => a.sourceRef.localeCompare(b.sourceRef));
    };
    expect(await status()).toEqual([
      { sourceRef: 'alpha', bound: false },
      { sourceRef: 'beta', bound: false },
    ]);
    const upload = await request('PUT', `${ROOT}/${id}/credentials/beta`, {
      body: { kind: 'bearer', material: JSON.stringify({ token: MATERIAL }) },
    });
    expect(upload.status).toBe(204);
    expect(await status()).toEqual([
      { sourceRef: 'alpha', bound: false },
      { sourceRef: 'beta', bound: true },
    ]);
  });

  it('gives concurrent retries with one key one run and identical bodies', async () => {
    let open = () => {};
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    // Both requests reserve the manifest blob before either publishes it.
    barrier = { waiting: 2, open, opened };
    const answers = await Promise.all([create(manifest, 'race'), create(manifest, 'race')]);
    expect(answers.map((answer) => answer.status)).toEqual([201, 201]);
    expect(answers[1]!.body).toEqual(answers[0]!.body);
    expect(answers.map((answer) => answer.replayed).sort()).toEqual([null, 'true']);
    expect(await runs()).toEqual([{ id: answers[0]!.body.id }]);
  });

  it('answers 503 unavailable when the stored manifest is missing from the blob store', async () => {
    const created = await create(withSources);
    objects.clear();
    const response = await request('GET', `${ROOT}/${String(created.body.id)}`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'unavailable' } });
  });

  it('answers a credential upload with 503 unavailable when the stored manifest is missing', async () => {
    const created = await create(withSources);
    objects.clear();
    const response = await request('PUT', `${ROOT}/${String(created.body.id)}/credentials/beta`, {
      body: { kind: 'bearer', material: JSON.stringify({ token: MATERIAL }) },
    });
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'unavailable' } });
    expect(text).not.toContain(MATERIAL);
  });

  it('hides an expired window and the window of a cancelled run', async () => {
    const created = await create(manifest);
    const id = String(created.body.id);
    expect(
      (
        await request('POST', `${ROOT}/${id}/approve`, {
          body: { planHash: created.body.planHash },
        })
      ).status,
    ).toBe(204);
    const window = async () =>
      ((await (await request('GET', `${ROOT}/${id}`)).json()) as Record<string, unknown>)
        .credentialWindowUntil;
    expect(await window()).toEqual(expect.any(String));
    await executor.batch([
      stmt(
        "UPDATE import_run SET credential_window_until = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 second') WHERE org_id = ? AND id = ?",
        ctx.orgId,
        id,
      ),
    ]);
    expect(await window()).toBeNull();
    await executor.batch([
      stmt(
        "UPDATE import_run SET credential_window_until = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 hour') WHERE org_id = ? AND id = ?",
        ctx.orgId,
        id,
      ),
    ]);
    expect(await window()).toEqual(expect.any(String));
    expect((await request('POST', `${ROOT}/${id}/cancel`)).status).toBe(204);
    expect(await window()).toBeNull();
  });
});
