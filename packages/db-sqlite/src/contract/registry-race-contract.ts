import { describe, expect, it } from 'vitest';
import { completeVersionListing } from '@package-broker/core/catalogue/version-rules';
import { mutationFence, type AuthenticatedActor } from '@package-broker/core/authz/fence';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import type { IngestSessionHandle } from '@package-broker/core/ingest/session';
import type { Sha256 } from '@package-broker/core/platform/blob';
import {
  createIngestSessions,
  createIngestSessionWriteGuard,
} from '../repositories/ingest-session.js';
import { packageUpsertStatements } from '../repositories/catalogue-write-package.js';
import { createWebhookDeliveryRepository } from '../repositories/webhook-delivery.js';
import { createJobRepository } from '../repositories/job.js';
import { createSourceRepository } from '../repositories/source.js';
import { replaceBlobStatements } from '../repositories/catalogue-reblob.js';
import { distAttachStatements } from '../repositories/catalogue-write-dist.js';
import { createBlobRepository } from '../repositories/blob.js';
import { createCatalogueReconciler } from '../repositories/catalogue-reconcile.js';
import { seedTwoOrganizations } from './two-organizations.js';

export interface RaceBarrier {
  readonly reached: Promise<void>;
  wait(): Promise<void>;
  release(): void;
}

/** Both executors address the same migrated, empty database. Each barrier is fresh and one-shot. */
export interface RaceExecutorPair {
  readonly a: SqlExecutor;
  readonly b: SqlExecutor;
  barrier(): RaceBarrier;
}

export interface RegistryRaceFixture extends RaceExecutorPair {
  close(): Promise<void>;
}
export type RegistryRaceFactory = () => Promise<RegistryRaceFixture>;
export type RegistryRaceOrder = 'a-first' | 'b-first' | 'reads-first';
type Wrap = (executor: SqlExecutor) => SqlExecutor;
const st = (sql: string, ...params: Statement['params']): Statement => ({ sql, params });
const OLD = '2000-01-01T00:00:00.000Z';
const SHA = 'a'.repeat(64) as Sha256;
const NEW_SHA = 'b'.repeat(64) as Sha256;
const scope = { scope: 'package', sourceId: 'source', packageKey: 'widget' } as const;
const job = { id: 'job', owner: 'worker', fence: 1 };

interface World extends RaceExecutorPair {
  readonly org: OrgContext;
  executor(side: 'a' | 'b', gate: Wrap): SqlExecutor;
  rows(sql: string, ...params: Statement['params']): Promise<Record<string, unknown>[]>;
  seed(sql: string, ...params: Statement['params']): Promise<unknown>;
}

function acquired(handle: IngestSessionHandle | 'held'): IngestSessionHandle {
  expect(handle).not.toBe('held');
  if (handle === 'held') throw new Error('registry race fixture unexpectedly held');
  return handle;
}

function gated(executor: SqlExecutor, gate: RaceBarrier, phase: 'call' | 'write'): SqlExecutor {
  let used = false;
  async function wait() {
    if (!used) {
      used = true;
      await gate.wait();
    }
  }
  return {
    ...executor,
    async all(statement) {
      if (phase === 'call') await wait();
      return executor.all(statement);
    },
    async batch(statements) {
      await wait();
      return executor.batch(statements);
    },
  };
}

function settled<T>(pending: Promise<T>) {
  return pending.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

async function reached(gate: RaceBarrier, pending: Promise<unknown>): Promise<void> {
  const early = await Promise.race([gate.reached.then(() => false), pending.then(() => true)]);
  if (early) throw new Error('registry race operation did not reach its barrier');
}

async function race<A, B>(
  w: World,
  order: RegistryRaceOrder,
  a: (e: SqlExecutor) => Promise<A>,
  b: (e: SqlExecutor) => Promise<B>,
): Promise<{ a: A; b: B }> {
  if (order === 'reads-first') {
    const gateA = w.barrier();
    const gateB = w.barrier();
    const pendingA = settled(a(w.executor('a', (e) => gated(e, gateA, 'write'))));
    let pendingB: ReturnType<typeof settled<B>> | undefined;
    try {
      await reached(gateA, pendingA);
      pendingB = settled(b(w.executor('b', (e) => gated(e, gateB, 'write'))));
      await reached(gateB, pendingB);
      gateA.release();
      const resultA = await pendingA;
      if ('error' in resultA) throw resultA.error;
      gateB.release();
      const resultB = await pendingB;
      if ('error' in resultB) throw resultB.error;
      return { a: resultA.value, b: resultB.value };
    } finally {
      gateA.release();
      gateB.release();
      await pendingA;
      await pendingB;
    }
  }
  const gate = w.barrier();
  const held = w.executor(order === 'a-first' ? 'b' : 'a', (e) => gated(e, gate, 'call'));
  const pending = settled<A | B>(order === 'a-first' ? b(held) : a(held));
  try {
    await reached(gate, pending);
    const first = await (order === 'a-first' ? a(w.a) : b(w.b));
    gate.release();
    const second = await pending;
    if ('error' in second) throw second.error;
    return (
      order === 'a-first' ? { a: first, b: second.value } : { a: second.value, b: first }
    ) as { a: A; b: B };
  } finally {
    gate.release();
    await pending;
  }
}

const upsert = (w: World, handle: IngestSessionHandle, description: string, withJob = false) =>
  packageUpsertStatements(
    w.org,
    createIngestSessionWriteGuard(w.org, handle, withJob ? job : undefined),
    {
      sourceId: 'source',
      ecosystem: 'npm',
      key: 'widget',
      description,
    },
  ).statements;
const snapshot = async (w: World) => {
  const rows = [];
  for (const table of ['source', 'package', 'version', 'version_revision', 'blob', 'cache_epoch'])
    rows.push(await w.rows(`SELECT * FROM ${table} WHERE org_id = ? ORDER BY 1`));
  return rows;
};

type Case = (w: World, order: RegistryRaceOrder) => Promise<void>;
const cases = {
  async twoFillers(w, order) {
    const result = await race(
      w,
      order,
      (e) => createIngestSessions(e).acquire(w.org, scope, 'request-a', 60),
      (e) => createIngestSessions(e).acquire(w.org, scope, 'request-b', 60),
    );
    const winner = acquired(order === 'b-first' ? result.b : result.a);
    expect(order === 'b-first' ? result.a : result.b).toBe('held');
    await w.a.batch(upsert(w, winner, 'winner'));
    expect(await w.rows('SELECT description FROM package WHERE org_id = ?')).toEqual([
      { description: 'winner' },
    ]);
    expect(
      await w.rows("SELECT owner FROM ingest_session WHERE org_id = ? AND state = 'running'"),
    ).toEqual([{ owner: winner.owner }]);
  },
  async expiredFiller(w, order) {
    const sessions = createIngestSessions(w.a);
    const old = acquired(await sessions.acquire(w.org, scope, 'stale', 60));
    expect(await sessions.start(w.org, old, { snapshot: { id: 'snapshot' }, stamp: OLD })).toBe(
      true,
    );
    expect(await sessions.advance(w.org, old, { cursor: 'page-2', addSeen: 1 })).not.toBeNull();
    const batch = upsert(w, old, 'stale');
    const result = await race(
      w,
      order,
      async (e) => {
        if (order === 'b-first') await expect(e.batch(batch)).rejects.toThrow();
        else await e.batch(batch);
      },
      async (e) => {
        await e.batch([
          st(
            'UPDATE ingest_session SET lease_until = ? WHERE org_id = ? AND id = ?',
            OLD,
            w.org.orgId,
            old.id,
          ),
        ]);
        const before = await snapshot(w);
        await expect(e.batch(batch)).rejects.toThrow();
        expect(await snapshot(w)).toEqual(before);
        return acquired(await createIngestSessions(e).acquire(w.org, scope, 'successor', 60));
      },
    );
    expect(result.b).toMatchObject({
      id: old.id,
      generation: old.generation,
      fence: old.fence + 1,
      snapshotId: 'snapshot',
      stamp: OLD,
      cursor: 'page-2',
      seenCount: 1,
    });
    const before = await snapshot(w);
    await expect(w.a.batch(batch)).rejects.toThrow();
    expect(await sessions.advance(w.org, old, { cursor: 'stale', addSeen: 1 })).toBeNull();
    expect(await snapshot(w)).toEqual(before);
    await w.b.batch(upsert(w, result.b, 'resumed'));
    expect(await w.rows('SELECT description FROM package WHERE org_id = ?')).toEqual([
      { description: 'resumed' },
    ]);
  },
  async jobVsFill(w, order) {
    const result = await race(
      w,
      order,
      (e) => createIngestSessions(e).acquire(w.org, scope, 'job-worker', 60),
      (e) => createIngestSessions(e).acquire(w.org, scope, 'request', 60),
    );
    const winner = acquired(order === 'b-first' ? result.b : result.a);
    expect(order === 'b-first' ? result.a : result.b).toBe('held');
    await w.a.batch(upsert(w, winner, 'only-writer', order !== 'b-first'));
    const guarded = upsert(w, winner, 'stale-job', true);
    await w.b.batch([
      st('UPDATE job SET fence = fence + 1 WHERE org_id = ? AND id = ?', w.org.orgId, job.id),
    ]);
    const before = await snapshot(w);
    await expect(w.a.batch(guarded)).rejects.toThrow();
    expect(await snapshot(w)).toEqual(before);
  },
  async duplicateWebhook(w, order) {
    const input = {
      provider: 'github',
      deliveryId: 'credential:body-hash',
      event: 'push' as const,
    };
    const result = await race(
      w,
      order,
      (e) => createWebhookDeliveryRepository(e).record(w.org, input),
      (e) => createWebhookDeliveryRepository(e).record(w.org, input),
    );
    expect(order === 'a-first' ? result.a : result.b).toEqual({ state: 'new' });
    expect(order === 'a-first' ? result.b : result.a).toEqual({
      state: 'duplicate',
      outcome: 'received',
    });
    const enqueue = (e: SqlExecutor, id: string) =>
      createJobRepository(e).enqueue(w.org, {
        id,
        type: 'core:source-sync:v1',
        payloadJson: '{"sourceId":"source","reason":"webhook"}',
        idempotencyKey: 'c'.repeat(64),
        resourceKey: 'source:source',
        runAt: null,
        maxAttempts: 3,
        projectId: null,
        initiatorTokenId: null,
      });
    const first = await enqueue(w.a, 'fanout-a');
    const deliveries = createWebhookDeliveryRepository(w.b);
    expect(await deliveries.record(w.org, input)).toEqual({
      state: 'duplicate',
      outcome: 'received',
    });
    expect(await enqueue(w.b, 'fanout-b')).toEqual({ id: first.id, created: false });
    await deliveries.settle(w.org, { ...input, outcome: 'processed' });
    await createWebhookDeliveryRepository(w.a).settle(w.org, { ...input, outcome: 'ignored' });
    expect(await deliveries.record(w.org, input)).toEqual({
      state: 'duplicate',
      outcome: 'processed',
    });
    expect(await w.rows('SELECT outcome FROM webhook_delivery WHERE org_id = ?')).toEqual([
      { outcome: 'processed' },
    ]);
    expect(
      await w.rows('SELECT id FROM job WHERE org_id = ? AND type = ?', 'core:source-sync:v1'),
    ).toEqual([{ id: first.id }]);
  },
  async sourceDeleteVsSync(w, order) {
    const handle = acquired(await createIngestSessions(w.a).acquire(w.org, scope, 'sync', 60));
    const batch = upsert(w, handle, 'synced');
    const result = await race(
      w,
      order,
      (e) =>
        createSourceRepository(e).delete(
          w.org,
          mutationFence({ userId: 'admin', sessionId: 'session' } as AuthenticatedActor, {}),
          {
            id: 'source',
            providerAnchors: [
              {
                provider: 'oidc',
                anchor: 'oidc:https://idp.example.test',
                emailAuthoritative: true,
                emailAuthoritativeDomains: ['example.test'],
              },
            ],
          },
        ),
      async (e) => {
        if (order === 'a-first') await expect(e.batch(batch)).rejects.toThrow();
        else await e.batch(batch);
      },
    );
    expect(result.a).toBe(order === 'a-first' ? 'deleted' : 'has_packages');
    expect((await w.rows('SELECT id FROM source WHERE org_id = ?')).length).toBe(
      order === 'a-first' ? 0 : 1,
    );
    expect((await w.rows('SELECT id FROM package WHERE org_id = ?')).length).toBe(
      order === 'a-first' ? 0 : 1,
    );
  },
  async reblobVsAttach(w, order) {
    const handle = acquired(await createIngestSessions(w.a).acquire(w.org, scope, 'dist', 60));
    await w.a.batch(upsert(w, handle, 'dist'));
    await seedVersion(w);
    const guard = createIngestSessionWriteGuard(w.org, handle);
    const replace = replaceBlobStatements(w.org, guard, {
      versionId: 'version',
      expectedRevision: 1,
      oldBlobId: 'old',
      newSha256: NEW_SHA,
      reason: 'refetch_changed',
    });
    const attach = distAttachStatements(w.org, guard, {
      versionId: 'version',
      revision: 1,
      sha256: SHA,
    });
    const result = await race(
      w,
      order,
      (e) => e.batch(replace.statements),
      async (e) => {
        if (order === 'a-first') await expect(e.batch(attach.statements)).rejects.toThrow();
        else expect(attach.result(await e.batch(attach.statements)).changed).toBe(false);
      },
    );
    expect(replace.result(result.a).changed).toBe(true);
    expect(await w.rows('SELECT blob_id, revision FROM version WHERE org_id = ?')).toEqual([
      { blob_id: 'new', revision: 2 },
    ]);
    expect(await w.rows('SELECT blob_id, revision FROM version_revision WHERE org_id = ?')).toEqual(
      [{ blob_id: 'old', revision: 1 }],
    );
  },
  async retentionVsReactivation(w, order) {
    const handle = acquired(await createIngestSessions(w.a).acquire(w.org, scope, 'sync', 60));
    await w.a.batch(upsert(w, handle, 'removed'));
    await seedVersion(w);
    await w.seed(
      "UPDATE version SET status = 'removed_upstream', removed_upstream_at = ? WHERE org_id = ?",
      OLD,
      w.org.orgId,
    );
    const guard = createIngestSessionWriteGuard(w.org, handle);
    const listing = {
      kind: 'package',
      packageId: (await w.rows('SELECT id FROM package WHERE org_id = ?'))[0]!['id'] as string,
    } as const;
    const { stamp } = await createCatalogueReconciler(w.a).openListing(w.org, guard, listing);
    await createCatalogueReconciler(w.a).markListing(w.org, guard, {
      scope: listing,
      stamp,
      present: ['1.0.0'],
    });
    const result = await race(
      w,
      order,
      (e) => createBlobRepository(e).softDelete(w.org, SHA, { removedAt: OLD }),
      (e) =>
        createCatalogueReconciler(e).finalizeListing(
          w.org,
          guard,
          completeVersionListing({ packageId: listing.packageId, stamp, count: 1 }),
          { attemptedCandidates: 1, successfulCandidates: 1, definitiveAbsent: 0 },
        ),
    );
    expect(result.a).toBe(true);
    expect(
      await w.rows('SELECT purge_after, deleted_at FROM blob WHERE org_id = ? AND id = ?', 'old'),
    ).toEqual([{ purge_after: expect.any(String), deleted_at: null }]);
    expect(await w.rows('SELECT status FROM version WHERE org_id = ?')).toEqual([
      { status: 'active' },
    ]);
    await w.seed(
      'UPDATE blob SET purge_after = ? WHERE org_id = ? AND id = ?',
      OLD,
      w.org.orgId,
      'old',
    );
    expect(await createBlobRepository(w.a).claimPurge(w.org, SHA)).toBeNull();
    await createBlobRepository(w.b).unschedule(w.org, SHA);
    expect(
      await w.rows('SELECT purge_after, deleted_at FROM blob WHERE org_id = ? AND id = ?', 'old'),
    ).toEqual([{ purge_after: null, deleted_at: null }]);
  },
} satisfies Record<string, Case>;

async function seedVersion(w: World): Promise<void> {
  for (const [id, sha] of [
    ['old', SHA],
    ['new', NEW_SHA],
  ] as const)
    await w.seed(
      'INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key, created_at) VALUES (?, ?, ?, 1, ?, ?)',
      id,
      w.org.orgId,
      sha,
      id,
      OLD,
    );
  await w.seed(
    `INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json, blob_id)
    SELECT 'version', ?, id, '1.0.0', '1.0.0', ?, 'broker', '{}', 'old' FROM package WHERE org_id = ?`,
    w.org.orgId,
    OLD,
    w.org.orgId,
  );
}

export async function runRegistryRaceCase(
  open: RegistryRaceFactory,
  name: string,
  order: RegistryRaceOrder,
  wrap: Wrap = (e) => e,
): Promise<void> {
  const run: Case | undefined = cases[name as keyof typeof cases];
  if (run === undefined) throw new RangeError('unknown registry race');
  const opened = await open();
  try {
    const { a: org } = await seedTwoOrganizations(opened.a);
    const w: World = {
      a: wrap(opened.a),
      b: wrap(opened.b),
      barrier: () => opened.barrier(),
      org,
      executor: (side, gate) => wrap(gate(opened[side])),
      rows: (sql, ...params) => opened.a.all(st(sql, org.orgId, ...params)),
      seed: (sql, ...params) => opened.a.batch([st(sql, ...params)]),
    };
    await opened.a.batch([
      st(
        "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('source', ?, 'registry', 'npm', 'npmjs_proxy')",
        org.orgId,
      ),
      st(
        "INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence) VALUES ('job', ?, 'core:package-sync:v1', 'seed', 'running', 'worker', '2999-01-01T00:00:00.000Z', 1)",
        org.orgId,
      ),
      st(
        "INSERT INTO user_account (id, org_id, email, status) VALUES ('admin', ?, ?, 'active')",
        org.orgId,
        ['admin', 'example.test'].join('@'),
      ),
      st(
        "INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, 'oidc', 'oidc:https://idp.example.test')",
        org.orgId,
      ),
      st(
        "INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES ('identity', ?, 'admin', 'oidc', 'subject', ?, 1, ?)",
        org.orgId,
        ['admin', 'example.test'].join('@'),
        new Date().toISOString(),
      ),
      st(
        "INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, last_seen_at, expires_at) VALUES ('session', ?, 'admin', ?, ?, ?, ?, '2999-01-01T00:00:00.000Z')",
        org.orgId,
        'd'.repeat(64),
        'e'.repeat(64),
        new Date().toISOString(),
        new Date().toISOString(),
      ),
      st(
        "INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES ('role', ?, 'admin', 'Admin', 'organization', 0)",
        org.orgId,
      ),
      st(
        "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'role', 'org:sources:write')",
        org.orgId,
      ),
      st(
        "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id, created_at, updated_at) VALUES ('grant', ?, 'email', ?, 'organization', 'role', ?, ?)",
        org.orgId,
        ['admin', 'example.test'].join('@'),
        OLD,
        OLD,
      ),
    ]);
    await run(w, order);
  } finally {
    await opened.close();
  }
}

export function describeRegistryRaceContract(name: string, open: RegistryRaceFactory): void {
  describe(`registry race contract: ${name}`, () => {
    for (const name of Object.keys(cases))
      for (const order of (name === 'twoFillers' || name === 'jobVsFill'
        ? ['a-first', 'b-first', 'reads-first']
        : ['a-first', 'b-first']) as RegistryRaceOrder[])
        it(`${name} (${order})`, () => runRegistryRaceCase(open, name, order));
  });
}
