import { afterAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { auditEvent } from '@package-broker/core/audit/actions';
import { delegatedMutationFence } from '@package-broker/core/authz/fence';
import type { SqlValue } from '@package-broker/core/db/port';
import { fixedClock, ulid } from '@package-broker/core/ids';
import { runImportRollback } from '@package-broker/core/import/rollback';
import { IMPORT_RUN_JOB } from '@package-broker/core/import/run-service';
import { seedTwoOrganizations } from '@package-broker/db-sqlite/contract/two-organizations';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { hash } from '@package-broker/db-sqlite/repositories/import-journal';
import { createImportRollbackStore } from '@package-broker/db-sqlite/repositories/import-rollback';
import { discoveredMigrations } from '@package-broker/db-sqlite/testing/migrated-database';
import { createD1Executor, type D1DatabaseLike } from './d1-executor.js';

const bindings = Array.from({ length: 4 }, (_, index) => `IRDB${index}`);
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

const RUN = '01J0RN0000000000000000R001';
const NOW = '2026-10-20T12:00:00.000Z';
const MASS = 150;
const anchors = [
  {
    provider: 'oidc',
    anchor: 'test',
    emailAuthoritative: true,
    emailAuthoritativeDomains: ['example.test'],
  },
];

async function open() {
  const binding = bindings[next];
  next += 1;
  if (binding === undefined) throw new Error('out of D1 bindings');
  const db = (await mf.getD1Database(binding)) as unknown as D1DatabaseLike;
  const executor = createD1Executor(db);
  await migrate(executor, await discoveredMigrations(), { holder: 'import-rollback-test' });
  const { a: ctx } = await seedTwoOrganizations(executor);
  const run = (sql: string, ...params: SqlValue[]) => executor.batch([{ sql, params }]);
  await run(
    "INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, 'oidc', 'test')",
    ctx.orgId,
  );
  await run(
    "INSERT INTO role (id, org_id, key, name, scope) VALUES ('importer', ?, 'importer', 'Importer', 'organization')",
    ctx.orgId,
  );
  await run(
    "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'importer', 'org:import:approve')",
    ctx.orgId,
  );
  for (const user of ['actor', 'requester']) {
    await run(
      'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
      user,
      ctx.orgId,
      `${user}@example.test`,
    );
    await run(
      "INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, 'oidc', ?, ?, 1, ?)",
      `identity-${user}`,
      ctx.orgId,
      user,
      user,
      `${user}@example.test`,
      NOW,
    );
    await run(
      "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id) VALUES (?, ?, 'email', ?, 'organization', 'importer')",
      `grant-${user}`,
      ctx.orgId,
      `${user}@example.test`,
    );
  }
  await run(
    "INSERT INTO import_run (id, org_id, source_system, state, approved_by_user_id, approved_at) VALUES (?, ?, 'test', 'applied', 'actor', ?)",
    RUN,
    ctx.orgId,
    NOW,
  );
  await run(
    "INSERT INTO job (id, org_id, type, payload_json, resource_key, state, lease_owner, lease_until, fence) VALUES ('rollback-job', ?, ?, ?, ?, 'running', 'worker', '2999-01-01T00:00:00.000Z', 1)",
    ctx.orgId,
    IMPORT_RUN_JOB.rollback,
    JSON.stringify({ runId: RUN, requestedBy: 'requester' }),
    IMPORT_RUN_JOB.resourceKey(RUN),
  );
  await run(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${String(MASS)})
     INSERT INTO project (id, org_id, slug, name, status, token_max_scope, require_publish_approval)
     SELECT 'mp' || i, ?, 'mass-' || i, 'Mass', 'active', 'full', 0 FROM n`,
    ctx.orgId,
  );
  await run(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${String(MASS)})
     INSERT INTO import_ref (id, org_id, import_run_id, entity_type, entity_id, external_ref, action)
     SELECT 'mr' || i, ?, ?, 'project', 'mp' || i, 'mass-' || i, 'create' FROM n`,
    ctx.orgId,
    RUN,
  );
  const hashes = await Promise.all(
    Array.from({ length: MASS }, async (_, index) => ({
      id: `mr${String(index + 1)}`,
      hash: await hash({
        slug: `mass-${String(index + 1)}`,
        name: 'Mass',
        status: 'active',
        token_max_scope: 'full',
        require_publish_approval: 0,
      }),
    })),
  );
  await run(
    `WITH h AS (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.hash') AS hash FROM json_each(?))
     UPDATE import_ref SET content_hash = (SELECT hash FROM h WHERE h.id = import_ref.id) WHERE id IN (SELECT id FROM h)`,
    JSON.stringify(hashes),
  );
  return { executor, ctx, run };
}

describe('D1 import rollback store', () => {
  it('rolls back a seeded mass import, leaving a changed row as a conflict', async () => {
    const { executor, ctx, run } = await open();
    await run("UPDATE project SET name = 'Edited' WHERE id = 'mp7'");
    const batches: number[] = [];
    const counted = {
      driver: executor.driver,
      all: executor.all.bind(executor),
      batch: (statements: Parameters<typeof executor.batch>[0]) => {
        batches.push(statements.length);
        expect(statements.every((statement) => statement.params.length <= 100)).toBe(true);
        return executor.batch(statements);
      },
    };
    const store = createImportRollbackStore({ executor: counted, providerAnchors: anchors });
    const outcome = await runImportRollback(
      { store, clock: fixedClock(NOW), ids: { ulid } },
      ctx,
      { runId: RUN, requestedBy: 'requester' },
      (approver, runId, expected) =>
        delegatedMutationFence(
          approver,
          runId,
          { id: 'rollback-job', owner: 'worker', fence: 1 },
          expected,
        ),
    );
    expect(outcome).toEqual({
      status: 'rolled_back',
      counts: { restored: MASS - 1, conflict: 1, expired: 0 },
    });
    expect(
      await executor.all({ sql: "SELECT id FROM project WHERE id LIKE 'mp%'", params: [] }),
    ).toEqual([{ id: 'mp7' }]);
    expect(
      await executor.all({
        sql: 'SELECT state, rollback_restored_count, rollback_conflict_count FROM import_run WHERE id = ?',
        params: [RUN],
      }),
    ).toEqual([
      { state: 'rolled_back', rollback_restored_count: MASS - 1, rollback_conflict_count: 1 },
    ]);
    expect(Math.max(...batches)).toBeLessThanOrEqual(900);
  });

  const fence = (expected: Record<string, number> = {}) =>
    delegatedMutationFence(
      'requester',
      RUN,
      { id: 'rollback-job', owner: 'worker', fence: 1 },
      expected,
    );
  const audit = (type: string, id: string) => {
    const built = auditEvent({
      id: ulid(),
      now: NOW,
      action: 'import_run.rollback',
      actor: { type: 'user', id: 'requester' },
      target: { type, id },
      projectId: null,
      changes: { state: { new: 'restored' } },
      context: { opId: RUN, requestId: RUN, sourceIp: null, tokenSelector: null },
    });
    if (!built.ok) throw new Error('invalid audit fixture');
    return built.event;
  };

  it('restores a version with its basis and snapshots the replaced revision', async () => {
    const { executor, ctx, run } = await open();
    await run(
      "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('src', ?, 'src', 'npm', 'npmjs_proxy')",
      ctx.orgId,
    );
    await run(
      "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('pkg', ?, 'src', 'npm', 'pkg')",
      ctx.orgId,
    );
    await run(
      "INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json) VALUES ('v1', ?, 'pkg', '1.0.0', '1.0.0', '2026-10-19T00:00:00.000Z', 'import_time', '{}')",
      ctx.orgId,
    );
    await run(
      "INSERT INTO import_ref (id, org_id, import_run_id, entity_type, entity_id, external_ref, action, published_at_basis) VALUES ('vr', ?, ?, 'version', 'v1', 'vr', 'update', 'import_time')",
      ctx.orgId,
      RUN,
    );
    const store = createImportRollbackStore({ executor, providerAnchors: anchors });
    const result = await store.applyChunk(ctx, fence({ v1: 1 }), {
      runId: RUN,
      approvedByUserId: 'actor',
      now: NOW,
      actions: [
        {
          kind: 'restore',
          refId: 'vr',
          entityType: 'version',
          entityId: 'v1',
          guard: { kind: 'revision', revision: 1 },
          domain: {
            published_at: '2026-01-01T00:00:00.000Z',
            published_at_basis: 'source_release',
          },
          audit: audit('version', 'v1'),
        },
      ],
    });
    expect(result).toEqual({ ok: true, outcomes: ['restored'] });
    expect(
      await executor.all({
        sql: "SELECT published_at, published_at_basis, revision FROM version WHERE id = 'v1'",
        params: [],
      }),
    ).toEqual([
      {
        published_at: '2026-01-01T00:00:00.000Z',
        published_at_basis: 'source_release',
        revision: 2,
      },
    ]);
    expect(
      await executor.all({
        sql: "SELECT revision, reason FROM version_revision WHERE version_id = 'v1'",
        params: [],
      }),
    ).toEqual([{ revision: 1, reason: 'import_rollback' }]);
  });

  it('marks a ref of an expired journal expired without deleting its entity', async () => {
    const { executor, ctx, run } = await open();
    await run(
      "UPDATE import_run SET state = 'verified', before_image_expires_at = '2026-10-20T11:00:00.000Z' WHERE id = ?",
      RUN,
    );
    const store = createImportRollbackStore({ executor, providerAnchors: anchors });
    const result = await store.applyChunk(ctx, fence(), {
      runId: RUN,
      approvedByUserId: 'actor',
      now: NOW,
      actions: [{ kind: 'expired', refId: 'mr1' }],
    });
    expect(result).toEqual({ ok: true, outcomes: ['expired'] });
    expect(
      await executor.all({
        sql: "SELECT expired_at, rolled_back_at FROM import_ref WHERE id = 'mr1'",
        params: [],
      }),
    ).toEqual([{ expired_at: NOW, rolled_back_at: null }]);
    expect(
      await executor.all({ sql: "SELECT id FROM project WHERE id = 'mp1'", params: [] }),
    ).toEqual([{ id: 'mp1' }]);
  });
});
