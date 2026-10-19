import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mutationFence,
  tokenMutationFence,
  type AuthenticatedActor,
  type AuthenticatedTokenActor,
  type MutationFence,
} from '@package-broker/core/authz/fence';
import type {
  ImportRunCreateWrite,
  ImportRunStore,
  ImportRunWrite,
} from '@package-broker/core/import/run-service';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import type { BlobStore } from '@package-broker/core/platform/blob';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { blobEligibleCondition } from './blob-references.js';
import { createImportRunStore } from './import-run.js';
import { createBlobRepository } from './blob.js';

const anchors = [
  {
    provider: 'oidc',
    anchor: 'oidc:https://idp.example.test',
    emailAuthoritative: true,
    emailAuthoritativeDomains: ['example.test'],
  },
];

const sha = 'a'.repeat(64);
const stmt = (sql: string, ...params: Statement['params']): Statement => ({ sql, params });

describe.each([false, true])('import runs (D1 limits %s)', (d1PatternLimit) => {
  let database: MigratedDatabase;
  let executor: SqlExecutor;
  let ctx: OrgContext;
  let foreign: OrgContext;
  let store: ImportRunStore;
  let fence: MutationFence;
  let now: string;
  let input: ImportRunCreateWrite;
  let statements: Statement[];
  let beforeBatch: (() => Promise<void>) | undefined;
  let publish: boolean;
  let uploads: number;
  const blobStore: BlobStore = {
    async put(_ctx, key, body, info) {
      uploads += 1;
      await new Response(body).arrayBuffer();
      expect(info.refetchable).toBe(false);
      if (publish) {
        const metadata = createBlobRepository(executor);
        const generation = await metadata.reserve(_ctx, key);
        const published = await metadata.publish(_ctx, { ...info, sha256: key, generation });
        if (published === null) throw new Error('blob publication refused');
        return published;
      }
      return {
        generation: '',
        sha256: key,
        size: info.size,
        mediaType: info.mediaType,
        purgeAfter: null,
      };
    },
    async get() {
      return null;
    },
    async head() {
      return null;
    },
  };

  beforeEach(async () => {
    database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit });
    executor = database.executor;
    if (database.orgs === null) throw new Error('missing fixture');
    ({ a: ctx, b: foreign } = database.orgs);
    now = new Date().toISOString();
    statements = [];
    beforeBatch = undefined;
    uploads = 0;
    publish = true;
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
    const recording: SqlExecutor = {
      driver: executor.driver,
      async all<R>(statement: Statement) {
        statements.push(statement);
        return executor.all<R>(statement);
      },
      async batch(batch) {
        statements.push(...batch);
        const hook = beforeBatch;
        beforeBatch = undefined;
        await hook?.();
        return executor.batch(batch);
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
      planHash: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
      plannedCount: 0,
      now,
      audit: stmt('SELECT 1'),
    };
  });
  afterEach(async () => {
    await database.close();
  });
  async function create() {
    expect(await store.createRun(ctx, fence, input)).toMatchObject({ ok: true });
  }
  async function write(): Promise<ImportRunWrite> {
    const { run } = await store.inspect(ctx, fence, 'approveRun', input.id, now);
    if (run === null) throw new Error('missing run');
    return {
      runId: input.id,
      expected: run,
      now,
      audit: stmt('SELECT 1'),
      approvedByUserId: 'actor',
      approvedAt: now,
      credentialWindowUntil: new Date(Date.parse(now) + 3600000).toISOString(),
    };
  }
  it('creates a manifest and exactly one session starter, then records approval', async () => {
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
        manifest_blob_sha256: input.planHash,
        plan_hash: input.planHash,
      },
    ]);
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
  it('rolls back when the actor is suspended immediately before the batch', async () => {
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
  it('never selects a 30-day-old orphan manifest for purge, with an ordinary orphan control', async () => {
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
  it('refuses a refetchable manifest row without creating a run', async () => {
    await executor.batch([
      stmt(
        "INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key, media_type, refetchable) VALUES ('manifest', ?, ?, 2, 'manifest', 'application/json', 1)",
        ctx.orgId,
        input.planHash,
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
  it('ignores a refetchable blob in another organization when creating a run', async () => {
    await executor.batch([
      stmt(
        "INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key, refetchable) VALUES ('foreign-manifest', ?, ?, 2, 'foreign-manifest', 1)",
        foreign.orgId,
        input.planHash,
      ),
    ]);
    await create();
    expect(
      await executor.all(stmt('SELECT refetchable FROM blob WHERE org_id = ?', foreign.orgId)),
    ).toEqual([{ refetchable: 1 }]);
  });
  it('refuses a manifest that becomes refetchable immediately before the fenced batch', async () => {
    beforeBatch = async () => {
      await executor.batch([stmt('UPDATE blob SET refetchable = 1 WHERE org_id = ?', ctx.orgId)]);
    };
    expect(await store.createRun(ctx, fence, input)).toMatchObject({
      ok: false,
      reason: 'conflict',
    });
    expect(await executor.all(stmt('SELECT id FROM import_run'))).toEqual([]);
  });
  it('refuses a missing manifest row without creating a run', async () => {
    publish = false;
    expect(await store.createRun(ctx, fence, input)).toMatchObject({ ok: false });
    expect(await executor.all(stmt('SELECT id FROM import_run'))).toEqual([]);
  });
  it('refuses a forged fence with both starters', async () => {
    await expect(
      store.createRun(
        ctx,
        { userId: 'actor', sessionId: 'session', principalId: 'sp' } as unknown as MutationFence,
        input,
      ),
    ).rejects.toThrow(TypeError);
  });
  it('refuses a forged fence with neither starter', async () => {
    await expect(store.createRun(ctx, {} as MutationFence, input)).rejects.toThrow(TypeError);
  });
  it('returns the same inspection for a foreign run and an absent run', async () => {
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
  const noBeforeImageOrStar = (recorded: readonly Statement[]) => {
    expect(recorded.length).toBeGreaterThan(0);
    for (const item of recorded) {
      expect(item.sql).not.toMatch(/before_image_json|select\s+(distinct\s+)?\*|\.\*/i);
      expect(item.params.length).toBeLessThanOrEqual(100);
    }
  };
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
  async function seedServiceToken() {
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
    return tokenMutationFence(
      {
        tokenId: 'svc-token',
        tokenKind: 'svc',
        principalId: 'principal',
      } as AuthenticatedTokenActor,
      'org:import:write',
      {},
    );
  }
  const starters = () =>
    executor.all(
      stmt('SELECT started_by_user_id, started_by_service_principal_id FROM import_run'),
    );
  it('derives the user starter alone from a PAT fence', async () => {
    const patFence = await seedPatToken();
    expect(await store.createRun(ctx, patFence, input)).toMatchObject({ ok: true });
    expect(await starters()).toEqual([
      { started_by_user_id: 'actor', started_by_service_principal_id: null },
    ]);
  });
  it('derives the service principal starter alone from a service token fence', async () => {
    const serviceFence = await seedServiceToken();
    expect(await store.createRun(ctx, serviceFence, input)).toMatchObject({ ok: true });
    expect(await starters()).toEqual([
      { started_by_user_id: null, started_by_service_principal_id: 'principal' },
    ]);
  });
  it('token creation statements never read before images or use select-star', async () => {
    const patFence = await seedPatToken();
    const serviceFence = await seedServiceToken();
    statements.length = 0;
    expect(await store.createRun(ctx, patFence, input)).toMatchObject({ ok: true });
    expect(await store.createRun(ctx, serviceFence, { ...input, id: 'run-svc' })).toMatchObject({
      ok: true,
    });
    noBeforeImageOrStar(statements);
  });
  it('lifecycle failure probes never read before images or use select-star', async () => {
    await create();
    const approval = await write();
    statements.length = 0;
    beforeBatch = async () => {
      await executor.batch([
        stmt("UPDATE user_account SET status = 'suspended' WHERE id = 'actor'"),
      ]);
    };
    expect(await store.approveRun(ctx, fence, approval)).toMatchObject({ ok: false });
    const probes = statements.filter((s) => /^\s*select/i.test(s.sql));
    expect(probes.length).toBeGreaterThan(1);
    noBeforeImageOrStar(statements);
  });
  it('conflict probes of every transition never read before images or use select-star', async () => {
    await create();
    const stale = await write();
    await executor.batch([stmt("UPDATE import_run SET state = 'cancelled'")]);
    statements.length = 0;
    for (const operation of [
      'approveRun',
      'requestApply',
      'cancelRun',
      'acceptRun',
      'requestRollback',
    ] as const)
      expect(await store[operation](ctx, fence, stale)).toMatchObject({ ok: false });
    noBeforeImageOrStar(statements);
  });
  it('all repository reads avoid before images and select-star', async () => {
    await create();
    for (const operation of [
      'createRun',
      'approveRun',
      'requestApply',
      'cancelRun',
      'acceptRun',
      'requestRollback',
    ] as const)
      await store.inspect(ctx, fence, operation, 'run', now);
    const reads = statements.filter((s) => /^\s*select/i.test(s.sql));
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      expect(read.sql).not.toMatch(/before_image_json|select\s+\*/i);
      expect(read.params.length).toBeLessThanOrEqual(100);
    }
  });
});
