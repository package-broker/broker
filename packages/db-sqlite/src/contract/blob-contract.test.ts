import { afterAll, describe, expect, it } from 'vitest';
import type { OrgContext, SqlExecutor } from '@package-broker/core/db/port';
import { orgContext } from '@package-broker/core/db/port';
import {
  BlobSizeMismatchError,
  BlobValidationError,
  blobStorageKey,
  createBlobStore,
  createBlobUploadAdmission,
} from '@package-broker/core/platform/blob';
import type { BlobMetadataPort, ByteStore, Sha256 } from '@package-broker/core/platform/blob';
import { createBlobLifecycle } from '@package-broker/core/platform/blob-lifecycle';
import type { Observability } from '@package-broker/core/platform/observability';
import { createBlobRepository } from '../repositories/blob.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import {
  describeBlobContract,
  describeBlobLifecycleContract,
  describeBlobReserveContract,
  executorExpiringLeaseAfterFirstStatement,
  requireBlobFixtureHooks,
  requireBlobLifecycleFixtureHooks,
  type BlobContractFixture,
  type BlobLifecycleFixture,
  type BlobReserveFixture,
} from './blob-contract.js';

const FORMAT = '%Y-%m-%dT%H:%M:%fZ';
const DELETE_TIMEOUT_MS = 1000;
const ORG_A = '01J0LIFECYCLE00000000000A';
const ORG_B = '01J0LIFECYCLE00000000000B';
const open: MigratedDatabase[] = [];

afterAll(async () => {
  await Promise.all(open.map((database) => database.close()));
});

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

async function stored(
  f: Pick<BlobContractFixture, 'store'>,
  ctx: OrgContext,
  label: string,
): Promise<Sha256> {
  const data = new TextEncoder().encode(label);
  const key = hex(await crypto.subtle.digest('SHA-256', data)) as Sha256;
  await f.store.put(
    ctx,
    key,
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    }),
    { size: data.length, mediaType: 'application/octet-stream', refetchable: true },
  );
  return key;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const quietObservability: Observability = {
  log() {},
  counter() {},
  histogram() {},
};

type SqliteFixture = BlobLifecycleFixture &
  BlobReserveFixture & { readonly metadataCalls: readonly string[] };

async function sqliteFixture(): Promise<SqliteFixture> {
  const database = await openMigratedDatabase({ d1PatternLimit: true });
  open.push(database);
  const executor: SqlExecutor = database.executor;
  const repository = createBlobRepository(executor);
  const objects = new Map<string, { data: Uint8Array; mediaType: string }>();
  const state = {
    staged: 0,
    failPublish: false,
    failRead: false,
    fullBody: false,
    removes: 0,
    stallRemove: false,
    failRemove: false,
  };
  const metadataCalls: string[] = [];
  let referenceCounter = 0;

  const byteStore: ByteStore = {
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
    async putVerified(storageKey, body, input) {
      state.staged += 1;
      try {
        const data = await drain(body);
        if (data.length !== input.size) throw new BlobSizeMismatchError();
        if (hex(await crypto.subtle.digest('SHA-256', data)) !== input.sha256) {
          throw new BlobValidationError();
        }
        const existing = objects.get(storageKey);
        if (existing === undefined) objects.set(storageKey, { data, mediaType: input.mediaType });
        return { size: input.size, mediaType: existing?.mediaType ?? input.mediaType };
      } finally {
        state.staged -= 1;
      }
    },
    async get(storageKey, range) {
      if (state.failRead) {
        state.failRead = false;
        throw new Error('storage down');
      }
      const found = objects.get(storageKey);
      if (found === undefined) return null;
      const whole = state.fullBody && range !== undefined;
      state.fullBody = false;
      const served = range === undefined || whole ? undefined : range;
      const slice =
        served === undefined
          ? found.data
          : found.data.subarray(served.offset, served.offset + served.length);
      return {
        size: found.data.length,
        mediaType: found.mediaType,
        range: served ?? null,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(slice.slice());
            controller.close();
          },
        }),
      };
    },
    async head(storageKey) {
      if (state.failRead) {
        state.failRead = false;
        throw new Error('storage down');
      }
      const found = objects.get(storageKey);
      return found === undefined ? null : { size: found.data.length, mediaType: found.mediaType };
    },
    async remove(storageKey) {
      state.removes += 1;
      if (state.stallRemove) {
        state.stallRemove = false;
        return new Promise<void>(() => {});
      }
      if (state.failRemove) {
        state.failRemove = false;
        throw new Error('storage down');
      }
      objects.delete(storageKey);
    },
  };

  const metadata: BlobMetadataPort = {
    reserve: (ctx, key) => repository.reserve(ctx, key),
    async publish(ctx, input) {
      if (state.failPublish) {
        state.failPublish = false;
        throw new Error('database down');
      }
      return repository.publish(ctx, input);
    },
    find: (ctx, key) => repository.find(ctx, key),
    narrowRefetchable: (ctx, input) => repository.narrowRefetchable(ctx, input),
    inspect: (ctx, key) => repository.inspect(ctx, key),
  };

  const lifecycle = createBlobLifecycle({
    metadata: new Proxy(repository, {
      get(target, property, receiver) {
        const member: unknown = Reflect.get(target, property, receiver);
        if (typeof member !== 'function') return member;
        return (...args: unknown[]) => {
          metadataCalls.push(String(property));
          return member.apply(target, args);
        };
      },
    }),
    store: byteStore,
    deleteTimeoutMs: DELETE_TIMEOUT_MS,
    leaseMs: 900_000,
    observability: quietObservability,
  });

  const exec = async (sql: string, ...params: (string | number)[]): Promise<void> => {
    await executor.batch([{ sql, params }]);
  };
  const seeded = new Set<string>();

  return {
    store: createBlobStore(byteStore, metadata, {
      admission: createBlobUploadAdmission(),
      idleTimeoutMs: 2_000,
    }),
    lifecycle,
    inspect: (ctx, key) => metadata.inspect(ctx, key),
    metadataCalls,
    stagesUploads: true,
    async seed(org) {
      if (!seeded.has(org)) {
        await exec('DROP INDEX IF EXISTS organization_singleton');
        await exec(
          'INSERT INTO organization (id, slug, name) VALUES (?, ?, ?)',
          org,
          `org-${org.toLowerCase()}`,
          `Organization ${org}`,
        );
        seeded.add(org);
      }
      return orgContext(org);
    },
    async now() {
      const rows = await executor.all<{ now: string }>({
        sql: `SELECT strftime('${FORMAT}', 'now') AS now`,
        params: [],
      });
      return rows[0]!.now;
    },
    softDelete: (ctx, key, input) => repository.softDelete(ctx, key, input),
    async expireRetention(ctx, key) {
      await exec(
        `UPDATE blob SET purge_after = strftime('${FORMAT}', 'now', '-1 minute') WHERE org_id = ? AND sha256 = ?`,
        ctx.orgId,
        key,
      );
    },
    async makeEligible(ctx, key) {
      await exec(
        `UPDATE blob SET published_at = strftime('${FORMAT}', 'now', '-8 days'), created_at = strftime('${FORMAT}', 'now', '-8 days'), refetchable = 1 WHERE org_id = ? AND sha256 = ?`,
        ctx.orgId,
        key,
      );
    },
    async ageBlob(ctx, key, days) {
      await exec(
        `UPDATE blob SET published_at = strftime('${FORMAT}', 'now', ?), created_at = strftime('${FORMAT}', 'now', ?) WHERE org_id = ? AND sha256 = ?`,
        `-${days} days`,
        `-${days} days`,
        ctx.orgId,
        key,
      );
    },
    async addReference(ctx, key, status) {
      referenceCounter += 1;
      const id = `REF${String(referenceCounter).padStart(6, '0')}`;
      const blobs = await executor.all<{ id: string }>({
        sql: 'SELECT id FROM blob WHERE org_id = ? AND sha256 = ?',
        params: [ctx.orgId, key],
      });
      if (blobs[0] === undefined) throw new Error('no blob to reference');
      await executor.batch([
        {
          sql: "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, ?, ?, 'npm', 'npmjs_proxy')",
          params: [id, ctx.orgId, id],
        },
        {
          sql: "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES (?, ?, ?, 'npm', ?)",
          params: [id, ctx.orgId, id, id.toLowerCase()],
        },
        {
          sql: `INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json, blob_id, status, removed_upstream_at, tombstoned_at)
VALUES (?, ?, ?, '1.0.0', '00001', strftime('${FORMAT}', 'now'), 'upstream', '{}', ?, ?, CASE WHEN ? = 'removed_upstream' THEN '2000-01-01T00:00:00.000Z' END, CASE WHEN ? = 'tombstoned' THEN '2000-01-01T00:00:00.000Z' END)`,
          params: [id, ctx.orgId, id, blobs[0].id, status, status, status],
        },
      ]);
    },
    async setVersionStatus(ctx, key, status) {
      await exec(
        `UPDATE version SET status = ?,
  removed_upstream_at = CASE WHEN ? = 'removed_upstream' THEN COALESCE(removed_upstream_at, '2000-01-01T00:00:00.000Z') END,
  tombstoned_at = CASE WHEN ? = 'tombstoned' THEN COALESCE(tombstoned_at, '2000-01-01T00:00:00.000Z') END
WHERE org_id = ? AND blob_id IN (SELECT id FROM blob WHERE org_id = ? AND sha256 = ?)`,
        status,
        status,
        status,
        ctx.orgId,
        ctx.orgId,
        key,
      );
    },
    leaseMarginMs: () => 2 * DELETE_TIMEOUT_MS,
    async shortenLease(ctx, key, remainingMs) {
      await exec(
        `UPDATE blob SET purge_lease_until = strftime('${FORMAT}', 'now', ?) WHERE org_id = ? AND sha256 = ? AND purge_lease_until IS NOT NULL`,
        `+${remainingMs / 1000} seconds`,
        ctx.orgId,
        key,
      );
    },
    removeCalls: () => state.removes,
    stallNextRemove() {
      state.stallRemove = true;
    },
    failNextRemove() {
      state.failRemove = true;
    },
    async expireLease(ctx, key) {
      await exec(
        `UPDATE blob SET purge_lease_until = strftime('${FORMAT}', 'now', '-1 minute') WHERE org_id = ? AND sha256 = ?`,
        ctx.orgId,
        key,
      );
    },
    narrowRefetchable: (ctx, input) => repository.narrowRefetchable(ctx, input),
    reserve: (ctx, key) => repository.reserve(ctx, key),
    claimPurge: (ctx, key) => repository.claimPurge(ctx, key),
    reserveWithLeaseExpiringBetweenStatements: (ctx, key) =>
      createBlobRepository(executorExpiringLeaseAfterFirstStatement(executor, ctx, key)).reserve(
        ctx,
        key,
      ),
    async generationOf(ctx, key) {
      const rows = await executor.all<{ purge_generation: string | null }>({
        sql: 'SELECT purge_generation FROM blob WHERE org_id = ? AND sha256 = ?',
        params: [ctx.orgId, key],
      });
      return rows[0]?.purge_generation ?? null;
    },
    async refetchableOf(ctx, key) {
      const rows = await executor.all<{ refetchable: number }>({
        sql: 'SELECT refetchable FROM blob WHERE org_id = ? AND sha256 = ?',
        params: [ctx.orgId, key],
      });
      return rows[0] === undefined ? null : rows[0].refetchable === 1;
    },
    failNextPublish() {
      state.failPublish = true;
    },
    failNextStorageRead() {
      state.failRead = true;
    },
    async corruptBytes(ctx: OrgContext, sha256: Sha256) {
      const storageKey = blobStorageKey(ctx.orgId, sha256);
      const found = objects.get(storageKey);
      if (found !== undefined) objects.set(storageKey, { ...found, data: found.data.slice(1) });
    },
    async removeBytes(ctx, key) {
      objects.delete(blobStorageKey(ctx.orgId, key));
    },
    async stagedObjects() {
      return state.staged;
    },
    answerNextRangeWithFullBody() {
      state.fullBody = true;
    },
  };
}

describeBlobContract('sqlite repository with in-memory bytes', sqliteFixture);
describeBlobLifecycleContract('sqlite repository with in-memory bytes', sqliteFixture);
describeBlobReserveContract('sqlite repository with in-memory bytes', sqliteFixture);

const MAIN_HOOKS = [
  'store',
  'seed',
  'now',
  'softDelete',
  'expireRetention',
  'refetchableOf',
  'failNextPublish',
  'failNextStorageRead',
  'corruptBytes',
  'removeBytes',
  'stagedObjects',
  'stagesUploads',
  'answerNextRangeWithFullBody',
] as const;

describe('blob contract harness', () => {
  it('accepts a complete fixture', async () => {
    const fixture = await sqliteFixture();
    expect(() => requireBlobFixtureHooks(fixture)).not.toThrow();
    expect(() => requireBlobLifecycleFixtureHooks(fixture)).not.toThrow();
  });

  it.each(MAIN_HOOKS)('fails rather than skips when the %s hook is missing', async (hook) => {
    const fixture: Record<string, unknown> = { ...(await sqliteFixture()) };
    delete fixture[hook];
    expect(() => requireBlobFixtureHooks(fixture as unknown as BlobContractFixture)).toThrow(hook);
  });

  it('does not require the lifecycle hooks in the main suite', async () => {
    const fixture: Record<string, unknown> = { ...(await sqliteFixture()) };
    delete fixture.lifecycle;
    delete fixture.expireLease;
    expect(() => requireBlobFixtureHooks(fixture as unknown as BlobContractFixture)).not.toThrow();
  });

  it.each(['lifecycle', 'expireLease', 'narrowRefetchable', 'generationOf', 'ageBlob'] as const)(
    'fails the lifecycle suite when the %s hook is missing',
    async (hook) => {
      const fixture: Record<string, unknown> = { ...(await sqliteFixture()) };
      delete fixture[hook];
      expect(() =>
        requireBlobLifecycleFixtureHooks(fixture as unknown as BlobLifecycleFixture),
      ).toThrow(hook);
    },
  );

  it.each(['put', 'get', 'head'] as const)('fails when the store lacks %s', async (method) => {
    const fixture = await sqliteFixture();
    const broken = { ...fixture.store } as Record<string, unknown>;
    delete broken[method];
    expect(() =>
      requireBlobFixtureHooks({
        ...fixture,
        store: broken as unknown as BlobContractFixture['store'],
      }),
    ).toThrow(method);
  });
});

const LIFECYCLE_HOOKS = [
  'makeEligible',
  'addReference',
  'setVersionStatus',
  'removeCalls',
  'stallNextRemove',
  'failNextRemove',
] as const;

describe('blob lifecycle fixture hooks', () => {
  it.each(LIFECYCLE_HOOKS)(
    'fails the lifecycle suite when the %s hook is missing',
    async (hook) => {
      const fixture: Record<string, unknown> = { ...(await sqliteFixture()) };
      delete fixture[hook];
      expect(() =>
        requireBlobLifecycleFixtureHooks(fixture as unknown as BlobLifecycleFixture),
      ).toThrow(hook);
    },
  );

  it('names only the absent hook', async () => {
    const fixture: Record<string, unknown> = { ...(await sqliteFixture()) };
    delete fixture.removeCalls;
    let message = '';
    try {
      requireBlobLifecycleFixtureHooks(fixture as unknown as BlobLifecycleFixture);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('removeCalls');
    expect(message).not.toContain('makeEligible');
  });

  it('reaches the metadata port through the lifecycle object', async () => {
    const f = await sqliteFixture();
    const org = await f.seed(ORG_A);
    const key = await stored(f, org, 'spied');
    await f.lifecycle.softDelete(org, key, { removedAt: await f.now() });
    await f.lifecycle.claimPurge(org, key);
    expect(f.metadataCalls).toEqual(['softDelete', 'claimPurge']);
  });

  it('turns an unreferenced scheduled blob claimable and is needed for that', async () => {
    const f = await sqliteFixture();
    const org = await f.seed(ORG_A);
    const key = await stored(f, org, 'orphan inside the grace period');
    await f.lifecycle.softDelete(org, key, { removedAt: await f.now() });
    await f.expireRetention(org, key);
    expect(await f.lifecycle.claimPurge(org, key)).toBeNull();
    await f.makeEligible(org, key);
    expect(await f.lifecycle.claimPurge(org, key)).not.toBeNull();
  });

  it('ageBlob ages only the context organization without widening refetchability', async () => {
    const f = await sqliteFixture();
    const a = await f.seed(ORG_A);
    const b = await f.seed(ORG_B);
    const key = await stored(f, a, 'controlled age in two organizations');
    await stored(f, b, 'controlled age in two organizations');
    const local = await stored(f, a, 'non-refetchable controlled age');
    await f.narrowRefetchable(a, {
      key: local,
      size: new TextEncoder().encode('non-refetchable controlled age').length,
      mediaType: 'application/octet-stream',
    });
    await f.ageBlob(a, key, 8);
    await f.ageBlob(a, local, 8);
    expect(await f.refetchableOf(a, local)).toBe(false);
    for (const ctx of [a, b]) {
      await f.lifecycle.softDelete(ctx, key, { removedAt: await f.now() });
      await f.expireRetention(ctx, key);
    }
    expect(await f.lifecycle.claimPurge(a, key)).not.toBeNull();
    expect(await f.lifecycle.claimPurge(b, key)).toBeNull();
  });

  async function referenced(
    f: SqliteFixture,
    org: OrgContext,
    label: string,
    status: 'active' | 'removed_upstream',
  ): Promise<Sha256> {
    const key = await stored(f, org, label);
    await f.addReference(org, key, status);
    await f.makeEligible(org, key);
    await f.lifecycle.softDelete(org, key, { removedAt: await f.now() });
    await f.expireRetention(org, key);
    return key;
  }

  it('an active reference makes the blob unclaimable', async () => {
    const f = await sqliteFixture();
    const org = await f.seed(ORG_A);
    const key = await referenced(f, org, 'actively referenced', 'active');
    expect(await f.lifecycle.claimPurge(org, key)).toBeNull();
  });

  it('a removed_upstream reference leaves the blob claimable', async () => {
    const f = await sqliteFixture();
    const org = await f.seed(ORG_A);
    const key = await referenced(f, org, 'released reference', 'removed_upstream');
    expect(await f.lifecycle.claimPurge(org, key)).not.toBeNull();
  });

  it('addReference scopes the reference to the context organization', async () => {
    const f = await sqliteFixture();
    const a = await f.seed(ORG_A);
    const b = await f.seed(ORG_B);
    const key = await stored(f, a, 'same bytes in two organizations');
    await stored(f, b, 'same bytes in two organizations');
    await f.addReference(b, key, 'active');
    await f.makeEligible(a, key);
    await f.lifecycle.softDelete(a, key, { removedAt: await f.now() });
    await f.expireRetention(a, key);
    expect(await f.lifecycle.claimPurge(a, key)).not.toBeNull();
  });

  it('setVersionStatus moves the blob between claimable and unclaimable', async () => {
    const f = await sqliteFixture();
    const org = await f.seed(ORG_A);
    const key = await referenced(f, org, 'status flips', 'active');
    expect(await f.lifecycle.claimPurge(org, key)).toBeNull();
    await f.setVersionStatus(org, key, 'tombstoned');
    expect(await f.lifecycle.claimPurge(org, key)).not.toBeNull();
  });

  it('setVersionStatus in another organization changes nothing', async () => {
    const f = await sqliteFixture();
    const a = await f.seed(ORG_A);
    const b = await f.seed(ORG_B);
    const key = await referenced(f, a, 'status in a foreign organization', 'active');
    await stored(f, b, 'status in a foreign organization');
    await f.setVersionStatus(b, key, 'removed_upstream');
    expect(await f.lifecycle.claimPurge(a, key)).toBeNull();
  });

  async function claimed(f: SqliteFixture, label: string) {
    const org = await f.seed(ORG_A);
    const key = await stored(f, org, label);
    await f.makeEligible(org, key);
    await f.lifecycle.softDelete(org, key, { removedAt: await f.now() });
    await f.expireRetention(org, key);
    const generation = await f.lifecycle.claimPurge(org, key);
    expect(generation).not.toBeNull();
    return { org, key, generation: generation! };
  }

  it('counts every remove call', async () => {
    const f = await sqliteFixture();
    expect(f.removeCalls()).toBe(0);
    const { org, key, generation } = await claimed(f, 'counted');
    expect(await f.lifecycle.recheckAndRemove(org, key, generation)).toBe(true);
    expect(f.removeCalls()).toBe(1);
  });

  it('failNextRemove fails exactly the next remove', async () => {
    const f = await sqliteFixture();
    const { org, key, generation } = await claimed(f, 'fails once');
    f.failNextRemove();
    expect(await f.lifecycle.recheckAndRemove(org, key, generation)).toBe(false);
    expect(f.removeCalls()).toBe(1);
    expect(await f.lifecycle.recheckAndRemove(org, key, generation)).toBe(true);
    expect(f.removeCalls()).toBe(2);
  });

  it('stallNextRemove stalls exactly the next remove', async () => {
    const f = await sqliteFixture();
    const { org, key, generation } = await claimed(f, 'stalls once');
    f.stallNextRemove();
    const started = Date.now();
    expect(await f.lifecycle.recheckAndRemove(org, key, generation)).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(f.removeCalls()).toBe(1);
    expect(await f.lifecycle.recheckAndRemove(org, key, generation)).toBe(true);
    expect(f.removeCalls()).toBe(2);
  });

  it('a stalled remove leaves the bytes in place', async () => {
    const f = await sqliteFixture();
    const { org, key, generation } = await claimed(f, 'stalled keeps bytes');
    f.stallNextRemove();
    await f.lifecycle.recheckAndRemove(org, key, generation);
    await f.lifecycle.cancelPurge(org, key, generation);
    expect(await f.store.head(org, key)).not.toBeNull();
  });
});
