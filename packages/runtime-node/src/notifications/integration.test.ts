import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { createBlobStore, createBlobUploadAdmission } from '@package-broker/core/platform/blob';
import type { FetchLike } from '@package-broker/core/platform/tracing';
import { resolveRegistryConfig } from '@package-broker/core/registry/registry-config';
import { createKeyring, type Keyring } from '@package-broker/core/secrets/keyring';
import { parseMasterKey } from '@package-broker/core/secrets/master-key';
import { createBlobRepository } from '@package-broker/db-sqlite/repositories/blob';
import { createJobRepository } from '@package-broker/db-sqlite/repositories/job';
import {
  openMigratedDatabase,
  type MigratedDatabase,
} from '@package-broker/db-sqlite/testing/migrated-database';
import { openFilesystemByteStore } from '../blob/filesystem.js';
import { createLruCache } from '../cache/lru.js';
import type { NodeBroker } from '../index.js';
import { createJobLoop, type JobLoop } from '../jobs/loop.js';
import { createNodeServerWithSeams } from '../testing/node-server.js';

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
const quiet = { log: () => undefined, counter: () => undefined, histogram: () => undefined };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const receiver = new acceptance.Receiver();
const logged: unknown[] = [];
let database: MigratedDatabase;
let directory: string;
let broker: NodeBroker;
let bootBroker: (enabled: boolean) => Promise<NodeBroker>;
let loop: JobLoop;
let orgId: string;
let world: unknown;

const answer: FetchLike = async (input, init) => {
  const request = new Request(input, init);
  return receiver.answer(
    request.url,
    request.method,
    request.headers,
    new Uint8Array(await request.arrayBuffer()),
  );
};

beforeAll(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'pb-notification-acceptance-')));
  database = await openMigratedDatabase();
  const seeded = await seed.seedIntegrationWorld(database.executor, keyring);
  orgId = seeded.orgId;
  world = seeded;
  bootBroker = async (enabled) =>
    createNodeServerWithSeams(
      [],
      {
        executor: database.executor,
        notifications: { enabled },
        auth: { keyring, publicOrigin: ORIGIN, env: { PB_KEYRING_RESEED: '1' } },
        platformServices: {
          blob: createBlobStore(
            await openFilesystemByteStore({ root: join(directory, 'blobs') }),
            createBlobRepository(database.executor, { purgeLeaseSeconds: 900 }),
            { admission: createBlobUploadAdmission(), maxBytes: 1_048_576 },
          ),
          cache: createLruCache({}),
          jobStore: createJobRepository(database.executor),
        },
        registry: { config: resolveRegistryConfig(undefined, 'node', ORIGIN) },
        log: (entry) => void logged.push(entry),
      },
      { transport: answer, notificationConnector: answer },
    );
  broker = await bootBroker(true);
  const kernel = await broker.ready();
  loop = createJobLoop({
    executor: database.executor,
    jobs: kernel.registration.jobs,
    scope: kernel.jobScope,
    maxRunning: 4,
    observability: quiet,
  });
  loop.start();
}, 60_000);

afterAll(async () => {
  await loop?.stop();
  await broker?.close();
  await database?.close();
  await rm(directory, { recursive: true, force: true });
});

const harness = {
  origin: ORIGIN,
  get world() {
    return world;
  },
  receiver,
  fetch: async (request: Request) => (await broker.ready()).fetch(request),
  async disableNotifications() {
    await loop.stop();
    await broker.close();
    broker = await bootBroker(false);
    await broker.ready();
  },
  async drain() {
    let idle = 0;
    for (let round = 0; round < 300 && idle < 3; round += 1) {
      await sleep(200);
      idle = (await seed.notificationBusy(database.executor, orgId)) ? 0 : idle + 1;
    }
    if (idle < 3) throw new Error('notification jobs did not settle');
  },
  advanceRetry: () => seed.advanceRetry(database.executor, orgId),
  deliveries: () => seed.integrationDeliveries(database.executor, orgId),
  stored: () => seed.storedTexts(database.executor, orgId),
  logs: () => JSON.stringify(logged),
};

describe('Node notification acceptance', () => {
  for (const [name, step] of acceptance.notificationAcceptanceSteps(harness))
    it(name, step, 60_000);
});
