import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AwsClient } from 'aws4fetch';
import type { OrgContext, SqlExecutor } from '@package-broker/core/db/port';
import { orgContext } from '@package-broker/core/db/port';
import {
  blobStorageKey,
  createBlobStore,
  createBlobUploadAdmission,
  parseSha256,
} from '@package-broker/core/platform/blob';
import type { BlobMetadataPort, ByteStore, Sha256 } from '@package-broker/core/platform/blob';
import { createBlobLifecycle } from '@package-broker/core/platform/blob-lifecycle';
import { noopObservability } from '@package-broker/core/platform/observability';
import {
  describeBlobContract,
  describeBlobLifecycleContract,
  requireBlobLifecycleFixtureHooks,
  type BlobLifecycleFixture,
} from '@package-broker/db-sqlite/contract/blob-contract';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { loadMigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { createBlobRepository } from '@package-broker/db-sqlite/repositories/blob';
import { openBetterSqliteExecutor } from '../db/better-sqlite3-executor.js';
import { createS3ByteStore } from './s3.js';
import { S3_FAKE_DEFAULT_CREDENTIALS, S3_FAKE_ENDPOINT, startS3Fake } from './testing/s3-fake.js';

const require = createRequire(import.meta.url);
const migrationsDirectory = join(
  dirname(require.resolve('@package-broker/db-sqlite/package.json')),
  'migrations',
);

const BUCKET = 'broker';
const REGION = 'us-east-1';
const STAGING_PREFIX = 'staging/';

const DELETE_TIMEOUT_MS = 1_000;

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function s3Fixture(): Promise<BlobLifecycleFixture> {
  const fake = startS3Fake();
  const state = {
    failPublish: false,
    failRead: false,
    fullBody: false,
    removes: 0,
    stallRemove: false,
    failRemove: false,
    inFlightStaging: 0,
  };

  const fakeFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.method === 'PUT' && new URL(request.url).pathname.includes(`/${STAGING_PREFIX}`)) {
      state.inFlightStaging += 1;
      try {
        return await fake.fetch(request);
      } finally {
        state.inFlightStaging -= 1;
      }
    }
    const ranged = request.method === 'GET' && request.headers.has('range');
    if (ranged && state.fullBody) {
      state.fullBody = false;
      fake.faults.rangeIgnored = true;
      try {
        return await fake.fetch(request);
      } finally {
        fake.faults.rangeIgnored = false;
      }
    }
    return fake.fetch(request);
  };

  const byteStore = createS3ByteStore({
    endpoint: S3_FAKE_ENDPOINT,
    region: REGION,
    bucket: BUCKET,
    ...S3_FAKE_DEFAULT_CREDENTIALS,
    pathStyle: true,
    fetch: fakeFetch,
  });

  const guarded: ByteStore = {
    putVerified: (key, body, input) => byteStore.putVerified(key, body, input),
    async get(key, range) {
      if (state.failRead) {
        state.failRead = false;
        throw new Error('storage down');
      }
      return byteStore.get(key, range);
    },
    async head(key) {
      if (state.failRead) {
        state.failRead = false;
        throw new Error('storage down');
      }
      return byteStore.head(key);
    },
    async remove(key) {
      state.removes += 1;
      if (state.stallRemove) {
        state.stallRemove = false;
        return new Promise<void>(() => {});
      }
      if (state.failRemove) {
        state.failRemove = false;
        throw new Error('storage down');
      }
      await byteStore.remove(key);
    },
  };

  const directory = openBetterSqliteExecutor(':memory:');
  cleanups.push(() => directory.close());
  const executor: SqlExecutor = directory.executor;
  const names = (await readdir(migrationsDirectory)).filter((name) => name.endsWith('.sql')).sort();
  await migrate(
    executor,
    await Promise.all(
      names.map(async (name) =>
        loadMigrationSource('core', name, await readFile(join(migrationsDirectory, name), 'utf8')),
      ),
    ),
    { holder: 's3-blob-test' },
  );
  const repository = createBlobRepository(executor);

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

  const admin = new AwsClient({ ...S3_FAKE_DEFAULT_CREDENTIALS, region: REGION, service: 's3' });
  const objectUrl = (ctx: OrgContext, key: Sha256): string =>
    `${S3_FAKE_ENDPOINT}/${BUCKET}/${blobStorageKey(ctx.orgId, key)
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`;

  const FORMAT = '%Y-%m-%dT%H:%M:%fZ';
  const exec = async (sql: string, ...params: (string | number)[]): Promise<void> => {
    await executor.batch([{ sql, params }]);
  };
  const seeded = new Set<string>();
  let referenceCounter = 0;

  return {
    lifecycle: createBlobLifecycle({
      metadata: repository,
      store: guarded,
      deleteTimeoutMs: DELETE_TIMEOUT_MS,
      leaseMs: 900_000,
      observability: noopObservability,
    }),
    inspect: (ctx, key) => repository.inspect(ctx, key),
    store: createBlobStore(guarded, metadata, {
      admission: createBlobUploadAdmission(),
      idleTimeoutMs: 2_000,
    }),
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
VALUES (?, ?, ?, '1.0.0', '00001', strftime('${FORMAT}', 'now'), 'upstream', '{}', ?, ?, CASE WHEN ? = 'removed_upstream' THEN strftime('${FORMAT}', 'now', '-366 days') END, CASE WHEN ? = 'tombstoned' THEN strftime('${FORMAT}', 'now', '-366 days') END)`,
          params: [id, ctx.orgId, id, blobs[0].id, status, status, status],
        },
      ]);
    },
    async setVersionStatus(ctx, key, status) {
      await exec(
        `UPDATE version SET status = ?,
  removed_upstream_at = CASE WHEN ? = 'removed_upstream' THEN COALESCE(removed_upstream_at, strftime('${FORMAT}', 'now', '-366 days')) END,
  tombstoned_at = CASE WHEN ? = 'tombstoned' THEN COALESCE(tombstoned_at, strftime('${FORMAT}', 'now', '-366 days')) END
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
    async corruptBytes(ctx, key) {
      const url = objectUrl(ctx, key);
      const current = await fake.fetch(
        await admin.sign(url, { method: 'GET', redirect: 'manual' }),
      );
      if (!current.ok) throw new Error('object to corrupt is missing');
      const data = new Uint8Array(await current.arrayBuffer());
      const shorter = data.slice(0, data.length - 1);
      const put = await fake.fetch(
        await admin.sign(url, {
          method: 'PUT',
          redirect: 'manual',
          body: shorter,
          headers: {
            'content-length': String(shorter.length),
            'content-type': current.headers.get('content-type') ?? 'application/octet-stream',
          },
        }),
      );
      if (!put.ok) throw new Error('corrupting put failed');
    },
    async removeBytes(ctx, key) {
      await byteStore.remove(blobStorageKey(ctx.orgId, key));
    },
    stagedObjects: async () =>
      fake.keys().filter((name) => name.startsWith(STAGING_PREFIX)).length + state.inFlightStaging,
    answerNextRangeWithFullBody() {
      state.fullBody = true;
    },
  };
}

describeBlobContract('s3-fake', s3Fixture);

describeBlobLifecycleContract('s3-fake', s3Fixture);

describe('s3-fake lifecycle wiring', () => {
  const make = s3Fixture;

  async function scheduledBlob() {
    const f = await make();
    const org = await f.seed('01J0LIFECYCLE00000000000A');
    const data = new TextEncoder().encode('lifecycle adapter bytes');
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    const key = parseSha256([...hash].map((b) => b.toString(16).padStart(2, '0')).join(''));
    await f.store.put(
      org,
      key,
      new ReadableStream({
        start(controller) {
          controller.enqueue(data);
          controller.close();
        },
      }),
      { size: data.length, mediaType: 'application/octet-stream', refetchable: true },
    );
    await f.makeEligible(org, key);
    await f.lifecycle.softDelete(org, key, { removedAt: await f.now() });
    await f.expireRetention(org, key);
    return { f, org, key };
  }

  it('rejects a fixture missing makeEligible', async () => {
    const incomplete: Record<string, unknown> = { ...(await make()) };
    delete incomplete.makeEligible;
    expect(() =>
      requireBlobLifecycleFixtureHooks(incomplete as unknown as BlobLifecycleFixture),
    ).toThrow('makeEligible');
  });

  it.each(['stallNextRemove', 'failNextRemove'] as const)(
    '%s affects only the next removal and preserves bytes until the retry',
    async (hook) => {
      const { f, org, key } = await scheduledBlob();
      const generation = (await f.lifecycle.claimPurge(org, key))!;
      expect(generation).not.toBeNull();
      f[hook]();
      expect(await f.lifecycle.recheckAndRemove(org, key, generation)).toBe(false);
      expect(f.removeCalls()).toBe(1);
      await f.expireLease(org, key);
      expect(await f.store.head(org, key)).not.toBeNull();
      const retry = (await f.lifecycle.claimPurge(org, key))!;
      expect(retry).not.toBeNull();
      expect(await f.lifecycle.recheckAndRemove(org, key, retry)).toBe(true);
      expect(f.removeCalls()).toBe(2);
      expect(await f.lifecycle.markDeleted(org, key, retry)).toBe(true);
    },
  );

  it('recovers a crash after physical removal and accepts a missing key', async () => {
    const { f, org, key } = await scheduledBlob();
    const first = await f.lifecycle.claimPurge(org, key);
    expect(first).not.toBeNull();
    await f.removeBytes(org, key);
    await f.expireLease(org, key);
    const recovered = (await f.lifecycle.claimPurge(org, key))!;
    expect(recovered).not.toBeNull();
    expect(recovered).not.toBe(first);
    expect(await f.lifecycle.recheckAndRemove(org, key, recovered)).toBe(true);
    expect(f.removeCalls()).toBe(1);
    expect(await f.lifecycle.markDeleted(org, key, recovered)).toBe(true);
    expect(await f.lifecycle.markDeleted(org, key, recovered)).toBe(false);
    expect(await f.store.head(org, key)).toBeNull();
  });
});

describe('s3 contract wiring', () => {
  it('fails instead of skipping when a MinIO endpoint was requested but is unreachable', async () => {
    const endpoint = process.env.PB_TEST_S3_ENDPOINT;
    if (endpoint === undefined || endpoint === '') return;
    const response = await fetch(endpoint, { method: 'HEAD' });
    expect(response.status).toBeGreaterThan(0);
  });

  it('provides every fixture hook the shared suite requires', async () => {
    const fixture = await s3Fixture();
    expect(fixture.stagesUploads).toBe(true);
    expect(typeof fixture.corruptBytes).toBe('function');
    expect(typeof fixture.failNextPublish).toBe('function');
  });
});
