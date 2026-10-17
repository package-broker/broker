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
} from '@package-broker/core/platform/blob';
import type { BlobMetadataPort, ByteStore, Sha256 } from '@package-broker/core/platform/blob';
import {
  describeBlobContract,
  type BlobContractFixture,
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

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function s3Fixture(): Promise<BlobContractFixture> {
  const fake = startS3Fake();
  const state = { failPublish: false, failRead: false, fullBody: false, inFlightStaging: 0 };

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
    remove: (key) => byteStore.remove(key),
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

  return {
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
