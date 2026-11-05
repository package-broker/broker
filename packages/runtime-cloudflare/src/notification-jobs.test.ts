import { auditTrail } from './audit-trail.test.support.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { PlatformPortConfig } from '@package-broker/core/platform/port-config';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { parseMasterKey } from '@package-broker/core/secrets/master-key';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { seedTwoOrganizations } from '@package-broker/db-sqlite/contract/two-organizations';
import { discoveredMigrations } from '@package-broker/db-sqlite/testing/migrated-database';
import { createD1Executor, type D1DatabaseLike } from './db/d1-executor.js';
import { createWorker, type Env, type WorkerOptions } from './index.js';
import type { R2BucketLike } from './blob/r2.js';
import type { OrgContext, SqlExecutor } from '@package-broker/core/db/port';
import type { Keyring } from '@package-broker/core/secrets/keyring';

interface NotificationRuntimeHelpers {
  readonly SIGNING_KEY: string;
  seedNotificationWorld(executor: SqlExecutor, ctx: OrgContext): Promise<void>;
  seedDeliverableEndpoint(
    executor: SqlExecutor,
    ctx: OrgContext,
    keyring: Keyring,
    input: { readonly id: string; readonly url: string },
  ): Promise<void>;
  capturePublished(executor: SqlExecutor, ctx: OrgContext): Promise<string>;
  deliveries(
    executor: SqlExecutor,
    ctx: OrgContext,
  ): Promise<
    { endpoint_id: string; state: string; attempts: number; outcome_code: string | null }[]
  >;
}

/** Loaded by URL: packages never import each other's sources. */
const { capturePublished, deliveries, seedDeliverableEndpoint, seedNotificationWorld } =
  (await import(
    new URL('../../db-sqlite/src/testing/notification-runtime.ts', import.meta.url).href
  )) as NotificationRuntimeHelpers;

const KEY = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const ENDPOINT = '01J0EEEEEEEEEEEEEEEEEEEEE1';
const platformPorts: PlatformPortConfig = {
  blob: { adapter: 'r2', binding: 'STORAGE', maxBytes: 1024 },
  cache: { adapter: 'cache-api', namespace: 'notification-jobs-test' },
  jobs: { adapter: 'queues', binding: 'JOBS', maxRunning: 2 },
  observability: { adapter: 'workers', deploymentIdEnv: 'DEPLOYMENT_ID' },
};

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const step of cleanup.splice(0).reverse()) await step();
});

interface Sent {
  readonly body: unknown;
}

async function boot(notifications: WorkerOptions['notifications']) {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      compatibilityDate: '2026-10-01',
      d1Databases: ['DB'],
    }),
  );
  cleanup.push(() => mf.dispose());
  const db = (await mf.getD1Database('DB')) as unknown as D1DatabaseLike;
  const executor = createD1Executor(db);
  await migrate(executor, await discoveredMigrations(), { holder: 'notification-jobs-test' });
  const { a } = await seedTwoOrganizations(executor);
  await seedNotificationWorld(executor, a);
  await seedDeliverableEndpoint(
    executor,
    a,
    createKeyring([parseMasterKey(KEY, 'PB_MASTER_KEY')]),
    {
      id: ENDPOINT,
      url: `https://hooks.example.com/${ENDPOINT}`,
    },
  );
  const sent: Sent[] = [];
  const env: Env = {
    DB: db,
    STORAGE: {
      head: async () => null,
      get: async () => null,
      put: async () => null,
      delete: async () => undefined,
    } as unknown as R2BucketLike,
    JOBS: {
      send: async (body: unknown) => void sent.push({ body }),
      sendBatch: async (messages: readonly { body: unknown }[]) =>
        void sent.push(...messages.map((message) => ({ body: message.body }))),
    },
    DEPLOYMENT_ID: 'notification-jobs-test',
    PB_MASTER_KEY: KEY,
    PB_PUBLIC_URL: 'https://broker.test',
    PB_KEYRING_RESEED: '1',
  } as Env;
  const worker = createWorker([auditTrail()], {
    audit: {},
    platformPorts,
    log: () => undefined,
    console: { log: () => undefined, error: () => undefined },
    cacheStorage: {
      open: async () => ({
        match: async () => undefined,
        put: async () => undefined,
        delete: async () => false,
      }),
    },
    ...(notifications === undefined ? {} : { notifications }),
  });
  return { executor, org: a, env, worker, sent };
}

type Booted = Awaited<ReturnType<typeof boot>>;

/** Delivers every queued wakeup, including those the handlers send, until the queue is empty. */
async function drain({ worker, env, sent }: Booted, duplicate = false) {
  for (let round = 0; round < 20 && sent.length > 0; round += 1) {
    const batch = sent.splice(0);
    const messages = (duplicate ? [...batch, ...batch] : batch).map((message) => ({
      body: message.body,
      ack: () => undefined,
      retry: () => undefined,
    }));
    await worker.queue({ messages }, env);
  }
}

function stubFetch(respond: () => Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init! });
    return respond();
  });
  vi.stubGlobal('fetch', fetchSpy);
  return calls;
}

async function job(booted: Booted, org: OrgContext) {
  return booted.executor.all<{ type: string; state: string }>({
    sql: "SELECT type, state FROM job WHERE org_id = ? AND type LIKE 'core:notification-%' ORDER BY type",
    params: [org.orgId],
  });
}

describe('Workers notification wiring', () => {
  it('refuses enabled notifications without any services before touching storage', async () => {
    const worker = createWorker([], { notifications: { enabled: true }, log: () => undefined });
    await expect(worker.services()).rejects.toMatchObject({
      name: 'KernelConfigError',
      problems: ['notifications: delivery is unavailable on this runtime'],
    });
  });

  it.each(['database', 'platform', 'auth'] as const)(
    'refuses enabled notifications without %s',
    async (missing) => {
      const booted = await boot({ enabled: true });
      const env = { ...booted.env };
      if (missing === 'database') delete env.DB;
      if (missing === 'auth') delete env.PB_MASTER_KEY;
      const worker = createWorker([], {
        notifications: { enabled: true },
        log: () => undefined,
        ...(missing === 'platform' ? {} : { platformPorts }),
      });
      await expect(worker.services(env)).rejects.toMatchObject({ name: 'KernelConfigError' });
    },
    60_000,
  );

  it.each([true, false])(
    'probes missing notification schema with enabled=%s',
    async (enabled) => {
      const booted = await boot({ enabled });
      for (const table of [
        'notification_attempt',
        'notification_delivery',
        'notification_event',
        'notification_endpoint',
      ])
        await booted.executor.batch([{ sql: `DROP TABLE ${table}`, params: [] }]);
      if (enabled)
        await expect(booted.worker.services(booted.env)).rejects.toMatchObject({
          name: 'KernelConfigError',
        });
      else {
        await booted.worker.services(booted.env);
        const response = await booted.worker.fetch(
          new Request('https://broker.test/_pb/projects/demo/notifications'),
          booted.env,
        );
        expect(response.status).toBe(404);
      }
    },
    60_000,
  );

  it('warns and omits routes when the disabled schema probe throws', async () => {
    const booted = await boot(undefined);
    const database = booted.env.DB!;
    const log = vi.fn();
    const worker = createWorker([], {
      platformPorts,
      log,
      cacheStorage: {
        open: async () => ({
          match: async () => undefined,
          put: async () => undefined,
          delete: async () => false,
        }),
      },
    });
    const env = {
      ...booted.env,
      DB: {
        prepare(sql: string) {
          if (sql.includes('sqlite_master')) throw new Error('probe unavailable');
          return database.prepare(sql);
        },
        batch: database.batch.bind(database),
      },
    };
    await worker.services(env);
    const response = await worker.fetch(
      new Request('https://broker.test/_pb/projects/demo/notifications'),
      env,
    );
    expect(response.status).toBe(404);
    expect(log).toHaveBeenCalledWith({ level: 'warn', event: 'notifications.schema_probe_failed' });
  }, 60_000);

  it('refuses an invalid notifications block when the application is built', async () => {
    const booted = await boot({ enabled: 'yes' } as never);
    await expect(booted.worker.services(booted.env)).rejects.toMatchObject({
      name: 'KernelConfigError',
      problems: ['notifications.enabled: must be a boolean'],
    });
  }, 60_000);

  it('delivers nothing and wakes no notification job while the flag is off', async () => {
    const booted = await boot(undefined);
    expect((await booted.worker.services(booted.env)).packages).not.toBeNull();
    const response = await booted.worker.fetch(
      new Request('https://broker.test/_pb/projects/demo/notifications'),
      booted.env,
    );
    expect(response.status).toBe(401);
    await capturePublished(booted.executor, booted.org);
    const calls = stubFetch(async () => new Response(null, { status: 204 }));
    await booted.worker.scheduled({ cron: '* * * * *', scheduledTime: Date.now() }, booted.env);
    await drain(booted);
    expect(calls).toEqual([]);
    expect((await deliveries(booted.executor, booted.org)).map((d) => d.state)).toEqual([
      'pending',
    ]);
  }, 60_000);

  it('recovers a lost wakeup through cron and delivers once despite duplicate wakes', async () => {
    const booted = await boot({ enabled: true });
    await capturePublished(booted.executor, booted.org);
    const calls = stubFetch(async () => new Response(null, { status: 202 }));
    await booted.worker.scheduled({ cron: '* * * * *', scheduledTime: Date.now() }, booted.env);
    expect(booted.sent.length).toBeGreaterThan(0);
    await drain(booted, true);
    expect(await deliveries(booted.executor, booted.org)).toEqual([
      { endpoint_id: ENDPOINT, state: 'delivered', attempts: 1, outcome_code: 'ok' },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://hooks.example.com/${ENDPOINT}`);
    expect(calls[0]!.init.redirect).toBe('manual');
    expect(calls[0]!.init.method).toBe('POST');
  }, 60_000);

  it('persists a safe retry outcome when native fetch fails', async () => {
    const booted = await boot({ enabled: true });
    await capturePublished(booted.executor, booted.org);
    stubFetch(async () => {
      throw new TypeError('connect failed to https://hooks.example.com/secret-path');
    });
    await booted.worker.scheduled({ cron: '* * * * *', scheduledTime: Date.now() }, booted.env);
    await drain(booted);
    expect(await deliveries(booted.executor, booted.org)).toEqual([
      { endpoint_id: ENDPOINT, state: 'pending', attempts: 1, outcome_code: 'network' },
    ]);
    const attempts = await booted.executor.all<Record<string, unknown>>({
      sql: 'SELECT outcome, outcome_code, status FROM notification_attempt WHERE org_id = ?',
      params: [booted.org.orgId],
    });
    expect(attempts).toEqual([{ outcome: 'retry', outcome_code: 'network', status: null }]);
    const stored = JSON.stringify(
      await booted.executor.all({
        sql: "SELECT payload_json, last_error, sync_error FROM job WHERE org_id = ? AND type LIKE 'core:notification-%'",
        params: [booted.org.orgId],
      }),
    );
    expect(stored).not.toMatch(/secret-path|hooks\.example/);
    expect((await job(booted, booted.org)).map((row) => row.type)).toContain(
      'core:notification-deliver:v1',
    );
  }, 60_000);
});
