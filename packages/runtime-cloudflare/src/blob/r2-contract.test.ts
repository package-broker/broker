import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterAll } from 'vitest';
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
import {
  describeBlobContract,
  type BlobContractFixture,
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
}

async function failure(response: Response): Promise<Error> {
  const { failure: name } = (await response.json()) as { failure: string };
  if (name === 'BlobSizeMismatchError') return new BlobSizeMismatchError();
  if (name === 'BlobValidationError') return new BlobValidationError();
  return new Error(name);
}

type DispatchInit = NonNullable<Parameters<Miniflare['dispatchFetch']>[1]>;

interface BucketAdmin {
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
      const response = await call('remove', key, { headers: headers() });
      if (!response.ok) throw await failure(response);
    },
  };
}

async function r2Fixture(): Promise<BlobContractFixture> {
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
  const faults: Faults = { failRead: false, fullBody: false };
  const state = { failPublish: false };

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

  const FORMAT = '%Y-%m-%dT%H:%M:%fZ';
  const exec = async (sql: string, ...params: (string | number)[]): Promise<void> => {
    await executor.batch([{ sql, params }]);
  };
  const seeded = new Set<string>();

  return {
    store: createBlobStore(proxyStore(bucketName, faults), metadata, {
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
