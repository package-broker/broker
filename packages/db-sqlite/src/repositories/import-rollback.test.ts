import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { delegatedMutationFence } from '@package-broker/core/authz/fence';
import type { OrgContext, SqlExecutor, SqlValue, Statement } from '@package-broker/core/db/port';
import { auditEvent } from '@package-broker/core/audit/actions';
import type { ImportApplyItem } from '@package-broker/core/import/apply';
import {
  runImportRollback,
  type ImportRollbackAction,
  type ImportRollbackCounts,
} from '@package-broker/core/import/rollback';
import { IMPORT_RUN_JOB } from '@package-broker/core/import/run-service';
import { fixedClock, ulid } from '@package-broker/core/ids';
import { withForeignKeysOff } from '../testing/foreign-keys-off.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createImportJournalStore, hash } from './import-journal.js';
import { createImportRollbackStore, ROLLBACK_ENTITIES } from './import-rollback.js';

const V = '2026-10-19T00:00:00.000Z';
const NOW = '2026-10-20T12:00:00.000Z';
const anchors = [
  {
    provider: 'oidc',
    anchor: 'test',
    emailAuthoritative: true,
    emailAuthoritativeDomains: ['example.test'],
  },
];
const stmt = (sql: string, ...params: Statement['params']): Statement => ({ sql, params });
const rollbackJob = { id: 'rollback-job', owner: 'worker', fence: 1 };

const project: ImportApplyItem = {
  type: 'project',
  external_ref: 'project',
  slug: 'imported',
  name: 'Imported',
};
const items: readonly ImportApplyItem[] = [
  project,
  {
    type: 'role',
    external_ref: 'reader',
    key: 'reader',
    name: 'Reader',
    scope: 'project',
    permissions: ['project:read'],
  },
  {
    type: 'source',
    external_ref: 'new-source',
    name: 'registry',
    ecosystem: 'npm',
    source_type: 'npm_registry',
    project: null,
    url: 'https://registry.example.test/',
    config: {
      selection: { packages: [], patterns: [], expandPatterns: false },
      distHosts: [],
      mirrorsFallback: false,
    },
    status: 'paused',
  },
  {
    type: 'name',
    external_ref: 'name',
    source: { ref: 'new-source' },
    ecosystem: 'npm',
    pattern: 'acme/*',
  },
  {
    type: 'attachment',
    external_ref: 'attachment',
    project: { ref: 'project' },
    source: { ref: 'new-source' },
    precedence: 10,
  },
  {
    type: 'grant',
    external_ref: 'reader-grant',
    scope: 'project',
    project: { ref: 'project' },
    role: { ref: 'reader' },
    subject: { type: 'group', provider: 'oidc', value: 'readers' },
  },
  {
    type: 'version_override',
    external_ref: 'override',
    source: { existing: { project: null, name: 'source' } },
    package: 'pkg',
    version: '1.0.0',
    published_at: V,
    basis: 'import_time',
  },
];

describe('import rollback store', () => {
  let database: MigratedDatabase;
  let executor: SqlExecutor;
  let ctx: OrgContext;
  let foreign: OrgContext;
  let journal: ReturnType<typeof createImportJournalStore>;
  let store: ReturnType<typeof createImportRollbackStore>;
  let batches: (readonly Statement[])[];
  let beforeBatch: (() => Promise<void>) | undefined;
  let hookWhen: (statements: readonly Statement[]) => boolean;
  let now: string;

  const rows = <R>(sql: string, ...params: SqlValue[]) =>
    database.executor.all<R>(stmt(sql, ...params));
  const exec = (sql: string, ...params: SqlValue[]) =>
    database.executor.batch([stmt(sql, ...params)]);
  const forgedExec = (sql: string, ...params: SqlValue[]) =>
    withForeignKeysOff(database.executor, () => exec(sql, ...params));
  const fences = (approver: string, runId: string, expected: Readonly<Record<string, number>>) =>
    delegatedMutationFence(approver, runId, rollbackJob, expected);

  beforeEach(async () => {
    database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
    if (database.orgs === null) throw new Error('missing fixture');
    ({ a: ctx, b: foreign } = database.orgs);
    now = NOW;
    batches = [];
    beforeBatch = undefined;
    hookWhen = () => true;
    executor = {
      driver: database.executor.driver,
      all: (s) => database.executor.all(s),
      async batch(statements) {
        batches.push(statements);
        if (hookWhen(statements)) {
          const hook = beforeBatch;
          beforeBatch = undefined;
          await hook?.();
        }
        return database.executor.batch(statements);
      },
    };
    await exec(
      "INSERT INTO user_account (id, org_id, email) VALUES ('actor', ?, 'actor@example.test')",
      ctx.orgId,
    );
    await exec(
      "INSERT INTO user_account (id, org_id, email) VALUES ('requester', ?, 'requester@example.test')",
      ctx.orgId,
    );
    await exec(
      "INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, 'oidc', 'test')",
      ctx.orgId,
    );
    for (const [identity, user, email] of [
      ['identity', 'actor', 'actor@example.test'],
      ['identity-requester', 'requester', 'requester@example.test'],
    ] as const) {
      await exec(
        "INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, 'oidc', ?, ?, 1, ?)",
        identity,
        ctx.orgId,
        user,
        identity,
        email,
        V,
      );
    }
    await exec(
      "INSERT INTO role (id, org_id, key, name, scope) VALUES ('importer', ?, 'importer', 'Importer', 'organization')",
      ctx.orgId,
    );
    await exec(
      "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'importer', 'org:import:approve')",
      ctx.orgId,
    );
    for (const [grant, email] of [
      ['grant', 'actor@example.test'],
      ['grant-requester', 'requester@example.test'],
    ] as const) {
      await exec(
        "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id) VALUES (?, ?, 'email', ?, 'organization', 'importer')",
        grant,
        ctx.orgId,
        email,
      );
    }
    await exec(
      "INSERT INTO import_run (id, org_id, source_system, state, approved_by_user_id, approved_at) VALUES ('01J0RN0000000000000000R001', ?, 'test', 'applying', 'actor', ?)",
      ctx.orgId,
      V,
    );
    await exec(
      "INSERT INTO job (id, org_id, type, payload_json, resource_key, state, lease_owner, lease_until, fence) VALUES ('apply-job', ?, ?, ?, ?, 'running', 'worker', '2099-01-01T00:00:00.000Z', 1)",
      ctx.orgId,
      IMPORT_RUN_JOB.apply,
      JSON.stringify(IMPORT_RUN_JOB.payload('01J0RN0000000000000000R001')),
      IMPORT_RUN_JOB.resourceKey('01J0RN0000000000000000R001'),
    );
    await exec(
      "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('source', ?, 'source', 'npm', 'npmjs_proxy')",
      ctx.orgId,
    );
    await exec(
      "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('package', ?, 'source', 'npm', 'pkg')",
      ctx.orgId,
    );
    await exec(
      "INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key) VALUES ('blob', ?, ?, 1, 'blob')",
      ctx.orgId,
      'a'.repeat(64),
    );
    await exec(
      "INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json, blob_id, status, last_op_id) VALUES ('version', ?, 'package', '1.0.0', '1.0.0', '2026-01-01T00:00:00.000Z', 'source_release', '{}', 'blob', 'active', 'old-op')",
      ctx.orgId,
    );
    journal = createImportJournalStore({ executor, providerAnchors: anchors });
    store = createImportRollbackStore({ executor, providerAnchors: anchors });
  });
  afterEach(async () => {
    await database.close();
  });

  async function apply(applied: readonly ImportApplyItem[] = items) {
    const audits = applied.map(() => {
      const result = auditEvent({
        id: ulid(),
        now: V,
        action: 'project.create',
        actor: { type: 'user', id: 'actor' },
        target: { type: 'project', id: null },
        projectId: null,
        changes: { name: { new: 'Imported' } },
        context: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null },
      });
      if (!result.ok) throw new Error('invalid audit fixture');
      return result.event;
    });
    const outcome = await journal.applyChunk(
      ctx,
      delegatedMutationFence(
        'actor',
        '01J0RN0000000000000000R001',
        { id: 'apply-job', owner: 'worker', fence: 1 },
        {},
      ),
      {
        runId: '01J0RN0000000000000000R001',
        items: applied,
        audits,
        auditProjects: applied.map(() => null),
        widening: [],
        now: V,
      },
    );
    expect(outcome).toEqual({ ok: true });
    await exec(
      "UPDATE import_run SET state = 'applied', applied_count = ? WHERE org_id = ? AND id = '01J0RN0000000000000000R001'",
      applied.length,
      ctx.orgId,
    );
    await exec("DELETE FROM job WHERE id = 'apply-job'");
    await exec(
      "INSERT INTO job (id, org_id, type, payload_json, resource_key, state, lease_owner, lease_until, fence) VALUES ('rollback-job', ?, ?, ?, ?, 'running', 'worker', '2099-01-01T00:00:00.000Z', 1)",
      ctx.orgId,
      IMPORT_RUN_JOB.rollback,
      JSON.stringify({ runId: '01J0RN0000000000000000R001', requestedBy: 'requester' }),
      IMPORT_RUN_JOB.resourceKey('01J0RN0000000000000000R001'),
    );
  }
  const rollback = (requestedBy = 'requester') => {
    batches = [];
    return runImportRollback(
      { store, clock: fixedClock(now), ids: { ulid } },
      ctx,
      { runId: '01J0RN0000000000000000R001', requestedBy },
      fences,
    );
  };
  const refs = () =>
    rows<{
      entity_type: string;
      conflict_state: string;
      rolled_back_at: string | null;
      expired_at: string | null;
    }>(
      'SELECT entity_type, conflict_state, rolled_back_at, expired_at FROM import_ref WHERE org_id = ? ORDER BY entity_type',
      ctx.orgId,
    );
  const count = async (table: string, id: string) =>
    (await rows<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE id = ?`, id))[0]!.n;
  const runRow = () =>
    rows<Record<string, SqlValue>>(
      'SELECT state, last_error, rollback_restored_count, rollback_conflict_count, rollback_expired_count FROM import_run WHERE org_id = ? AND id = ?',
      ctx.orgId,
      '01J0RN0000000000000000R001',
    );
  const rollbackAudits = () =>
    rows<{ action: string; target_type: string; payload_json: string }>(
      "SELECT action, target_type, payload_json FROM audit_pending WHERE org_id = ? AND action = 'import_run.rollback' ORDER BY id",
      ctx.orgId,
    );
  const refId = async (type: string) =>
    (
      await rows<{ id: string }>(
        'SELECT id FROM import_ref WHERE org_id = ? AND entity_type = ?',
        ctx.orgId,
        type,
      )
    )[0]!.id;

  it('restores the version and deletes every created entity, persisting counts and audits', async () => {
    await apply();
    const created = await rows<{ id: string }>(
      "SELECT entity_id AS id FROM import_ref WHERE org_id = ? AND action = 'create' AND entity_type IN ('project','role','source','registered_name','access_grant')",
      ctx.orgId,
    );
    expect(created).toHaveLength(5);
    const [before] = await rows<{ revision: number }>(
      "SELECT revision FROM version WHERE id = 'version'",
    );
    const [pkg] = await rows<{ rev: number }>("SELECT rev FROM package WHERE id = 'package'");

    expect(await rollback()).toEqual({
      status: 'rolled_back',
      counts: { restored: 7, conflict: 0, expired: 0 },
    });

    for (const row of created) {
      expect(
        (await rows<{ n: number }>('SELECT count(*) AS n FROM project WHERE id = ?', row.id))[0]!
          .n +
          (await count('role', row.id)) +
          (await count('source', row.id)) +
          (await count('registered_name', row.id)) +
          (await count('access_grant', row.id)),
      ).toBe(0);
    }
    expect(await rows('SELECT 1 FROM project_source WHERE org_id = ?', ctx.orgId)).toEqual([]);
    expect(
      await rows(
        "SELECT 1 FROM role_permission WHERE org_id = ? AND role_id <> 'importer'",
        ctx.orgId,
      ),
    ).toEqual([]);
    expect(
      await rows<Record<string, unknown>>(
        "SELECT published_at, status, blob_id, metadata_json, revision, last_op_id FROM version WHERE id = 'version'",
      ),
    ).toEqual([
      {
        published_at: '2026-01-01T00:00:00.000Z',
        status: 'active',
        blob_id: 'blob',
        metadata_json: '{}',
        revision: before!.revision + 1,
        last_op_id: '01J0RN0000000000000000R001',
      },
    ]);
    expect(
      (await rows<{ rev: number }>("SELECT rev FROM package WHERE id = 'package'"))[0]!.rev,
    ).toBe(pkg!.rev + 1);
    expect(
      await rows(
        "SELECT reason FROM version_revision WHERE version_id = 'version' AND reason = 'import_rollback'",
      ),
    ).toHaveLength(1);
    expect((await refs()).every((ref) => ref.rolled_back_at === NOW)).toBe(true);
    expect(await runRow()).toEqual([
      {
        state: 'rolled_back',
        last_error: null,
        rollback_restored_count: 7,
        rollback_conflict_count: 0,
        rollback_expired_count: 0,
      },
    ]);
    const audits = await rollbackAudits();
    expect(audits.filter((audit) => audit.target_type !== 'import_run')).toHaveLength(7);
    const summary = audits.find((audit) => audit.target_type === 'import_run')!;
    expect(JSON.parse(summary.payload_json).changes).toMatchObject({
      restored: { new: 7 },
      conflict: { new: 0 },
      expired: { new: 0 },
    });
    expect(JSON.stringify(audits)).not.toMatch(/example\.test/);
  });

  it.each([
    ['project', "UPDATE project SET name = 'Edited' WHERE org_id = ?", ['project']],
    ['role', "UPDATE role SET name = 'Edited' WHERE org_id = ? AND key = 'reader'", ['role']],
    [
      'source',
      "UPDATE source SET removal_policy = 'exclude' WHERE org_id = ? AND name = 'registry'",
      ['source'],
    ],
    [
      'registered_name',
      "UPDATE registered_name SET pattern = 'x/*' WHERE org_id = ?",
      ['registered_name', 'source'],
    ],
    [
      'project_source',
      'UPDATE project_source SET precedence = 42 WHERE org_id = ?',
      ['project', 'project_source', 'source'],
    ],
    [
      'access_grant',
      "UPDATE access_grant SET created_by = 'actor' WHERE org_id = ? AND id <> 'grant' AND id <> 'grant-requester'",
      ['access_grant', 'project', 'role'],
    ],
    ['version', 'UPDATE version SET metadata_json = \'{"d":1}\' WHERE org_id = ?', ['version']],
  ] as const)(
    'records a conflict and writes nothing for an edited %s (and what depends on it)',
    async (type, edit, blocked) => {
      await apply();
      await exec(edit, ctx.orgId);
      const outcome = await rollback();
      expect(outcome).toEqual({
        status: 'rolled_back',
        counts: { restored: 7 - blocked.length, conflict: blocked.length, expired: 0 },
      });
      const marked = (await refs()).filter((ref) => ref.conflict_state === 'changed_after_import');
      expect(marked.map((ref) => ref.entity_type)).toEqual([...blocked].sort());
      expect(marked.every((ref) => ref.rolled_back_at === null)).toBe(true);
      expect((await runRow())[0]).toMatchObject({
        state: 'rolled_back',
        rollback_restored_count: 7 - blocked.length,
        rollback_conflict_count: blocked.length,
      });
      expect(
        (await rollbackAudits()).filter((audit) => blocked.some((b) => b === audit.target_type)),
      ).toEqual([]);
      expect(type).toBe(blocked.find((b) => b === type));
    },
  );

  it('keeps source publish policy outside the imported hash domain', async () => {
    await apply();
    await exec(
      "UPDATE source SET require_publish_approval = 1 WHERE org_id = ? AND name = 'registry'",
      ctx.orgId,
    );
    expect(await rollback()).toEqual({
      status: 'rolled_back',
      counts: { restored: 7, conflict: 0, expired: 0 },
    });
  });

  it('never restores a version edited between the read and the batch', async () => {
    await apply();
    beforeBatch = async () => {
      await exec(
        "UPDATE version SET status = 'yanked', revision = revision + 1 WHERE id = 'version'",
      );
    };
    const outcome = await rollback();
    expect((outcome as { counts: ImportRollbackCounts }).counts.conflict).toBe(1);
    expect(await rows("SELECT status, published_at FROM version WHERE id = 'version'")).toEqual([
      { status: 'yanked', published_at: V },
    ]);
  });

  it('keeps a source that gained a dependent after the read, never cascading', async () => {
    await apply();
    const sourceId = (
      await rows<{ id: string }>(
        "SELECT id FROM source WHERE org_id = ? AND name = 'registry'",
        ctx.orgId,
      )
    )[0]!.id;
    hookWhen = (statements) => statements.some((s) => s.sql.startsWith('DELETE FROM source '));
    beforeBatch = async () => {
      await exec(
        "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES ('late', ?, ?, 'npm', 'late/*')",
        ctx.orgId,
        sourceId,
      );
    };
    await rollback();
    expect(await count('source', sourceId)).toBe(1);
    expect(await count('registered_name', 'late')).toBe(1);
    const source = (await refs()).find((ref) => ref.entity_type === 'source')!;
    expect(source.conflict_state).toBe('changed_after_import');
    expect(source.rolled_back_at).toBeNull();
  });

  describe.each([
    ['after the read', true],
    ['before the read', false],
  ])('a registered name of another organization %s', (_when, late) => {
    it('keeps the source it references and survives the rollback', async () => {
      await apply();
      const sourceId = (
        await rows<{ id: string }>(
          "SELECT id FROM source WHERE org_id = ? AND name = 'registry'",
          ctx.orgId,
        )
      )[0]!.id;
      const insert = async (): Promise<void> => {
        await forgedExec(
          "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES ('foreign-name', ?, ?, 'npm', 'foreign/*')",
          foreign.orgId,
          sourceId,
        );
      };
      if (late) {
        hookWhen = (statements) => statements.some((s) => s.sql.startsWith('DELETE FROM source '));
        beforeBatch = insert;
      } else {
        await insert();
      }
      await rollback();
      expect(await count('source', sourceId)).toBe(1);
      expect(await count('registered_name', 'foreign-name')).toBe(1);
      const source = (await refs()).find((ref) => ref.entity_type === 'source')!;
      expect(source.conflict_state).toBe('changed_after_import');
      expect(source.rolled_back_at).toBeNull();
    });
  });

  it('restores the prior published_at_basis with the version', async () => {
    await apply();
    expect(await rows("SELECT published_at_basis FROM version WHERE id = 'version'")).toEqual([
      { published_at_basis: 'import_time' },
    ]);
    await rollback();
    expect(await rows("SELECT published_at_basis FROM version WHERE id = 'version'")).toEqual([
      { published_at_basis: 'source_release' },
    ]);
  });

  it('never restores a before-image written without a basis', async () => {
    await apply();
    await exec(
      "UPDATE import_ref SET before_image_json = json_remove(before_image_json, '$.published_at_basis') WHERE org_id = ? AND entity_type = 'version'",
      ctx.orgId,
    );
    await rollback();
    expect(
      await rows("SELECT published_at, published_at_basis FROM version WHERE id = 'version'"),
    ).toEqual([{ published_at: V, published_at_basis: 'import_time' }]);
    expect((await refs()).find((ref) => ref.entity_type === 'version')).toMatchObject({
      conflict_state: 'changed_after_import',
      rolled_back_at: null,
    });
  });

  it('rolls back a ref whose conflict was resolved', async () => {
    await apply();
    await exec("UPDATE import_ref SET conflict_state = 'resolved' WHERE org_id = ?", ctx.orgId);
    expect(await rollback()).toMatchObject({ status: 'rolled_back', counts: { restored: 7 } });
  });

  it('restores a version whose unchanged blob holds a live purge lease', async () => {
    await apply();
    await exec(
      "UPDATE blob SET purge_lease_until = '2999-01-01T00:00:00.000Z' WHERE org_id = ?",
      ctx.orgId,
    );
    expect(await rollback()).toMatchObject({ counts: { restored: 7 } });
  });

  it('refuses a chunk naming the same ref twice', async () => {
    await apply();
    const id = await refId('project');
    expect(
      await store.applyChunk(ctx, fences('requester', '01J0RN0000000000000000R001', {}), {
        runId: '01J0RN0000000000000000R001',
        approvedByUserId: 'actor',
        actions: [
          { kind: 'conflict', refId: id },
          { kind: 'conflict', refId: id },
        ],
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: 'conflict' });
  });

  it('counts a malformed expiry as expired', async () => {
    await apply();
    await exec(
      "UPDATE import_run SET before_image_expires_at = 'garbage' WHERE org_id = ? AND id = '01J0RN0000000000000000R001'",
      ctx.orgId,
    );
    const id = await refId('project');
    const result = await store.applyChunk(
      ctx,
      fences('requester', '01J0RN0000000000000000R001', {}),
      {
        runId: '01J0RN0000000000000000R001',
        approvedByUserId: 'actor',
        actions: [{ kind: 'expired', refId: id }],
        now: NOW,
      },
    );
    expect(result).toEqual({ ok: true, outcomes: ['expired'] });
    expect((await refs()).find((ref) => ref.entity_type === 'project')).toMatchObject({
      expired_at: NOW,
      conflict_state: 'none',
    });
  });

  const restoreVersion = async (domain: Record<string, string | null>) => {
    const id = await refId('version');
    const entityId = (
      await rows<{ entity_id: string }>('SELECT entity_id FROM import_ref WHERE id = ?', id)
    )[0]!.entity_id;
    const event = auditEvent({
      id: ulid(),
      now: NOW,
      action: 'import_run.rollback',
      actor: { type: 'user', id: 'requester' },
      target: { type: 'version', id: entityId },
      projectId: null,
      changes: { state: { new: 'restored' } },
      context: {
        opId: '01J0RN0000000000000000R001',
        requestId: '01J0RN0000000000000000R001',
        sourceIp: null,
        tokenSelector: null,
      },
    });
    if (!event.ok) throw new Error('invalid audit fixture');
    return store.applyChunk(
      ctx,
      fences('requester', '01J0RN0000000000000000R001', { [entityId]: 2 }),
      {
        runId: '01J0RN0000000000000000R001',
        approvedByUserId: 'actor',
        actions: [
          {
            kind: 'restore',
            refId: id,
            entityType: 'version',
            entityId,
            guard: { kind: 'revision', revision: 2 },
            domain,
            audit: event.event,
          },
        ],
        now: NOW,
      },
    );
  };

  it.each([
    ['null', null],
    ['an unknown value', 'garbage'],
  ])('turns a before-image basis of %s into a conflict without writing', async (_name, basis) => {
    await apply();
    expect(
      await restoreVersion({ published_at: '2026-01-01T00:00:00.000Z', published_at_basis: basis }),
    ).toEqual({
      ok: true,
      outcomes: ['conflict'],
    });
    expect(
      await rows(
        "SELECT published_at, published_at_basis, revision FROM version WHERE id = 'version'",
      ),
    ).toEqual([{ published_at: V, published_at_basis: 'import_time', revision: 2 }]);
    expect((await refs()).find((ref) => ref.entity_type === 'version')).toMatchObject({
      conflict_state: 'changed_after_import',
      rolled_back_at: null,
    });
    expect(await rollbackAudits()).toEqual([]);
  });

  it('keeps a version whose basis changed after the import as a conflict', async () => {
    await apply();
    await exec("UPDATE version SET published_at_basis = 'packagist_added' WHERE id = 'version'");
    expect(await rollback()).toMatchObject({
      status: 'rolled_back',
      counts: { restored: 6, conflict: 1, expired: 0 },
    });
    expect(
      await rows(
        "SELECT published_at, published_at_basis, revision FROM version WHERE id = 'version'",
      ),
    ).toEqual([{ published_at: V, published_at_basis: 'packagist_added', revision: 2 }]);
    expect((await refs()).find((ref) => ref.entity_type === 'version')).toMatchObject({
      conflict_state: 'changed_after_import',
      rolled_back_at: null,
    });
  });

  it('gives each version restored in one chunk its own snapshot id', async () => {
    await exec(
      "INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json, blob_id, status, last_op_id) VALUES ('version-2', ?, 'package', '2.0.0', '2.0.0', '2026-01-01T00:00:00.000Z', 'source_release', '{}', 'blob', 'active', 'old-op')",
      ctx.orgId,
    );
    await apply([
      ...items,
      {
        type: 'version_override',
        external_ref: 'override-2',
        source: { existing: { project: null, name: 'source' } },
        package: 'pkg',
        version: '2.0.0',
        published_at: V,
        basis: 'import_time',
      },
    ]);
    expect(await rollback()).toMatchObject({ counts: { restored: 8, conflict: 0 } });
    const snapshots = await rows<{ id: string; version_id: string }>(
      "SELECT id, version_id FROM version_revision WHERE reason = 'import_rollback' ORDER BY version_id",
    );
    expect(snapshots.map((row) => row.version_id)).toEqual(['version', 'version-2']);
    expect(new Set(snapshots.map((row) => row.id)).size).toBe(2);
  });

  it('keeps a created project that still has an unrelated dependent', async () => {
    await apply();
    const projectId = (
      await rows<{ id: string }>(
        "SELECT id FROM project WHERE org_id = ? AND slug = 'imported'",
        ctx.orgId,
      )
    )[0]!.id;
    await exec(
      "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, project_id, role_id) VALUES ('manual', ?, 'email', 'x@example.test', 'project', ?, 'importer')",
      ctx.orgId,
      projectId,
    );
    const outcome = await rollback();
    expect(outcome).toMatchObject({ status: 'rolled_back' });
    expect(await count('project', projectId)).toBe(1);
    expect(await count('access_grant', 'manual')).toBe(1);
  });

  it('refuses to delete a created grant on a role that protects the last holder', async () => {
    await apply();
    await exec(
      "UPDATE role SET protects_last_holder = 1 WHERE org_id = ? AND key = 'reader'",
      ctx.orgId,
    );
    const outcome = await rollback();
    expect(outcome).toMatchObject({ status: 'rolled_back' });
    expect(
      (await refs()).filter((ref) => ref.conflict_state === 'changed_after_import').length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      await rows(
        "SELECT 1 FROM access_grant WHERE org_id = ? AND subject_value = 'readers'",
        ctx.orgId,
      ),
    ).toHaveLength(1);
  });

  it('marks refs of an expired journal expired without writing', async () => {
    await apply();
    await exec(
      "UPDATE import_run SET state = 'verified', before_image_expires_at = '2026-10-20T11:59:59.999Z' WHERE org_id = ? AND id = '01J0RN0000000000000000R001'",
      ctx.orgId,
    );
    expect(await rollback()).toEqual({
      status: 'rolled_back',
      counts: { restored: 0, conflict: 0, expired: 7 },
    });
    expect(
      (await refs()).every((ref) => ref.expired_at === NOW && ref.rolled_back_at === null),
    ).toBe(true);
    expect(await count('project', await projectId())).toBe(1);
    expect((await runRow())[0]).toMatchObject({ rollback_expired_count: 7 });
    const [version] = await rows<{ published_at: string }>(
      "SELECT published_at FROM version WHERE id = 'version'",
    );
    expect(version!.published_at).toBe(V);
  });
  const projectId = async () =>
    (await rows<{ id: string }>("SELECT id FROM project WHERE slug = 'imported'"))[0]!.id;

  it('does not mark an unexpired journal expired even when asked to', async () => {
    await apply();
    const id = await refId('project');
    const result = await store.applyChunk(
      ctx,
      fences('requester', '01J0RN0000000000000000R001', {}),
      {
        runId: '01J0RN0000000000000000R001',
        approvedByUserId: 'actor',
        actions: [{ kind: 'expired', refId: id }],
        now: NOW,
      },
    );
    expect(result).toEqual({ ok: true, outcomes: ['conflict'] });
    expect((await refs()).find((ref) => ref.entity_type === 'project')).toMatchObject({
      expired_at: null,
      conflict_state: 'changed_after_import',
    });
  });

  it('refuses to finish and writes nothing when the lease is lost', async () => {
    await apply();
    await exec("UPDATE job SET fence = 2 WHERE org_id = ? AND id = 'rollback-job'", ctx.orgId);
    await expect(rollback()).rejects.toThrow('refused');
    expect(await runRow()).toEqual([
      {
        state: 'applied',
        last_error: null,
        rollback_restored_count: 0,
        rollback_conflict_count: 0,
        rollback_expired_count: 0,
      },
    ]);
    expect((await refs()).every((ref) => ref.rolled_back_at === null)).toBe(true);
    expect(await count('project', await projectId())).toBe(1);
    expect(await rollbackAudits()).toEqual([]);
  });

  it('keeps the prior state and records only last_error when authority is lost', async () => {
    await apply();
    await exec("DELETE FROM access_grant WHERE id = 'grant-requester'");
    expect(await rollback()).toEqual({ status: 'failed', reason: 'guard_failed' });
    expect(await runRow()).toEqual([
      {
        state: 'applied',
        last_error: 'guard_failed',
        rollback_restored_count: 0,
        rollback_conflict_count: 0,
        rollback_expired_count: 0,
      },
    ]);
    expect((await refs()).every((ref) => ref.rolled_back_at === null)).toBe(true);
    expect(await count('project', await projectId())).toBe(1);
    const audits = await rollbackAudits();
    expect(audits).toHaveLength(1);
    expect(JSON.parse(audits[0]!.payload_json).changes.state).toEqual({ new: 'failed' });
  });

  it.each([
    ['the approver lost the import permission', "DELETE FROM access_grant WHERE id = 'grant'"],
    [
      'the requester lost the import permission',
      "DELETE FROM access_grant WHERE id = 'grant-requester'",
    ],
  ])('refuses the batch when %s', async (_name, change) => {
    await apply();
    await exec(change);
    expect(await rollback()).toEqual({ status: 'failed', reason: 'guard_failed' });
    expect((await refs()).every((ref) => ref.rolled_back_at === null)).toBe(true);
    expect(await count('project', await projectId())).toBe(1);
  });

  it('refuses the batch and the finish when the job names another requester', async () => {
    await apply();
    await exec(
      'UPDATE job SET payload_json = ? WHERE id = ?',
      JSON.stringify({ runId: '01J0RN0000000000000000R001', requestedBy: 'actor' }),
      'rollback-job',
    );
    await expect(rollback()).rejects.toThrow('refused');
    expect((await refs()).every((ref) => ref.rolled_back_at === null)).toBe(true);
  });

  it('resumes after a failed rollback without recounting restored refs', async () => {
    await apply();
    await exec("DELETE FROM access_grant WHERE id = 'grant'");
    expect(await rollback()).toEqual({ status: 'failed', reason: 'guard_failed' });
    await exec(
      "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id) VALUES ('grant', ?, 'email', 'actor@example.test', 'organization', 'importer')",
      ctx.orgId,
    );
    expect(await rollback()).toEqual({
      status: 'rolled_back',
      counts: { restored: 7, conflict: 0, expired: 0 },
    });
    expect((await runRow())[0]).toMatchObject({ state: 'rolled_back', last_error: null });
  });

  it('reports too_large and writes nothing when a batch exceeds the byte budget', async () => {
    await apply();
    const id = await refId('version');
    const entityId = (
      await rows<{ entity_id: string }>('SELECT entity_id FROM import_ref WHERE id = ?', id)
    )[0]!.entity_id;
    const event = auditEvent({
      id: ulid(),
      now: NOW,
      action: 'import_run.rollback',
      actor: { type: 'user', id: 'requester' },
      target: { type: 'version', id: entityId },
      projectId: null,
      changes: { state: { new: 'restored' } },
      context: {
        opId: '01J0RN0000000000000000R001',
        requestId: '01J0RN0000000000000000R001',
        sourceIp: null,
        tokenSelector: null,
      },
    });
    if (!event.ok) throw new Error('invalid audit fixture');
    const action: ImportRollbackAction = {
      kind: 'restore',
      refId: id,
      entityType: 'version',
      entityId,
      guard: { kind: 'revision', revision: 2 },
      domain: { metadata_json: 'x'.repeat(5 * 1024 * 1024), published_at_basis: 'source_release' },
      audit: event.event,
    };
    expect(
      await store.applyChunk(
        ctx,
        fences('requester', '01J0RN0000000000000000R001', { [entityId]: 2 }),
        {
          runId: '01J0RN0000000000000000R001',
          approvedByUserId: 'actor',
          actions: [action],
          now: NOW,
        },
      ),
    ).toEqual({ ok: false, reason: 'too_large' });
    expect(await rows("SELECT metadata_json FROM version WHERE id = 'version'")).toEqual([
      { metadata_json: '{}' },
    ]);
    expect((await refs()).every((ref) => ref.rolled_back_at === null)).toBe(true);
  });

  it('downgrades columns outside the store allowlist to a conflict', async () => {
    await apply();
    const id = await refId('version');
    const entityId = (
      await rows<{ entity_id: string }>('SELECT entity_id FROM import_ref WHERE id = ?', id)
    )[0]!.entity_id;
    const event = auditEvent({
      id: ulid(),
      now: NOW,
      action: 'import_run.rollback',
      actor: { type: 'user', id: 'requester' },
      target: { type: 'version', id: entityId },
      projectId: null,
      changes: { state: { new: 'restored' } },
      context: {
        opId: '01J0RN0000000000000000R001',
        requestId: '01J0RN0000000000000000R001',
        sourceIp: null,
        tokenSelector: null,
      },
    });
    if (!event.ok) throw new Error('invalid audit fixture');
    for (const column of ['revision', 'org_id', 'package_id', 'updated_at', 'last_op_id']) {
      const result = await store.applyChunk(
        ctx,
        fences('requester', '01J0RN0000000000000000R001', { [entityId]: 2 }),
        {
          runId: '01J0RN0000000000000000R001',
          approvedByUserId: 'actor',
          actions: [
            {
              kind: 'restore',
              refId: id,
              entityType: 'version',
              entityId,
              guard: { kind: 'revision', revision: 2 },
              domain: { [column]: 'x' },
              audit: event.event,
            },
          ],
          now: NOW,
        },
      );
      expect(result).toEqual({ ok: true, outcomes: ['conflict'] });
      await exec(
        "UPDATE import_ref SET conflict_state = 'none' WHERE org_id = ? AND id = ?",
        ctx.orgId,
        id,
      );
    }
    expect(await rows("SELECT revision, last_op_id FROM version WHERE id = 'version'")).toEqual([
      { revision: 2, last_op_id: '01J0RN0000000000000000R001' },
    ]);
    expect(await rollbackAudits()).toEqual([]);
  });

  it('is organization scoped: a ref of another organization is never marked', async () => {
    await apply();
    await exec(
      "INSERT INTO import_ref (id, org_id, import_run_id, entity_type, entity_id, external_ref, action) VALUES ('foreign-ref', ?, '01J0RN0000000000000000R001', 'project', ?, 'foreign', 'create')",
      foreign.orgId,
      await projectId(),
    );
    const result = await store.applyChunk(
      ctx,
      fences('requester', '01J0RN0000000000000000R001', {}),
      {
        runId: '01J0RN0000000000000000R001',
        approvedByUserId: 'actor',
        actions: [{ kind: 'conflict', refId: 'foreign-ref' }],
        now: NOW,
      },
    );
    expect(result).toEqual({ ok: true, outcomes: ['conflict'] });
    expect(
      await rows("SELECT conflict_state, rolled_back_at FROM import_ref WHERE id = 'foreign-ref'"),
    ).toEqual([{ conflict_state: 'none', rolled_back_at: null }]);
  });

  it('rolls back a seeded mass import within statement, parameter and byte budgets', async () => {
    await exec(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 150)
       INSERT INTO project (id, org_id, slug, name, status, token_max_scope, require_publish_approval)
       SELECT 'mp' || i, ?, 'mass-' || i, 'Mass', 'active', 'full', 0 FROM n`,
      ctx.orgId,
    );
    await exec(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 150)
       INSERT INTO import_ref (id, org_id, import_run_id, entity_type, entity_id, external_ref, action)
       SELECT 'mr' || i, ?, '01J0RN0000000000000000R001', 'project', 'mp' || i, 'mass-' || i, 'create' FROM n`,
      ctx.orgId,
    );
    const hashes = await Promise.all(
      Array.from({ length: 150 }, async (_, index) => ({
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
    await exec(
      `WITH h AS (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.hash') AS hash FROM json_each(?))
       UPDATE import_ref SET content_hash = (SELECT hash FROM h WHERE h.id = import_ref.id) WHERE id IN (SELECT id FROM h)`,
      JSON.stringify(hashes),
    );
    await exec(
      "UPDATE import_run SET state = 'applied' WHERE org_id = ? AND id = '01J0RN0000000000000000R001'",
      ctx.orgId,
    );
    await exec("DELETE FROM job WHERE id = 'apply-job'");
    await exec(
      "INSERT INTO job (id, org_id, type, payload_json, resource_key, state, lease_owner, lease_until, fence) VALUES ('rollback-job', ?, ?, ?, ?, 'running', 'worker', '2099-01-01T00:00:00.000Z', 1)",
      ctx.orgId,
      IMPORT_RUN_JOB.rollback,
      JSON.stringify({ runId: '01J0RN0000000000000000R001', requestedBy: 'requester' }),
      IMPORT_RUN_JOB.resourceKey('01J0RN0000000000000000R001'),
    );
    const outcome = await runImportRollback(
      { store, clock: fixedClock(NOW), ids: { ulid } },
      ctx,
      { runId: '01J0RN0000000000000000R001', requestedBy: 'requester' },
      fences,
    );
    expect(outcome).toEqual({
      status: 'rolled_back',
      counts: { restored: 150, conflict: 0, expired: 0 },
    });
    expect(await rows("SELECT 1 FROM project WHERE id LIKE 'mp%'")).toEqual([]);
    const mutating = batches.filter((batch) => batch.some((s) => s.sql.startsWith('DELETE')));
    expect(mutating.length).toBeGreaterThanOrEqual(3);
    for (const batch of mutating) {
      expect(batch.length).toBeLessThanOrEqual(900);
      expect(batch.every((s) => s.params.length <= 100)).toBe(true);
    }
  });

  it('reads live state scoped to the organization', async () => {
    await apply();
    const id = await projectId();
    expect(await store.liveStates(ctx, [{ entityType: 'project', entityId: id }])).toEqual([
      expect.objectContaining({
        exists: true,
        referenced: true,
        guard: { kind: 'revision', revision: 1 },
      }),
    ]);
    expect(await store.liveStates(foreign, [{ entityType: 'project', entityId: id }])).toEqual([
      expect.objectContaining({ exists: false, guard: null }),
    ]);
    expect(await store.liveStates(ctx, [{ entityType: 'unknown', entityId: id }])).toEqual([
      expect.objectContaining({ exists: false }),
    ]);
  });

  it('declares every foreign key that references an importable table as a dependent or owned child', async () => {
    const owned = new Set([
      'role_permission.role_id',
      'representation_clock.project_id',
      'source_sync_package.source_id',
    ]);
    const tables = await rows<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    );
    for (const entity of Object.values(ROLLBACK_ENTITIES).filter((e) => e.deletable)) {
      const declared = new Set(entity.dependents.map(([table, column]) => `${table}.${column}`));
      for (const { name } of tables) {
        const keys = await rows<{ id: number; table: string; from: string }>(
          `SELECT "id", "table", "from" FROM pragma_foreign_key_list('${name}')`,
        );
        for (const fk of keys) {
          if (fk.table !== entity.table) continue;
          if (fk.from === 'org_id' && keys.some((other) => other.id === fk.id && other !== fk)) {
            continue;
          }
          const key = `${name}.${fk.from}`;
          expect(declared.has(key) || owned.has(key), `${entity.table} <- ${key}`).toBe(true);
        }
      }
    }
  });
});
