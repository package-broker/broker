import { auditTrail } from '../audit-trail.test.support.js';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { SqlExecutor } from '@package-broker/core/db/port';
import type { PlatformPortConfig } from '@package-broker/core/platform/port-config';
import { createKeyring, type Keyring } from '@package-broker/core/secrets/keyring';
import { parseMasterKey } from '@package-broker/core/secrets/master-key';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { discoveredMigrations } from '@package-broker/db-sqlite/testing/migrated-database';
import type { R2BucketLike } from '../blob/r2.js';
import { createD1Executor, type D1DatabaseLike } from '../db/d1-executor.js';
import { createWorker, type Env, type Worker } from '../index.js';

interface Acceptance {
  Receiver: new () => {
    answer(url: string, method: string, headers: Headers, body: Uint8Array): Response;
  };
  notificationAcceptanceSteps(
    harness: unknown,
  ): readonly (readonly [string, () => Promise<void>])[];
}
interface Seed {
  seedIntegrationWorld(executor: SqlExecutor, keyring: Keyring): Promise<{ orgId: string }>;
  advanceRetry(executor: SqlExecutor, orgId: string): Promise<void>;
  notificationBusy(executor: SqlExecutor, orgId: string): Promise<boolean>;
  integrationDeliveries(executor: SqlExecutor, orgId: string): Promise<unknown[]>;
  storedTexts(executor: SqlExecutor, orgId: string): Promise<string>;
}

/** Loaded by URL: packages never import each other's sources. */
const acceptance = (await import(
  new URL('../../../core/src/test-support/notification-integration.ts', import.meta.url).href
)) as Acceptance;
const seed = (await import(
  new URL('../../../db-sqlite/src/testing/notification-integration.ts', import.meta.url).href
)) as Seed;

const KEY = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const ORIGIN = 'https://broker.test';
const keyring = createKeyring([parseMasterKey(KEY, 'PB_MASTER_KEY')]);
const platformPorts: PlatformPortConfig = {
  blob: { adapter: 'r2', binding: 'STORAGE', maxBytes: 1_048_576 },
  cache: { adapter: 'cache-api', namespace: 'notification-acceptance' },
  jobs: { adapter: 'queues', binding: 'JOBS', maxRunning: 4 },
  observability: { adapter: 'workers', deploymentIdEnv: 'DEPLOYMENT_ID' },
};

/** Node lacks workerd's DigestStream and FixedLengthStream; the R2 store needs both. */
class DigestStreamShim extends WritableStream<Uint8Array> {
  readonly digest: Promise<ArrayBuffer>;
  constructor(algorithm: string) {
    const hash = createHash(algorithm.replace('-', '').toLowerCase());
    let settle!: (value: ArrayBuffer) => void;
    let refuse!: (reason: unknown) => void;
    const digest = new Promise<ArrayBuffer>((resolve, reject) => {
      settle = resolve;
      refuse = reject;
    });
    digest.catch(() => undefined);
    super({
      write(chunk) {
        hash.update(chunk);
      },
      close() {
        const out = hash.digest();
        settle(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer);
      },
      abort(reason) {
        refuse(reason);
      },
    });
    this.digest = digest;
  }
}

class FixedLengthStreamShim {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  constructor() {
    const identity = new TransformStream<Uint8Array, Uint8Array>();
    this.readable = identity.readable;
    this.writable = identity.writable;
  }
}

const receiver = new acceptance.Receiver();
const logged: unknown[] = [];
const queued: unknown[] = [];
let mf: Miniflare;
let executor: SqlExecutor;
let env: Env;
let worker: Worker;
let bootWorker: (enabled: boolean) => Worker;
let orgId: string;
let world: unknown;

beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      compatibilityDate: '2026-10-01',
      d1Databases: ['DB'],
      r2Buckets: ['STORAGE'],
    }),
  );
  const db = (await mf.getD1Database('DB')) as unknown as D1DatabaseLike;
  executor = createD1Executor(db);
  await migrate(executor, await discoveredMigrations(), { holder: 'notification-acceptance' });
  const seeded = await seed.seedIntegrationWorld(executor, keyring);
  orgId = seeded.orgId;
  world = seeded;
  const r2 = (await mf.getR2Bucket('STORAGE')) as unknown as R2BucketLike;
  // The Node-side proxy of the R2 binding refuses a stream without a known length; buffer it.
  const bucket: R2BucketLike = {
    put: async (key, value, options) =>
      r2.put(
        key,
        value instanceof ReadableStream ? await new Response(value).arrayBuffer() : value,
        options,
      ),
    get: (key, options) => r2.get(key, options),
    head: (key) => r2.head(key),
    delete: (keys) => r2.delete(keys),
    list: (options) => (r2 as Required<R2BucketLike>).list(options),
    createMultipartUpload: (async (key: string, options?: { httpMetadata?: unknown }) => {
      const parts = new Map<number, Uint8Array>();
      return {
        uploadPart: async (partNumber: number, value: ArrayBuffer | Uint8Array) => {
          parts.set(
            partNumber,
            new Uint8Array(value instanceof ArrayBuffer ? value : value.slice()),
          );
          return { partNumber, etag: `part-${partNumber}` };
        },
        complete: async (uploaded: readonly { partNumber: number }[]) => {
          const chunks = uploaded.map(({ partNumber }) => parts.get(partNumber)!);
          const whole = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
          let at = 0;
          for (const chunk of chunks) {
            whole.set(chunk, at);
            at += chunk.length;
          }
          return r2.put(key, whole, options as never);
        },
        abort: async () => undefined,
      };
    }) as unknown as NonNullable<R2BucketLike['createMultipartUpload']>,
  };
  Object.defineProperty(crypto, 'DigestStream', { configurable: true, value: DigestStreamShim });
  vi.stubGlobal('FixedLengthStream', FixedLengthStreamShim);
  env = {
    DB: db,
    STORAGE: bucket,
    JOBS: {
      send: async (body: unknown) => void queued.push(body),
      sendBatch: async (messages: readonly { body: unknown }[]) =>
        void queued.push(...messages.map((message) => message.body)),
    },
    DEPLOYMENT_ID: 'notification-acceptance',
    PB_MASTER_KEY: KEY,
    PB_PUBLIC_URL: ORIGIN,
    PB_KEYRING_RESEED: '1',
  } as Env;
  bootWorker = (enabled) =>
    createWorker([auditTrail()], {
      audit: {},
      platformPorts,
      notifications: { enabled },
      log: (entry) => void logged.push(entry),
      console: {
        log: (value) => void logged.push(value),
        error: (value) => void logged.push(value),
      },
      cacheStorage: {
        open: async () => ({
          match: async () => undefined,
          put: async () => undefined,
          delete: async () => false,
        }),
      },
    });
  worker = bootWorker(true);
  await worker.services(env);
  const native = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    if (['localhost', '127.0.0.1', '[::1]'].includes(new URL(request.url).hostname))
      return native(input, init);
    return receiver.answer(
      request.url,
      request.method,
      request.headers,
      new Uint8Array(await request.arrayBuffer()),
    );
  });
}, 120_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(crypto, 'DigestStream');
  await mf?.dispose();
});

/** Delivers queued wakeups and lets cron recover due work until nothing runnable remains. */
async function drain() {
  for (let round = 0; round < 40; round += 1) {
    await worker.scheduled({ cron: '* * * * *', scheduledTime: Date.now() }, env);
    while (queued.length > 0) {
      const messages = queued
        .splice(0)
        .map((body) => ({ body, ack: () => undefined, retry: () => undefined }));
      await worker.queue({ messages }, env);
    }
    if (!(await seed.notificationBusy(executor, orgId))) return;
  }
  throw new Error('notification jobs did not settle');
}

const harness = {
  origin: ORIGIN,
  get world() {
    return world;
  },
  receiver,
  fetch: (request: Request) => worker.fetch(request, env),
  async disableNotifications() {
    worker = bootWorker(false);
    await worker.services(env);
  },
  drain,
  advanceRetry: () => seed.advanceRetry(executor, orgId),
  deliveries: () => seed.integrationDeliveries(executor, orgId),
  stored: () => seed.storedTexts(executor, orgId),
  logs: () => JSON.stringify(logged),
};

describe('Workers notification acceptance', () => {
  for (const [name, step] of acceptance.notificationAcceptanceSteps(harness))
    it(name, step, 120_000);
});
