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
import type {
  BlobLifecycle,
  BlobMetadataPort,
  ByteStore,
  PurgeGeneration,
  Sha256,
} from '@package-broker/core/platform/blob';
import { createBlobRepository } from '../repositories/blob.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import {
  describeBlobContract,
  describeBlobLifecycleContract,
  requireBlobFixtureHooks,
  requireBlobLifecycleFixtureHooks,
  type BlobContractFixture,
  type BlobLifecycleFixture,
} from './blob-contract.js';

const FORMAT = '%Y-%m-%dT%H:%M:%fZ';
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

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sqliteFixture(): Promise<BlobLifecycleFixture> {
  const database = await openMigratedDatabase();
  open.push(database);
  const executor: SqlExecutor = database.executor;
  const repository = createBlobRepository(executor);
  const objects = new Map<string, { data: Uint8Array; mediaType: string }>();
  const state = { staged: 0, failPublish: false, failRead: false, fullBody: false };

  const byteStore: ByteStore = {
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

  const lifecycle: BlobLifecycle = {
    softDelete: (ctx, key, input) => repository.softDelete(ctx, key, input),
    claimPurge: (ctx, key) => repository.claimPurge(ctx, key),
    async recheckAndRemove(ctx, key, generation: PurgeGeneration) {
      if (!(await repository.canStartRemove(ctx, key, generation, 1000))) return false;
      await byteStore.remove(blobStorageKey(ctx.orgId, key));
      return true;
    },
    markDeleted: (ctx, key, generation) => repository.markDeleted(ctx, key, generation),
    cancelPurge: (ctx, key, generation) => repository.cancelPurge(ctx, key, generation),
  };

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
    async expireLease(ctx, key) {
      await exec(
        `UPDATE blob SET purge_lease_until = strftime('${FORMAT}', 'now', '-1 minute') WHERE org_id = ? AND sha256 = ?`,
        ctx.orgId,
        key,
      );
    },
    narrowRefetchable: (ctx, input) => repository.narrowRefetchable(ctx, input),
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

  it.each(['lifecycle', 'expireLease', 'narrowRefetchable', 'generationOf'] as const)(
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
