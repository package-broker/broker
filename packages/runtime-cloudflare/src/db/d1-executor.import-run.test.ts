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
import {
  IMPORT_RUN_JOB,
  IMPORT_VERIFICATION_JOB,
  type ImportRunState,
  type ImportRunCreateWrite,
  type ImportRunStore,
  type ImportRunWrite,
} from '@package-broker/core/import/run-service';
import type { CoreBlobStore as BlobStore } from '@package-broker/core/platform/blob';
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
    async stage() {
      throw new Error('not_implemented');
    },
    async openStaged() {
      throw new Error('not_implemented');
    },
    async promote() {
      throw new Error('not_implemented');
    },
    async discard() {
      throw new Error('not_implemented');
    },
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
        type: IMPORT_RUN_JOB.apply,
        resource_key: IMPORT_RUN_JOB.resourceKey('run'),
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
    ).toEqual([{ type: IMPORT_RUN_JOB.rollback, resource_key: IMPORT_RUN_JOB.resourceKey('run') }]);
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

  const operations = [
    'approveRun',
    'requestApply',
    'cancelRun',
    'acceptRun',
    'requestRollback',
  ] as const;
  const states: readonly ImportRunState[] = [
    'planned',
    'applying',
    'failed',
    'applied',
    'verifying',
    'verified',
    'rolled_back',
    'cancelled',
  ];
  const allowedStates = {
    approveRun: ['planned'],
    requestApply: ['planned'],
    cancelRun: ['planned'],
    acceptRun: ['verified'],
    requestRollback: ['failed', 'applied', 'verifying', 'verified'],
  };
  async function seedLifecycle(state: ImportRunState, approvedAt: string | null = null) {
    await executor.batch([
      stmt('DELETE FROM job WHERE org_id = ?', ctx.orgId),
      stmt('DELETE FROM import_run WHERE org_id = ? AND id = ?', ctx.orgId, 'run'),
      stmt(
        'INSERT INTO import_run (id, org_id, source_system, state, approved_at) VALUES (?, ?, ?, ?, ?)',
        'run',
        ctx.orgId,
        'test',
        state,
        approvedAt,
      ),
    ]);
  }
  const lifecycleRow = () =>
    executor.all(
      stmt(
        'SELECT state, approved_at, accepted_at, source_system FROM import_run WHERE org_id = ? AND id = ?',
        ctx.orgId,
        'run',
      ),
    );
  const jobs = () =>
    executor.all(
      stmt('SELECT type, resource_key, payload_json FROM job WHERE org_id = ?', ctx.orgId),
    );
  const audited = (value: ImportRunWrite): ImportRunWrite => ({
    ...value,
    audit: stmt(
      'UPDATE import_run SET source_system = ? WHERE org_id = ? AND id = ?',
      'audited',
      ctx.orgId,
      value.runId,
    ),
  });

  it('checks every allowed and refused lifecycle operation in every schema state', async () => {
    for (const operation of operations) {
      for (const state of states) {
        await seedLifecycle(state, operation === 'requestApply' ? now : null);
        const before = await lifecycleRow();
        const value = audited(await write());
        const allowed = allowedStates[operation].includes(state);
        const result = await store[operation](ctx, fence, value);
        if (!allowed) {
          expect(result, `${operation} from ${state}`).toMatchObject({
            ok: false,
            reason: 'conflict',
          });
          expect(await lifecycleRow()).toEqual(before);
          expect(await jobs()).toEqual([]);
          continue;
        }
        expect(result, `${operation} from ${state}`).toMatchObject({ ok: true });
        expect(await lifecycleRow()).toEqual([
          {
            state:
              operation === 'requestApply'
                ? 'applying'
                : operation === 'cancelRun'
                  ? 'cancelled'
                  : state,
            approved_at: operation === 'approveRun' || operation === 'requestApply' ? now : null,
            accepted_at: operation === 'acceptRun' ? now : null,
            source_system: 'audited',
          },
        ]);
        const queued = operation === 'requestApply' || operation === 'requestRollback';
        expect(await jobs()).toEqual(
          queued
            ? [
                {
                  type:
                    operation === 'requestApply' ? IMPORT_RUN_JOB.apply : IMPORT_RUN_JOB.rollback,
                  resource_key: IMPORT_RUN_JOB.resourceKey('run'),
                  payload_json: JSON.stringify(
                    operation === 'requestApply'
                      ? IMPORT_RUN_JOB.payload('run')
                      : { ...IMPORT_RUN_JOB.payload('run'), requestedBy: fence.userId },
                  ),
                },
              ]
            : [],
        );
        if (queued) {
          const batch = batches.at(-1);
          expect(batch?.some((item) => /insert into "job"/i.test(item.sql))).toBe(true);
          if (operation === 'requestApply')
            expect(batch?.some((item) => /update "import_run"/i.test(item.sql))).toBe(true);
          expect(batch).toContainEqual(value.audit);
        }
      }
    }
  });

  it('gives exactly one concurrent approval or claim a win and the other a typed conflict', async () => {
    for (const operation of [
      'approveRun',
      'requestApply',
      'acceptRun',
      'requestRollback',
    ] as const) {
      await seedLifecycle(
        operation === 'acceptRun' || operation === 'requestRollback' ? 'verified' : 'planned',
        operation === 'requestApply' ? now : null,
      );
      const value = audited(await write());
      const results = await Promise.all([
        store[operation](ctx, fence, value),
        store[operation](ctx, fence, value),
      ]);
      expect(
        results.filter((result) => result.ok),
        operation,
      ).toHaveLength(1);
      expect(
        results.filter((result) => !result.ok),
        operation,
      ).toEqual([{ ok: false, reason: 'conflict' }]);
      expect(await jobs()).toHaveLength(
        operation === 'requestApply' || operation === 'requestRollback' ? 1 : 0,
      );
    }
  });

  it('never writes with a stale expected state, including a race immediately before the batch', async () => {
    for (const operation of operations) {
      await seedLifecycle(
        operation === 'acceptRun' || operation === 'requestRollback' ? 'verified' : 'planned',
        operation === 'requestApply' ? now : null,
      );
      const value = audited(await write());
      beforeBatch = async () => {
        await executor.batch([
          stmt(
            'UPDATE import_run SET state = ? WHERE org_id = ? AND id = ?',
            'cancelled',
            ctx.orgId,
            'run',
          ),
        ]);
      };
      expect(await store[operation](ctx, fence, value), operation).toMatchObject({
        ok: false,
        reason: 'conflict',
      });
      expect(await lifecycleRow()).toEqual([
        {
          state: 'cancelled',
          approved_at: operation === 'requestApply' ? now : null,
          accepted_at: null,
          source_system: 'test',
        },
      ]);
      expect(await jobs()).toEqual([]);
    }
  });

  it('rolls back job enqueue, state, audit and idempotency together on a later batch failure', async () => {
    for (const operation of ['requestApply', 'requestRollback'] as const) {
      await seedLifecycle(operation === 'requestApply' ? 'planned' : 'applied', now);
      const before = await lifecycleRow();
      const value = audited(await write());
      const result = await store[operation](ctx, fence, {
        ...value,
        idempotency: stmt(
          "INSERT INTO access_mutation_guard (key) VALUES ('failure'), ('failure')",
        ),
      });
      expect(result.ok).toBe(false);
      expect(await lifecycleRow()).toEqual(before);
      expect(await jobs()).toEqual([]);
    }
  });

  it('rejects malformed approvals at the store boundary and refuses them as apply evidence', async () => {
    const malformed = [
      '',
      'not-a-time',
      now.slice(0, 10),
      now.replace(/\.\d{3}Z$/, 'Z'),
      '2026-02-30T10:00:00.000Z',
      new Date(Date.parse(now) + 120_000).toISOString(),
    ];
    for (const value of malformed) {
      await seedLifecycle('planned');
      const approval = await write();
      expect(
        await store.approveRun(ctx, fence, {
          ...approval,
          now: value,
          approvedAt: value,
          credentialWindowUntil: Number.isFinite(Date.parse(value))
            ? new Date(Date.parse(value) + 3_600_000).toISOString()
            : '',
        }),
      ).toMatchObject({ ok: false, reason: 'conflict' });
      expect(await lifecycleRow()).toEqual([
        { state: 'planned', approved_at: null, accepted_at: null, source_system: 'test' },
      ]);
      await seedLifecycle('planned', value);
      expect(await store.requestApply(ctx, fence, await write())).toMatchObject({
        ok: false,
        reason: 'conflict',
      });
      expect(await jobs()).toEqual([]);
    }
  });

  it('compares every observed approval and acceptance field inside the batch', async () => {
    for (const column of [
      'plan_hash',
      'approved_at',
      'approved_by_user_id',
      'accepted_at',
      'before_image_expires_at',
    ]) {
      await seedLifecycle('planned');
      const value = audited(await write());
      beforeBatch = async () => {
        await executor.batch([
          stmt(
            `UPDATE import_run SET ${column} = ? WHERE org_id = ? AND id = ?`,
            column === 'approved_by_user_id' ? 'actor' : now,
            ctx.orgId,
            'run',
          ),
        ]);
      };
      expect(await store.cancelRun(ctx, fence, value), column).toMatchObject({
        ok: false,
        reason: 'conflict',
      });
      expect(
        await executor.all(
          stmt(
            'SELECT state, source_system FROM import_run WHERE org_id = ? AND id = ?',
            ctx.orgId,
            'run',
          ),
        ),
      ).toEqual([{ state: 'planned', source_system: 'test' }]);
    }
  });

  it.each([
    ['requestApply', 'planned'],
    ['requestRollback', 'applied'],
    ['requestRollback', 'verifying'],
  ] as const)('refuses %s from %s while a job is queued or running', async (operation, state) => {
    for (const resourceKey of [
      IMPORT_RUN_JOB.resourceKey('run'),
      IMPORT_VERIFICATION_JOB.resourceKey('run'),
    ]) {
      for (const jobState of ['queued', 'running']) {
        await seedLifecycle(state, now);
        await executor.batch([
          stmt(
            'INSERT INTO job (id, org_id, type, resource_key, payload_json, state, lease_owner, lease_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            'existing',
            ctx.orgId,
            IMPORT_RUN_JOB.apply,
            resourceKey,
            JSON.stringify(IMPORT_RUN_JOB.payload('run')),
            jobState,
            'worker',
            new Date(Date.parse(now) + 60_000).toISOString(),
          ),
        ]);
        const before = await lifecycleRow();
        expect(await store[operation](ctx, fence, audited(await write()))).toMatchObject({
          ok: false,
          reason: 'conflict',
        });
        expect(await lifecycleRow()).toEqual(before);
        expect(await jobs()).toHaveLength(1);
      }
    }
  });

  it('refuses rollback with expired or malformed before-image evidence', async () => {
    for (const expiry of ['', 'not-a-time', new Date(Date.parse(now) - 60_000).toISOString()]) {
      await seedLifecycle('applied', now);
      await executor.batch([
        stmt(
          'UPDATE import_run SET before_image_expires_at = ? WHERE org_id = ? AND id = ?',
          expiry,
          ctx.orgId,
          'run',
        ),
      ]);
      expect(await store.requestRollback(ctx, fence, audited(await write()))).toMatchObject({
        ok: false,
        reason: 'conflict',
      });
      expect(await jobs()).toEqual([]);
    }
  });
  it('reads only own organization runs and omits secret-bearing columns', async () => {
    await executor.batch([
      stmt(
        "INSERT INTO import_run (id, org_id, source_system, last_error) VALUES ('own-read', ?, 'test', 'PRIVATE')",
        ctx.orgId,
      ),
      stmt(
        "INSERT INTO import_run (id, org_id, source_system) VALUES ('foreign-read', ?, 'test')",
        foreign.orgId,
      ),
      stmt(
        "INSERT INTO import_ref (id, org_id, import_run_id, entity_type, entity_id, external_ref, action, before_image_json) VALUES ('ref-read', ?, 'own-read', 'source', 'source', 'PRIVATE', 'update', ?)",
        ctx.orgId,
        JSON.stringify({ credential_ref: 'PRIVATE' }),
      ),
    ]);
    const own = await store.get(ctx, 'own-read');
    expect(own).toMatchObject({ id: 'own-read', orgId: ctx.orgId });
    expect(await store.get(ctx, 'foreign-read')).toBeNull();
    expect(await store.get(ctx, 'absent')).toBeNull();
    expect(await store.list(ctx, { after: null, limit: 10 })).toEqual([own]);
    expect(JSON.stringify(own)).not.toContain('PRIVATE');
    expect(Object.keys(own!)).toEqual([
      'id',
      'orgId',
      'state',
      'planHash',
      'approvedAt',
      'approvedByUserId',
      'acceptedAt',
      'beforeImageExpiresAt',
    ]);
  });
  it('uses descending id keysets without offsets or cross-organization rows', async () => {
    await executor.batch([
      ...['a', 'c', 'e'].map((id) =>
        stmt(
          'INSERT INTO import_run (id, org_id, source_system) VALUES (?, ?, ?)',
          id,
          ctx.orgId,
          'test',
        ),
      ),
      stmt(
        "INSERT INTO import_run (id, org_id, source_system) VALUES ('d', ?, 'test')",
        foreign.orgId,
      ),
    ]);
    expect((await store.list(ctx, { after: null, limit: 2 })).map((run) => run.id)).toEqual([
      'e',
      'c',
    ]);
    await executor.batch([
      stmt("INSERT INTO import_run (id, org_id, source_system) VALUES ('f', ?, 'test')", ctx.orgId),
    ]);
    expect((await store.list(ctx, { after: 'c', limit: 2 })).map((run) => run.id)).toEqual(['a']);
    expect(await store.list(ctx, { after: 'a', limit: 2 })).toEqual([]);
  });
});
