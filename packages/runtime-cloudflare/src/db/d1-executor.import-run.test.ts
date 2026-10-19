import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import {
  mutationFence,
  tokenMutationFence,
  type AuthenticatedActor,
  type AuthenticatedTokenActor,
  type MutationFence,
} from '@package-broker/core/authz/fence';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import type {
  ImportRunCreateWrite,
  ImportRunStore,
  ImportRunWrite,
} from '@package-broker/core/import/run-service';
import type { BlobStore } from '@package-broker/core/platform/blob';
import { seedTwoOrganizations } from '@package-broker/db-sqlite/contract/two-organizations';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { blobEligibleCondition } from '@package-broker/db-sqlite/repositories/blob-references';
import { createImportRunStore } from '@package-broker/db-sqlite/repositories/import-run';
import { createBlobRepository } from '@package-broker/db-sqlite/repositories/blob';
import { discoveredMigrations } from '@package-broker/db-sqlite/testing/migrated-database';
import { createD1Executor, D1_MAX_BOUND_PARAMETERS, type D1DatabaseLike } from './d1-executor.js';

const bindings = Array.from({ length: 32 }, (_, index) => `IRDB${index}`);

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-10-01',
    d1Databases: bindings,
  } as Parameters<typeof convertV4MiniflareOptions>[0]),
);
let next = 0;

afterAll(async () => {
  await mf.dispose();
});

const MAX_PATTERN_BYTES = 50;
const sha = 'a'.repeat(64);
const planHash = '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';
const stmt = (sql: string, ...params: Statement['params']): Statement => ({ sql, params });
const anchors = [
  {
    provider: 'oidc',
    anchor: 'oidc:https://idp.example.test',
    emailAuthoritative: true,
    emailAuthoritativeDomains: ['example.test'],
  },
];

describe('import run repository on the D1 executor', () => {
  let executor: SqlExecutor;
  let ctx: OrgContext;
  let foreign: OrgContext;
  let store: ImportRunStore;
  let fence: MutationFence;
  let now: string;
  let input: ImportRunCreateWrite;
  let recorded: Statement[];
  let batches: Statement[][];
  let beforeBatch: (() => Promise<void>) | undefined;

  let uploads: number;
  const blobStore: BlobStore = {
    async put(_ctx, key, body, info) {
      uploads += 1;
      await new Response(body).arrayBuffer();
      expect(info.refetchable).toBe(false);
      const metadata = createBlobRepository(executor);
      const generation = await metadata.reserve(_ctx, key);
      const published = await metadata.publish(_ctx, { ...info, sha256: key, generation });
      if (published === null) throw new Error('blob publication refused');
      return published;
    },
    async get() {
      return null;
    },
    async head() {
      return null;
    },
  };

  beforeEach(async () => {
    const binding = bindings[next];
    next += 1;
    if (binding === undefined) throw new Error('out of D1 bindings');
    const inner = createD1Executor((await mf.getD1Database(binding)) as unknown as D1DatabaseLike);
    executor = inner;
    await migrate(inner, await discoveredMigrations(), { holder: 'import-run-test' });
    const orgs = await seedTwoOrganizations(inner);
    ctx = orgs.a;
    foreign = orgs.b;
    now = new Date().toISOString();
    recorded = [];
    batches = [];
    beforeBatch = undefined;
    uploads = 0;
    await inner.batch([
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
    const recording: SqlExecutor = {
      driver: inner.driver,
      async all<R>(statement: Statement) {
        recorded.push(statement);
        return inner.all<R>(statement);
      },
      async batch(batch) {
        recorded.push(...batch);
        batches.push([...batch]);
        const hook = beforeBatch;
        beforeBatch = undefined;
        await hook?.();
        return inner.batch(batch);
      },
    };
    store = createImportRunStore({
      executor: recording,
      blobs: blobStore,
      providerAnchors: anchors,
    });
    input = {
      id: 'run',
      manifest: '{}',
      sourceSystem: 'test',
      planHash,
      plannedCount: 0,
      now,
      audit: stmt('SELECT 1'),
    };
  });

  async function create(id = 'run', manifestFence: MutationFence = fence) {
    const outcome = await store.createRun(ctx, manifestFence, { ...input, id });
    expect(outcome).toMatchObject({ ok: true });
  }
  async function write(id = 'run'): Promise<ImportRunWrite> {
    const { run } = await store.inspect(ctx, fence, 'approveRun', id, now);
    if (run === null) throw new Error('missing run');
    return {
      runId: id,
      expected: run,
      now,
      audit: stmt('SELECT 1'),
      approvedByUserId: 'actor',
      approvedAt: now,
      credentialWindowUntil: new Date(Date.parse(now) + 3600000).toISOString(),
    };
  }
  const setState = (id: string, state: string) =>
    executor.batch([stmt('UPDATE import_run SET state = ? WHERE id = ?', state, id)]);

  it('creates a run with one session starter and a non-refetchable manifest', async () => {
    await create();
    expect(
      await executor.all(
        stmt(
          'SELECT started_by_user_id, started_by_service_principal_id, manifest_blob_sha256, plan_hash FROM import_run',
        ),
      ),
    ).toEqual([
      {
        started_by_user_id: 'actor',
        started_by_service_principal_id: null,
        manifest_blob_sha256: planHash,
        plan_hash: planHash,
      },
    ]);
    expect(await executor.all(stmt('SELECT refetchable FROM blob'))).toEqual([{ refetchable: 0 }]);
  });

  it('classifies a duplicate run id as a collision and preserves the original run', async () => {
    await create();
    expect(
      await store.createRun(ctx, fence, { ...input, sourceSystem: 'replacement' }),
    ).toMatchObject({ ok: false, reason: 'collision' });
    expect(
      await executor.all(
        stmt('SELECT id, source_system FROM import_run WHERE org_id = ?', ctx.orgId),
      ),
    ).toEqual([{ id: input.id, source_system: 'test' }]);
  });
  it('records the approver, time and credential window', async () => {
    await create();
    const approval = await write();
    expect(await store.approveRun(ctx, fence, approval)).toMatchObject({ ok: true });
    expect(
      await executor.all(
        stmt('SELECT approved_by_user_id, approved_at, credential_window_until FROM import_run'),
      ),
    ).toEqual([
      {
        approved_by_user_id: 'actor',
        approved_at: now,
        credential_window_until: approval.credentialWindowUntil,
      },
    ]);
  });

  it('does not approve when the approver is suspended between guard build and batch', async () => {
    await create();
    const approval = await write();
    beforeBatch = async () => {
      await executor.batch([
        stmt("UPDATE user_account SET status = 'suspended' WHERE id = 'actor'"),
      ]);
    };
    expect(await store.approveRun(ctx, fence, approval)).toMatchObject({ ok: false });
    expect(await executor.all(stmt('SELECT approved_at FROM import_run'))).toEqual([
      { approved_at: null },
    ]);
  });

  it('refuses a refetchable manifest row without writing a run', async () => {
    await executor.batch([
      stmt(
        "INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key, media_type, refetchable) VALUES ('manifest', ?, ?, 2, 'manifest', 'application/json', 1)",
        ctx.orgId,
        planHash,
      ),
    ]);
    expect(await store.createRun(ctx, fence, input)).toMatchObject({
      ok: false,
      reason: 'conflict',
    });
    expect(
      await executor.all(stmt('SELECT refetchable FROM blob WHERE org_id = ?', ctx.orgId)),
    ).toEqual([{ refetchable: 1 }]);
    expect(uploads).toBe(0);
    expect(await executor.all(stmt('SELECT id FROM import_run'))).toEqual([]);
  });

  it('queues apply atomically with the state change', async () => {
    await create();
    await store.approveRun(ctx, fence, await write());
    expect(await store.requestApply(ctx, fence, await write())).toMatchObject({ ok: true });
    expect(await executor.all(stmt('SELECT state FROM import_run WHERE id = ?', 'run'))).toEqual([
      { state: 'applying' },
    ]);
    expect(
      await executor.all(
        stmt('SELECT type, resource_key, state, payload_json FROM job WHERE org_id = ?', ctx.orgId),
      ),
    ).toEqual([
      {
        type: 'core:import-apply:v1',
        resource_key: 'import:run',
        state: 'queued',
        payload_json: '{"runId":"run"}',
      },
    ]);
  });

  it('cancels a planned run', async () => {
    await create();
    expect(await store.cancelRun(ctx, fence, await write())).toMatchObject({ ok: true });
    expect(await executor.all(stmt('SELECT state FROM import_run'))).toEqual([
      { state: 'cancelled' },
    ]);
  });

  it('accepts a verified run', async () => {
    await create();
    await setState('run', 'verified');
    expect(await store.acceptRun(ctx, fence, await write())).toMatchObject({ ok: true });
    const [row] = await executor.all<{ accepted_at: string | null }>(
      stmt('SELECT accepted_at FROM import_run'),
    );
    expect(row?.accepted_at).toBe(now);
  });

  it('queues a rollback for an applied run', async () => {
    await create();
    await setState('run', 'applied');
    expect(await store.requestRollback(ctx, fence, await write())).toMatchObject({ ok: true });
    expect(
      await executor.all(stmt('SELECT type, resource_key FROM job WHERE org_id = ?', ctx.orgId)),
    ).toEqual([{ type: 'core:import-rollback:v1', resource_key: 'import:run' }]);
  });

  it('refuses a transition with a stale expectation', async () => {
    await create();
    const stale = await write();
    await setState('run', 'cancelled');
    expect(await store.cancelRun(ctx, fence, stale)).toMatchObject({ ok: false });
  });

  it('answers a foreign run exactly like an absent run', async () => {
    await executor.batch([
      stmt(
        "INSERT INTO import_run (id, org_id, source_system) VALUES ('foreign', ?, 'test')",
        foreign.orgId,
      ),
    ]);
    expect(await store.inspect(ctx, fence, 'approveRun', 'foreign', now)).toEqual(
      await store.inspect(ctx, fence, 'approveRun', 'absent', now),
    );
  });

  it('derives the user starter alone from a PAT fence', async () => {
    await executor.batch([
      stmt(
        `INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, read_only, user_id, project_mode, validation_kind, validation_identity_id, expires_at)
        VALUES ('pat-token', ?, 'pat', 'patselector1', ?, 1, 'pat', '["full"]', 0, 'actor', 'all', 'sso', 'identity', strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour'))`,
        ctx.orgId,
        'c'.repeat(64),
      ),
    ]);
    const patFence = tokenMutationFence(
      { tokenId: 'pat-token', tokenKind: 'pat', principalId: 'actor' } as AuthenticatedTokenActor,
      'org:import:write',
      {},
    );
    expect(await store.createRun(ctx, patFence, input)).toMatchObject({ ok: true });
    expect(
      await executor.all(
        stmt('SELECT started_by_user_id, started_by_service_principal_id FROM import_run'),
      ),
    ).toEqual([{ started_by_user_id: 'actor', started_by_service_principal_id: null }]);
  });

  it('derives the service principal starter alone from a service token fence', async () => {
    await executor.batch([
      stmt(
        "INSERT INTO service_principal (id, org_id, name, created_by_user_id) VALUES ('principal', ?, 'importer', 'actor')",
        ctx.orgId,
      ),
      stmt(
        "INSERT INTO service_principal_permission (org_id, service_principal_id, permission) VALUES (?, 'principal', 'org:import:write')",
        ctx.orgId,
      ),
      stmt(
        `INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, read_only, service_principal_id, project_mode, expires_at)
        VALUES ('svc-token', ?, 'svc', 'svcselector1', ?, 1, 'svc', '["full"]', 0, 'principal', 'all', strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour'))`,
        ctx.orgId,
        'd'.repeat(64),
      ),
    ]);
    const serviceFence = tokenMutationFence(
      {
        tokenId: 'svc-token',
        tokenKind: 'svc',
        principalId: 'principal',
      } as AuthenticatedTokenActor,
      'org:import:write',
      {},
    );
    expect(await store.createRun(ctx, serviceFence, input)).toMatchObject({ ok: true });
    expect(
      await executor.all(
        stmt('SELECT started_by_user_id, started_by_service_principal_id FROM import_run'),
      ),
    ).toEqual([{ started_by_user_id: null, started_by_service_principal_id: 'principal' }]);
  });

  it('keeps the manifest blob out of purge eligibility while an ordinary orphan stays eligible', async () => {
    await create();
    await executor.batch([
      stmt("UPDATE blob SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')"),
      stmt(
        "INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key, refetchable, created_at) VALUES ('orphan', ?, ?, 0, 'orphan', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days'))",
        ctx.orgId,
        sha,
      ),
    ]);
    const condition = blobEligibleCondition(ctx, 'b');
    expect(
      await executor.all({
        sql: `SELECT b.id FROM blob b WHERE ${condition.sql}`,
        params: condition.params,
      }),
    ).toEqual([{ id: 'orphan' }]);
  });

  it('stays within D1 parameter, batch and pattern limits across every operation', async () => {
    await create('run-1');
    await store.approveRun(ctx, fence, await write('run-1'));
    await store.requestApply(ctx, fence, await write('run-1'));
    await create('run-2');
    await store.cancelRun(ctx, fence, await write('run-2'));
    await create('run-3');
    await setState('run-3', 'verified');
    await store.acceptRun(ctx, fence, await write('run-3'));
    await create('run-4');
    await setState('run-4', 'applied');
    await store.requestRollback(ctx, fence, await write('run-4'));
    await store.inspect(ctx, fence, 'createRun', null, now);

    expect(recorded.length).toBeGreaterThan(0);
    for (const item of recorded) {
      expect(item.params.length).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
      expect(item.sql).not.toMatch(/before_image_json|select\s+(distinct\s+)?\*|\.\*/i);
      for (const match of item.sql.matchAll(/\b(?:like|glob)\s+'((?:[^']|'')*)'/gi)) {
        expect(new TextEncoder().encode(match[1]).length).toBeLessThanOrEqual(MAX_PATTERN_BYTES);
      }
      for (const [index, param] of item.params.entries()) {
        const before = item.sql
          .split('?')
          .slice(0, index + 1)
          .join('?');
        if (/\b(?:like|glob)\s*$/i.test(before) && typeof param === 'string') {
          expect(new TextEncoder().encode(param).length).toBeLessThanOrEqual(MAX_PATTERN_BYTES);
        }
      }
    }
    expect(batches.length).toBeGreaterThan(0);
    for (const batch of batches) expect(batch.length).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
  });
});
