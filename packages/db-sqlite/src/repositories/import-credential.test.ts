import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mutationFence,
  tokenMutationFence,
  type AuthenticatedActor,
  type AuthenticatedTokenActor,
  type MutationFence,
} from '@package-broker/core/authz/fence';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { openMigratedDatabase } from '../testing/migrated-database.js';
import type { ImportCredentialStore } from '@package-broker/core/import/credentials';
import { auditEvent } from '@package-broker/core/audit/actions';
import { DbError } from '@package-broker/core/db/errors';
import { credentialAad } from '@package-broker/core/secrets/cipher';
import { createCredentialRepository } from './credential.js';
import { auditPendingStatement } from './audit-pending.js';
import { idempotencyInsertStatement } from './idempotency.js';
import { createImportCredentialRepository } from './import-credential.js';

interface FixturePrepared {
  bind(...params: unknown[]): FixturePrepared;
  all(): Promise<{ results: Record<string, unknown>[] }>;
}
interface FixtureBinding {
  prepare(sql: string): FixturePrepared;
  batch(statements: FixturePrepared[]): Promise<
    {
      results: Record<string, unknown>[];
      meta: { changes: number };
    }[]
  >;
}

const sha = 'a'.repeat(64);
const stmt = (sql: string, ...params: Statement['params']): Statement => ({ sql, params });
const anchors = [
  {
    provider: 'oidc',
    anchor: 'oidc:https://idp.example.test',
    emailAuthoritative: true,
    emailAuthoritativeDomains: ['example.test'],
  },
];

describe.each(['sqlite', 'd1'])('import credentials (%s)', (driver) => {
  let executor: SqlExecutor;
  let ctx: OrgContext;
  let foreign: OrgContext;
  let fence: MutationFence;
  let close: () => Promise<void>;
  beforeEach(async () => {
    const database = await openMigratedDatabase({
      twoOrganizations: true,
      d1PatternLimit: driver === 'd1',
    });
    if (database.orgs === null) throw new Error('missing organizations');
    ({ a: ctx, b: foreign } = database.orgs);
    close = database.close;
    executor = database.executor;
    if (driver === 'd1') {
      // A computed test import avoids a TypeScript build dependency back to the runtime.
      const runtimeModule = '@package-broker/runtime-cloudflare/db/d1-executor';
      const { createD1Executor } = (await import(runtimeModule)) as {
        createD1Executor(binding: FixtureBinding): SqlExecutor;
      };
      // Exercise the production D1 executor without a localhost listener in the sandbox.
      // Deliberately inflate meta.changes: only RETURNING rows establish mutation counts.
      const statements = new WeakMap<FixturePrepared, Statement>();
      const binding: FixtureBinding = {
        prepare(sql) {
          const prepared: FixturePrepared = {
            bind(...params) {
              statements.set(prepared, { sql, params: params as Statement['params'] });
              return prepared;
            },
            async all() {
              const statement = statements.get(prepared);
              if (statement === undefined) throw new Error('unbound fixture statement');
              return { results: await database.executor.all(statement) };
            },
          };
          return prepared;
        },
        async batch(prepared) {
          const results = await database.executor.batch(
            prepared.map((item) => {
              const statement = statements.get(item);
              if (statement === undefined) throw new Error('unbound fixture statement');
              return statement;
            }),
          );
          return results.map((result) => ({ results: result.rows, meta: { changes: 999 } }));
        },
      };
      executor = createD1Executor(binding);
    }
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
        sha,
        'b'.repeat(64),
      ),
    ]);
    fence = mutationFence({ userId: 'actor', sessionId: 'session' } as AuthenticatedActor, {});
  });
  afterEach(async () => {
    await close?.();
  });
  async function seedPatToken() {
    await executor.batch([
      stmt(
        `INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, read_only, user_id, project_mode, validation_kind, validation_identity_id, expires_at)
        VALUES ('pat-token', ?, 'pat', 'patselector1', ?, 1, 'pat', '["full"]', 0, 'actor', 'all', 'sso', 'identity', strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour'))`,
        ctx.orgId,
        'c'.repeat(64),
      ),
    ]);
    return tokenMutationFence(
      { tokenId: 'pat-token', tokenKind: 'pat', principalId: 'actor' } as AuthenticatedTokenActor,
      'org:import:write',
      {},
    );
  }

  let store: ImportCredentialStore;
  let now: string;
  let input: Parameters<ImportCredentialStore['setCredential']>[2];
  let reads: Statement[];
  let batches: Statement[][];
  let beforeBatch: (() => Promise<void>) | undefined;
  let indeterminate: boolean;
  let blobCalls: { org: OrgContext; key: string }[];
  let blobMissing: boolean;
  beforeEach(async () => {
    now = new Date().toISOString();
    const until = new Date(Date.now() + 3600000).toISOString();
    await executor.batch([
      stmt(
        "INSERT INTO import_run (id, org_id, source_system, approved_at, credential_window_until, manifest_blob_sha256) VALUES ('run', ?, 'test', ?, ?, ?)",
        ctx.orgId,
        now,
        until,
        sha,
      ),
      stmt(
        "INSERT INTO import_run (id, org_id, source_system, manifest_blob_sha256) VALUES ('foreign', ?, 'test', ?)",
        foreign.orgId,
        sha,
      ),
      stmt(
        "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('source', ?, 'Source', 'composer', 'vcs')",
        ctx.orgId,
      ),
      stmt(
        "INSERT INTO import_ref (id, org_id, import_run_id, entity_type, entity_id, external_ref, action, before_image_json) VALUES ('ref', ?, 'run', 'source', 'source', 'external', 'create', '{}')",
        ctx.orgId,
      ),
    ]);
    reads = [];
    batches = [];
    blobCalls = [];
    blobMissing = false;
    beforeBatch = undefined;
    indeterminate = false;
    const recording: SqlExecutor = {
      driver: executor.driver,
      async all<R>(statement: Statement) {
        reads.push(statement);
        return executor.all<R>(statement);
      },
      async batch(statements) {
        batches.push([...statements]);
        const hook = beforeBatch;
        beforeBatch = undefined;
        await hook?.();
        if (indeterminate) throw new DbError('unknown', 'unknown: response lost');
        return executor.batch(statements);
      },
    };
    store = createImportCredentialRepository(recording, {
      providerAnchors: anchors,
      blobs: {
        async get(org, key) {
          blobCalls.push({ org, key });
          if (blobMissing) return null;
          return {
            info: {
              generation: '',
              sha256: key,
              size: 2,
              mediaType: 'application/json',
              purgeAfter: null,
            },
            body: new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{}'));
                controller.close();
              },
            }),
          };
        },
      },
    });
    const event = auditEvent({
      id: '01J00000000000000000000001',
      now,
      action: 'import_run.credential_set',
      actor: { type: 'user', id: 'actor' },
      context: {
        opId: '01J00000000000000000000002',
        requestId: '01J00000000000000000000003',
        sourceIp: null,
        tokenSelector: null,
      },
      target: { type: 'import_run', id: 'run' },
      projectId: null,
      changes: { external_ref: { new: 'external' } },
    });
    if (!event.ok) throw new Error('audit rejected');
    input = {
      runId: 'run',
      externalRef: 'external',
      sourceId: 'source',
      expected: { approvedAt: now, credentialWindowUntil: until },
      now,
      credential: {
        id: 'credential',
        statement: createCredentialRepository(executor).insertStatement(ctx, {
          id: 'credential',
          projectId: null,
          kind: 'bearer',
          sealed: {
            ciphertext: new Uint8Array([1, 2, 3]),
            nonce: new Uint8Array(12),
            keyVersion: 1,
          },
          aad: credentialAad({ id: 'credential', orgId: ctx.orgId, kind: 'bearer' }),
          rotatedAt: null,
          now,
        }),
      },
      audit: auditPendingStatement(ctx, event.event),
      idempotency: idempotencyInsertStatement(ctx, {
        principalKey: 'user:actor',
        key: 'key',
        route: 'import-credentials',
        requestHash: sha,
        status: 204,
        responseJson: 'null',
        createdAt: now,
        expiresAt: until,
      }),
    };
  });
  async function state() {
    return {
      credentials: await executor.all(stmt('SELECT id FROM credential')),
      sources: await executor.all(stmt('SELECT id, credential_id FROM source')),
      audit: await executor.all(stmt('SELECT action FROM audit_pending')),
      idempotency: await executor.all(stmt('SELECT key FROM api_idempotency')),
    };
  }
  function safeSql(statements: readonly Statement[]) {
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement.sql).not.toMatch(/before_image_json|select\s+(distinct\s+)?\*|\.\*/i);
      expect(statement.params.length).toBeLessThanOrEqual(100);
    }
  }
  it.each(['session', 'pat'])(
    'sets exactly one credential, binding, audit and idempotency row (%s)',
    async (kind) => {
      const actor = kind === 'pat' ? await seedPatToken() : fence;
      const inspection = await store.inspect(ctx, actor, 'run', 'external', now);
      expect(inspection).toEqual({
        allowed: true,
        target: {
          approvedAt: now,
          credentialWindowUntil: input.expected.credentialWindowUntil,
          manifest: '{}',
          source: { id: 'source', projectId: null, credentialId: null },
        },
      });
      expect(reads).toHaveLength(1);
      expect(blobCalls).toEqual([{ org: ctx, key: sha }]);
      const outcome = await store.setCredential(ctx, actor, input);
      expect(outcome.ok).toBe(true);
      expect(batches).toHaveLength(1);
      const batch = batches[0]!;
      const credentialIndex = batch.indexOf(input.credential.statement);
      expect(credentialIndex).toBeGreaterThan(0);
      expect(batch[credentialIndex + 1]?.sql).toMatch(/access_mutation_guard/i);
      expect(batch[credentialIndex + 2]?.sql).toMatch(/^update.*source.*returning/i);
      expect(batch[credentialIndex + 3]).toBe(input.audit);
      expect(batch[credentialIndex + 4]).toBe(input.idempotency);
      if (outcome.ok)
        expect(outcome.results[credentialIndex + 2]?.rows).toEqual([{ id: 'source' }]);
      expect(await state()).toEqual({
        credentials: [{ id: 'credential' }],
        sources: [{ id: 'source', credential_id: 'credential' }],
        audit: [{ action: 'import_run.credential_set' }],
        idempotency: [{ key: 'key' }],
      });
      safeSql([...reads, ...batch]);
    },
  );
  it('also writes without an idempotency statement', async () => {
    const { idempotency, ...without } = input;
    expect(idempotency).toBeDefined();
    expect((await store.setCredential(ctx, fence, without)).ok).toBe(true);
    expect((await state()).idempotency).toEqual([]);
  });
  it.each([
    [
      'window expired after inspection',
      "UPDATE import_run SET credential_window_until = strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour') WHERE id = 'run'",
      'conflict',
    ],
    ['not approved', "UPDATE import_run SET approved_at = NULL WHERE id = 'run'", 'conflict'],
    [
      'approval changed',
      "UPDATE import_run SET approved_at = '2000-01-01T00:00:00.000Z' WHERE id = 'run'",
      'conflict',
    ],
    ['update binding', "UPDATE import_ref SET action = 'update'", 'not_found'],
    [
      'rolled back binding',
      "UPDATE import_ref SET rolled_back_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
      'not_found',
    ],
    ['non-source binding', "UPDATE import_ref SET entity_type = 'project'", 'not_found'],
    ['vanished binding', 'DELETE FROM import_ref', 'not_found'],
    [
      'vanished run',
      "DELETE FROM import_ref; DELETE FROM import_run WHERE id = 'run'",
      'not_found',
    ],
  ])('rolls back every effect for %s', async (_label, mutation, reason) => {
    expect((await store.inspect(ctx, fence, 'run', 'external', now)).target).not.toBeNull();
    beforeBatch = async () => {
      for (const sql of mutation.split(';')) await executor.all(stmt(sql));
    };
    const before = await state();
    expect(await store.setCredential(ctx, fence, input)).toEqual({ ok: false, reason });
    expect(await state()).toEqual(before);
    safeSql([...reads, ...batches.flat()]);
  });
  it('uses database time even when the expired window still matches expected', async () => {
    const expired = new Date(Date.now() - 3600000).toISOString();
    await executor.all(
      stmt("UPDATE import_run SET credential_window_until = ? WHERE id = 'run'", expired),
    );
    const before = await state();
    expect(
      await store.setCredential(ctx, fence, {
        ...input,
        now: '2000-01-01T00:00:00.000Z',
        expected: { ...input.expected, credentialWindowUntil: expired },
      }),
    ).toEqual({ ok: false, reason: 'conflict' });
    expect(await state()).toEqual(before);
  });
  it.each(['other project', 'other organization'])(
    'refuses a credential prepared for %s without changes',
    async (owner) => {
      await executor.all(
        stmt(
          "INSERT INTO project (id, org_id, slug, name) VALUES ('other-project', ?, 'other', 'Other')",
          ctx.orgId,
        ),
      );
      const credential = {
        ...input.credential,
        statement: createCredentialRepository(executor).insertStatement(
          owner === 'other organization' ? foreign : ctx,
          {
            id: input.credential.id,
            projectId: owner === 'other project' ? 'other-project' : null,
            kind: 'bearer',
            sealed: {
              ciphertext: new Uint8Array([1, 2, 3]),
              nonce: new Uint8Array(12),
              keyVersion: 1,
            },
            aad: credentialAad({
              id: input.credential.id,
              orgId: owner === 'other organization' ? foreign.orgId : ctx.orgId,
              kind: 'bearer',
            }),
            rotatedAt: null,
            now,
          },
        ),
      };
      const before = await state();
      expect((await store.setCredential(ctx, fence, { ...input, credential })).ok).toBe(false);
      expect(await state()).toEqual(before);
      safeSql([...reads, ...batches.flat()]);
    },
  );
  it('preserves an existing credential', async () => {
    const existingId = 'existing-credential';
    await executor.all(
      createCredentialRepository(executor).insertStatement(ctx, {
        id: existingId,
        projectId: null,
        kind: 'bearer',
        sealed: {
          ciphertext: new Uint8Array([4, 5, 6]),
          nonce: new Uint8Array(12),
          keyVersion: 1,
        },
        aad: credentialAad({ id: existingId, orgId: ctx.orgId, kind: 'bearer' }),
        rotatedAt: null,
        now,
      }),
    );
    await executor.all(stmt('UPDATE source SET credential_id = ?', existingId));
    const before = await state();
    expect(before.credentials).toEqual([{ id: existingId }]);
    expect(input.credential.id).not.toBe(existingId);
    expect(await store.setCredential(ctx, fence, input)).toEqual({ ok: false, reason: 'conflict' });
    expect(await state()).toEqual(before);
  });
  it.each(['session', 'pat'])(
    'rechecks authority immediately before the batch (%s)',
    async (kind) => {
      const actor = kind === 'pat' ? await seedPatToken() : fence;
      expect((await store.inspect(ctx, actor, 'run', 'external', now)).allowed).toBe(true);
      beforeBatch = async () => {
        await executor.all(
          stmt(
            kind === 'pat'
              ? "UPDATE token SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')"
              : "DELETE FROM role_permission WHERE permission = 'org:import:write'",
          ),
        );
      };
      const before = await state();
      expect(await store.setCredential(ctx, actor, input)).toEqual({
        ok: false,
        reason: 'authority',
      });
      expect(await state()).toEqual(before);
      safeSql([...reads, ...batches.flat()]);
    },
  );
  it('answers not_found for foreign and absent runs with and without permission', async () => {
    for (const permitted of [true, false]) {
      if (!permitted)
        await executor.all(
          stmt("DELETE FROM role_permission WHERE permission = 'org:import:write'"),
        );
      const before = await state();
      for (const runId of ['foreign', 'absent']) {
        expect(await store.inspect(ctx, fence, runId, 'external', now)).toEqual({
          allowed: permitted,
          target: null,
        });
        expect(await store.setCredential(ctx, fence, { ...input, runId })).toEqual({
          ok: false,
          reason: 'not_found',
        });
      }
      expect(await state()).toEqual(before);
    }
    expect(blobCalls).toEqual([]);
    safeSql(reads);
  });
  it('does not return a source for a non-source entry with the same external reference', async () => {
    await executor.all(stmt("UPDATE import_ref SET entity_type = 'project'"));
    expect((await store.inspect(ctx, fence, 'run', 'external', now)).target?.source).toBeNull();
    safeSql(reads);
  });
  it.each([
    "UPDATE import_ref SET action = 'update'",
    "UPDATE import_ref SET rolled_back_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
    'UPDATE import_ref SET org_id = ?',
    'UPDATE source SET org_id = ?',
  ])('hides an ineligible source binding: %s', async (mutation) => {
    await executor.all(stmt(mutation, ...(mutation.includes('?') ? [foreign.orgId] : [])));
    expect((await store.inspect(ctx, fence, 'run', 'external', now)).target?.source).toBeNull();
  });
  it('keeps a visible run inspectable when permission is missing', async () => {
    await executor.all(stmt("DELETE FROM role_permission WHERE permission = 'org:import:write'"));
    const result = await store.inspect(ctx, fence, 'run', 'external', now);
    expect(result.allowed).toBe(false);
    expect(result.target?.source?.id).toBe('source');
    expect(reads).toHaveLength(1);
    safeSql(reads);
  });
  it('refuses a binding to a different source id', async () => {
    const before = await state();
    expect(await store.setCredential(ctx, fence, { ...input, sourceId: 'different' })).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(await state()).toEqual(before);
  });
  it('rolls every write back when the optional idempotency insert fails', async () => {
    if (input.idempotency === undefined) throw new Error('missing idempotency fixture');
    await executor.all(input.idempotency);
    const before = await state();
    expect((await store.setCredential(ctx, fence, input)).ok).toBe(false);
    expect(await state()).toEqual(before);
  });
  it('rolls the credential and source back when the audit insert fails', async () => {
    const before = await state();
    await store.setCredential(ctx, fence, {
      ...input,
      audit: stmt('INSERT INTO audit_pending (id) VALUES (NULL)'),
    });
    expect(await state()).toEqual(before);
  });
  it('passes indeterminate through without failure probes', async () => {
    indeterminate = true;
    expect(await store.setCredential(ctx, fence, input)).toEqual({
      ok: false,
      reason: 'indeterminate',
    });
    expect(reads).toEqual([]);
  });
  it('reports bound imported sources and the stored manifest of an own run only', async () => {
    expect(await store.bindings(ctx, 'run')).toEqual({ manifest: '{}', bound: [] });
    expect(blobCalls).toEqual([{ org: ctx, key: sha }]);
    expect((await store.setCredential(ctx, fence, input)).ok).toBe(true);
    expect(await store.bindings(ctx, 'run')).toEqual({ manifest: '{}', bound: ['external'] });
    await executor.batch([stmt("UPDATE import_ref SET rolled_back_at = ? WHERE id = 'ref'", now)]);
    expect(await store.bindings(ctx, 'run')).toEqual({ manifest: '{}', bound: [] });
  });
  it('reports a stored manifest missing from the blob store as unavailable', async () => {
    blobMissing = true;
    expect(await store.bindings(ctx, 'run')).toBe('unavailable');
  });
  it('hides absent and foreign runs from binding status without reading a manifest', async () => {
    expect(await store.bindings(ctx, 'foreign')).toBeNull();
    expect(await store.bindings(ctx, 'absent')).toBeNull();
    expect(await store.bindings(foreign, 'run')).toBeNull();
    expect(blobCalls).toEqual([]);
  });
  it('reports a run without a stored manifest without reading a blob', async () => {
    await executor.batch([
      stmt(
        "INSERT INTO import_run (id, org_id, source_system) VALUES ('bare', ?, 'test')",
        ctx.orgId,
      ),
    ]);
    expect(await store.bindings(ctx, 'bare')).toEqual({ manifest: null, bound: [] });
    expect(blobCalls).toEqual([]);
  });
});
