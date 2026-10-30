import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { OrgContext } from '@package-broker/core/db/port';
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
import { noopObservability } from '@package-broker/core/platform/observability';
import {
  describeBlobContract,
  describeBlobStagingContract,
  describeBlobLifecycleContract,
  describeBlobReserveContract,
  executorExpiringLeaseAfterFirstStatement,
  type BlobReserveFixture,
  type BlobLifecycleFixture,
} from '@package-broker/db-sqlite/contract/blob-contract';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { loadMigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { createBlobRepository } from '@package-broker/db-sqlite/repositories/blob';
import { createD1Executor, type D1DatabaseLike } from '../db/d1-executor.js';

const read = (relative: string): string =>
  stripTypeScriptTypes(readFileSync(new URL(relative, import.meta.url), 'utf8'));

const adapter = read('./r2.ts').replaceAll("'@package-broker/core/platform/blob'", "'./blob.mjs'");
const core = read('../../../core/src/platform/blob.ts');
if (/^\s*(import|export)\b[^;]*\sfrom\s+'\./m.test(core)) {
  throw new Error('core blob.ts gained a runtime relative import; load it as a module here too');
}

const WORKER = `
import { createR2ByteStore } from './r2.mjs';

function bucketFor(request, env) {
  const real = env[request.headers.get('x-bucket')];
  if (request.headers.get('x-ignore-range') === '1') {
    return {
      put: (...args) => real.put(...args),
      get: (key) => real.get(key),
      head: (key) => real.head(key),
      delete: (key) => real.delete(key),
    };
  }
  return real;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const key = url.searchParams.get('key');
    const store = createR2ByteStore(bucketFor(request, env));
    try {
      if (url.pathname === '/put') {
        const result = await store.putVerified(key, request.body ?? new ReadableStream({ start(c) { c.close(); } }), {
          sha256: request.headers.get('x-sha256'),
          size: Number(request.headers.get('x-size')),
          mediaType: request.headers.get('x-media-type'),
        });
        return Response.json(result);
      }
      if (url.pathname === '/get') {
        const offset = request.headers.get('x-range-offset');
        const range = offset === null
          ? undefined
          : { offset: Number(offset), length: Number(request.headers.get('x-range-length')) };
        const found = await store.get(key, range);
        if (found === null) return new Response(null, { status: 404 });
        return new Response(found.body, {
          headers: {
            'x-size': String(found.size),
            'x-media-type': found.mediaType,
            'x-range': JSON.stringify(found.range),
          },
        });
      }
      if (url.pathname === '/stage') return Response.json(await store.putStaged(key, request.body, Number(request.headers.get('x-cap')), request.headers.get('x-media-type')));
      if (url.pathname === '/open-staged') return new Response(await store.openStaged(key));
      if (url.pathname === '/promote') { await store.promote(key, request.headers.get('x-sha256'), Number(request.headers.get('x-size')), request.headers.get('x-media-type')); return Response.json(null); }
      if (url.pathname === '/discard-staged') { await store.discardStaged(key); return Response.json(null); }
      if (url.pathname === '/list-staged') return Response.json(await store.listStaged(key));
      if (url.pathname === '/head') return Response.json(await store.head(key));
      if (url.pathname === '/remove') {
        await store.remove(key);
        return Response.json(null);
      }
      return new Response(null, { status: 400 });
    } catch (error) {
      return Response.json({ failure: error.name }, { status: 500 });
    }
  },
};
`;

const DELETE_TIMEOUT_MS = 1_000;
const POOL = 96;
const bucketNames = Array.from({ length: POOL }, (_, index) => `BUCKET${index}`);
const databaseNames = Array.from({ length: POOL }, (_, index) => `META${index}`);

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: [
      { type: 'ESModule', path: 'worker.mjs', contents: WORKER },
      { type: 'ESModule', path: 'r2.mjs', contents: adapter },
      { type: 'ESModule', path: 'blob.mjs', contents: core },
    ],
    compatibilityDate: '2026-10-01',
    r2Buckets: bucketNames,
    d1Databases: databaseNames,
  } as unknown as Parameters<typeof convertV4MiniflareOptions>[0]),
);

afterAll(async () => {
  await mf.dispose();
});

const require = createRequire(import.meta.url);
const migrationsDirectory = join(
  dirname(require.resolve('@package-broker/db-sqlite/package.json')),
  'migrations',
);

let nextCase = 0;

interface Faults {
  failRead: boolean;
  fullBody: boolean;
  removes: number;
  stallRemove: boolean;
  failRemove: boolean;
}

async function failure(response: Response): Promise<Error> {
  const { failure: name } = (await response.json()) as { failure: string };
  if (name === 'BlobSizeMismatchError') return new BlobSizeMismatchError();
  if (name === 'BlobValidationError') return new BlobValidationError();
  return new Error(name);
}

type DispatchInit = NonNullable<Parameters<Miniflare['dispatchFetch']>[1]>;

interface BucketAdmin {
  head(key: string): Promise<unknown | null>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; httpMetadata?: unknown } | null>;
  put(key: string, value: Uint8Array, options: { httpMetadata?: unknown }): Promise<unknown>;
  delete(key: string): Promise<void>;
}

function observeFailure(
  source: ReadableStream<Uint8Array>,
  sink: { error?: unknown },
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        sink.error = error;
        controller.error(error);
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

function proxyStore(bucketName: string, faults: Faults): ByteStore {
  const call = (path: string, key: string, init: Record<string, unknown>): Promise<Response> =>
    mf.dispatchFetch(`http://r2.test/${path}?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      ...init,
    } as DispatchInit) as unknown as Promise<Response>;
  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    'x-bucket': bucketName,
    ...extra,
  });
  const takeFailRead = (): void => {
    if (!faults.failRead) return;
    faults.failRead = false;
    throw new Error('storage down');
  };

  return {
    async putStaged(handle, body, maxBytes, mediaType) {
      const response = await call('stage', handle, {
        headers: headers({ 'x-cap': String(maxBytes), 'x-media-type': mediaType }),
        body,
        duplex: 'half',
      });
      if (!response.ok) throw await failure(response);
      return (await response.json()) as Awaited<ReturnType<ByteStore['putStaged']>>;
    },
    async openStaged(handle) {
      const response = await call('open-staged', handle, { headers: headers() });
      if (!response.ok || response.body === null) throw await failure(response);
      return response.body;
    },
    async promote(handle, sha256, size, mediaType) {
      const response = await call('promote', handle, {
        headers: headers({ 'x-sha256': sha256, 'x-size': String(size), 'x-media-type': mediaType }),
      });
      if (!response.ok) throw await failure(response);
    },
    async discardStaged(handle) {
      const response = await call('discard-staged', handle, { headers: headers() });
      if (!response.ok) throw await failure(response);
    },
    async listStaged(olderThan) {
      const response = await call('list-staged', olderThan, { headers: headers() });
      if (!response.ok) throw await failure(response);
      return (await response.json()) as Awaited<ReturnType<ByteStore['listStaged']>>;
    },
    async putVerified(key, body, input) {
      const sourceFailure: { error?: unknown } = {};
      const observed = observeFailure(body, sourceFailure);
      const response = await call('put', key, {
        headers: headers({
          'x-sha256': input.sha256,
          'x-size': String(input.size),
          'x-media-type': input.mediaType,
        }),
        body: observed,
        duplex: 'half',
      }).catch((error: unknown) => {
        throw sourceFailure.error ?? error;
      });
      if (!response.ok) throw await failure(response);
      return (await response.json()) as { size: number; mediaType: string };
    },
    async get(key, range) {
      takeFailRead();
      const ignore = faults.fullBody && range !== undefined;
      faults.fullBody = false;
      const response = await call('get', key, {
        headers: headers({
          ...(range === undefined
            ? {}
            : {
                'x-range-offset': String(range.offset),
                'x-range-length': String(range.length),
              }),
          ...(ignore ? { 'x-ignore-range': '1' } : {}),
        }),
      });
      if (response.status === 404) return null;
      if (!response.ok) throw await failure(response);
      return {
        size: Number(response.headers.get('x-size')),
        mediaType: response.headers.get('x-media-type')!,
        range: JSON.parse(response.headers.get('x-range')!) as {
          offset: number;
          length: number;
        } | null,
        body: response.body!,
      };
    },
    async head(key) {
      takeFailRead();
      const response = await call('head', key, { headers: headers() });
      if (!response.ok) throw await failure(response);
      return (await response.json()) as { size: number; mediaType: string } | null;
    },
    async remove(key) {
      faults.removes += 1;
      if (faults.stallRemove) {
        faults.stallRemove = false;
        return new Promise<void>(() => {});
      }
      if (faults.failRemove) {
        faults.failRemove = false;
        throw new Error('storage down');
      }
      const response = await call('remove', key, { headers: headers() });
      if (!response.ok) throw await failure(response);
    },
  };
}

type R2LifecycleFixture = BlobReserveFixture &
  BlobLifecycleFixture & {
    readonly bucket: BucketAdmin;
  };

async function r2Fixture(backdatePublished = true): Promise<R2LifecycleFixture> {
  const index = nextCase;
  nextCase += 1;
  const bucketName = bucketNames[index];
  const databaseName = databaseNames[index];
  if (bucketName === undefined || databaseName === undefined) {
    throw new Error('out of Miniflare bindings');
  }
  const bucket = (await mf.getR2Bucket(bucketName)) as unknown as BucketAdmin;
  const database = (await mf.getD1Database(databaseName)) as unknown as D1DatabaseLike;
  const executor = createD1Executor(database);
  const names = readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  await migrate(
    executor,
    await Promise.all(
      names.map(async (name) =>
        loadMigrationSource('core', name, await readFile(join(migrationsDirectory, name), 'utf8')),
      ),
    ),
    { holder: 'r2-blob-contract' },
  );
  const repository = createBlobRepository(executor);
  const faults: Faults = {
    failRead: false,
    fullBody: false,
    removes: 0,
    stallRemove: false,
    failRemove: false,
  };
  const byteStore = proxyStore(bucketName, faults);
  const lifecycle = createBlobLifecycle({
    metadata: repository,
    store: byteStore,
    deleteTimeoutMs: DELETE_TIMEOUT_MS,
    leaseMs: 900_000,
    observability: noopObservability,
  });
  let referenceCounter = 0;
  const state = { failPublish: false };

  const metadata: BlobMetadataPort = {
    reserve: (ctx, key) => repository.reserve(ctx, key),
    async publish(ctx, input) {
      if (state.failPublish) {
        state.failPublish = false;
        throw new Error('database down');
      }
      const result = await repository.publish(ctx, input);
      if (backdatePublished) {
        await exec(
          "UPDATE blob SET published_at = '2000-01-01T00:00:00.000Z' WHERE org_id = ? AND sha256 = ?",
          ctx.orgId,
          input.sha256,
        );
      }
      return result;
    },
    find: (ctx, key) => repository.find(ctx, key),
    narrowRefetchable: (ctx, input) => repository.narrowRefetchable(ctx, input),
    inspect: (ctx, key) => repository.inspect(ctx, key),
  };

  const FORMAT = '%Y-%m-%dT%H:%M:%fZ';
  const exec = async (sql: string, ...params: (string | number)[]): Promise<void> => {
    await executor.batch([{ sql, params }]);
  };
  const seeded = new Set<string>();

  return {
    bucket,
    lifecycle,
    inspect: (ctx, key) => repository.inspect(ctx, key),
    byteStore,
    store: createBlobStore(byteStore, metadata, {
      admission: createBlobUploadAdmission(),
      idleTimeoutMs: 2_000,
    }),
    stagesUploads: false,
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
    removeCalls: () => faults.removes,
    stallNextRemove() {
      faults.stallRemove = true;
    },
    failNextRemove() {
      faults.failRemove = true;
    },
    narrowRefetchable: (ctx, input) => repository.narrowRefetchable(ctx, input),
    reserve: (ctx, key) => repository.reserve(ctx, key),
    claimPurge: (ctx, key) => repository.claimPurge(ctx, key),
    async expireLease(ctx, key) {
      await exec(
        `UPDATE blob SET purge_lease_until = strftime('${FORMAT}', 'now', '-1 minute') WHERE org_id = ? AND sha256 = ?`,
        ctx.orgId,
        key,
      );
    },
    async generationOf(ctx, key) {
      const rows = await executor.all<{ purge_generation: string | null }>({
        sql: 'SELECT purge_generation FROM blob WHERE org_id = ? AND sha256 = ?',
        params: [ctx.orgId, key],
      });
      return rows[0]?.purge_generation ?? null;
    },
    reserveWithLeaseExpiringBetweenStatements: (ctx, key) =>
      createBlobRepository(executorExpiringLeaseAfterFirstStatement(executor, ctx, key)).reserve(
        ctx,
        key,
      ),
    async refetchableOf(ctx: OrgContext, key: Sha256) {
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
      faults.failRead = true;
    },
    async corruptBytes(ctx, key) {
      const storageKey = blobStorageKey(ctx.orgId, key);
      const found = await bucket.get(storageKey);
      if (found === null) throw new Error('object missing');
      const whole = new Uint8Array(await found.arrayBuffer());
      await bucket.put(storageKey, whole.subarray(0, whole.length - 1), {
        httpMetadata: found.httpMetadata,
      });
    },
    async removeBytes(ctx, key) {
      await bucket.delete(blobStorageKey(ctx.orgId, key));
    },
    stagedObjects: async () => 0,
    answerNextRangeWithFullBody() {
      faults.fullBody = true;
    },
  };
}

describeBlobContract('r2-miniflare', r2Fixture);
describeBlobReserveContract('r2-miniflare', r2Fixture);

const lifecycleFixture = (): Promise<R2LifecycleFixture> => r2Fixture(false);

describeBlobLifecycleContract('r2-miniflare', lifecycleFixture);

describe('r2 lifecycle fixture', () => {
  async function scheduled() {
    const f = await lifecycleFixture();
    const org = await f.seed('01J0LIFECYCLE00000000000A');
    const data = new TextEncoder().encode('physical R2 lifecycle');
    const key = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('') as Sha256;
    await f.store.put(
      org,
      key,
      new ReadableStream({
        start(controller) {
          controller.enqueue(data);
          controller.close();
        },
      }),
      { size: data.length, mediaType: 'text/plain', refetchable: true },
    );
    await f.makeEligible(org, key);
    await f.lifecycle.softDelete(org, key, { removedAt: await f.now() });
    await f.expireRetention(org, key);
    return { f, org, key, storageKey: blobStorageKey(org.orgId, key) };
  }

  it('a referenced blob keeps the physical R2 object', async () => {
    const { f, org, key, storageKey } = await scheduled();
    await f.addReference(org, key, 'active');
    expect(await f.lifecycle.claimPurge(org, key)).toBeNull();
    expect(f.removeCalls()).toBe(0);
    expect(await f.bucket.head(storageKey)).not.toBeNull();
  });

  it('a crash after byte removal recovers with a missing R2 key and leaves bucket.head null', async () => {
    const { f, org, key, storageKey } = await scheduled();
    expect(await f.bucket.head(storageKey)).not.toBeNull();
    const first = (await f.lifecycle.claimPurge(org, key))!;
    await f.removeBytes(org, key);
    await expect.poll(() => f.bucket.head(storageKey)).toBeNull();
    await f.expireLease(org, key);
    const recovered = (await f.lifecycle.claimPurge(org, key))!;
    expect(recovered).not.toBeNull();
    expect(recovered).not.toBe(first);
    expect(await f.lifecycle.recheckAndRemove(org, key, recovered)).toBe(true);
    expect(await f.lifecycle.markDeleted(org, key, recovered)).toBe(true);
    expect(await f.lifecycle.markDeleted(org, key, recovered)).toBe(false);
    await expect.poll(() => f.bucket.head(storageKey)).toBeNull();
  });

  it.each(['stallNextRemove', 'failNextRemove'] as const)(
    '%s affects only the next remove',
    async (fault) => {
      const { f, org, key, storageKey } = await scheduled();
      const first = (await f.lifecycle.claimPurge(org, key))!;
      f[fault]();
      expect(await f.lifecycle.recheckAndRemove(org, key, first)).toBe(false);
      expect(f.removeCalls()).toBe(1);
      expect((await f.inspect(org, key))?.purging).toBe(true);
      expect(await f.bucket.head(storageKey)).not.toBeNull();
      await f.expireLease(org, key);
      const next = (await f.lifecycle.claimPurge(org, key))!;
      expect(next).not.toBeNull();
      expect(next).not.toBe(first);
      expect(await f.lifecycle.recheckAndRemove(org, key, next)).toBe(true);
      expect(f.removeCalls()).toBe(3);
      await expect.poll(() => f.bucket.head(storageKey)).toBeNull();
    },
  );
});

describeBlobStagingContract('lifecycleFixture', lifecycleFixture);
