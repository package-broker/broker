import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '@package-broker/core/platform/tracing';
import { KernelConfigError } from '@package-broker/core/kernel/registry';
import { verifyNotificationSignature } from '@package-broker/core/runtime/notification-jobs';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { parseMasterKey } from '@package-broker/core/secrets/master-key';
import { createJobRepository } from '@package-broker/db-sqlite/repositories/job';
import {
  openMigratedDatabase,
  type MigratedDatabase,
} from '@package-broker/db-sqlite/testing/migrated-database';
import type { NodeBroker, NodeServerOptions } from './index.js';
import { createJobLoop } from './jobs/loop.js';
import { createNodeServerWithSeams } from './testing/node-server.js';
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
const {
  SIGNING_KEY,
  capturePublished,
  deliveries,
  seedDeliverableEndpoint,
  seedNotificationWorld,
} = (await import(
  new URL('../../db-sqlite/src/testing/notification-runtime.ts', import.meta.url).href
)) as NotificationRuntimeHelpers;

const KEY = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const keyring = createKeyring([parseMasterKey(KEY, 'PB_MASTER_KEY')]);
const ENDPOINT_A = '01J0EEEEEEEEEEEEEEEEEEEEE1';
const ENDPOINT_B = '01J0EEEEEEEEEEEEEEEEEEEEE2';
const NOTIFICATION_TYPES = /^core:notification-/;

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const quiet = { log: () => undefined, counter: () => undefined, histogram: () => undefined };

function boot(
  database: MigratedDatabase,
  notifications: NodeServerOptions['notifications'],
  connector?: FetchLike,
  overrides: Partial<NodeServerOptions> = {},
): NodeBroker {
  const broker = createNodeServerWithSeams(
    [],
    {
      executor: database.executor,
      log: () => undefined,
      ...(notifications === undefined ? {} : { notifications }),
      platformServices: {
        jobStore: createJobRepository(database.executor),
        blob: {} as never,
        cache: { get: async () => null, set: async () => undefined, delete: async () => undefined },
      },
      auth: {
        keyring,
        publicOrigin: 'https://broker.example.org',
        env: { PB_KEYRING_RESEED: '1' },
      },
      ...overrides,
    },
    connector === undefined ? {} : { notificationConnector: connector },
  );
  cleanup.push(() => broker.close());
  return broker;
}

async function run(database: MigratedDatabase, broker: NodeBroker, maxRunning = 2) {
  const kernel = await broker.ready();
  const loop = createJobLoop({
    executor: database.executor,
    jobs: kernel.registration.jobs,
    scope: kernel.jobScope,
    maxRunning,
    observability: quiet,
  });
  cleanup.push(async () => {
    await loop.stop();
  });
  loop.start();
  return kernel;
}

interface Seen {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Uint8Array;
}

function recording(hold?: (url: string) => Promise<void>) {
  const seen: Seen[] = [];
  const connector: FetchLike = async (input, init) => {
    const url = String(input);
    const body = new Uint8Array(init!.body as Uint8Array);
    seen.push({ url, headers: new Headers(init!.headers), body });
    await hold?.(url);
    return new Response(null, { status: 204 });
  };
  return { seen, connector };
}

async function world(endpoints: readonly string[]) {
  const database = await openMigratedDatabase({ twoOrganizations: true });
  cleanup.push(() => database.close());
  const org = database.orgs!.a;
  await seedNotificationWorld(database.executor, org);
  for (const id of endpoints)
    await seedDeliverableEndpoint(database.executor, org, keyring, {
      id,
      url: `https://hooks.example.com/${id}`,
    });
  return { database, org };
}

describe('Node notification wiring', () => {
  it.each(['executor', 'auth', 'platformServices'] as const)(
    'refuses enabled notifications without %s',
    async (missing) => {
      const { database } = await world([]);
      await expect(async () => {
        const broker = boot(database, { enabled: true }, undefined, { [missing]: undefined });
        await broker.ready();
      }).rejects.toMatchObject({
        name: 'KernelConfigError',
        problems: ['notifications: delivery is unavailable on this runtime'],
      });
    },
  );

  it.each([true, false])('probes missing notification schema with enabled=%s', async (enabled) => {
    const { database } = await world([]);
    for (const table of [
      'notification_attempt',
      'notification_delivery',
      'notification_event',
      'notification_endpoint',
    ])
      await database.executor.batch([{ sql: `DROP TABLE ${table}`, params: [] }]);
    const broker = boot(database, { enabled });
    if (enabled) await expect(broker.ready()).rejects.toMatchObject({ name: 'KernelConfigError' });
    else
      expect(
        (await broker.ready()).routeTemplates.has('/_pb/projects/:project/notifications'),
      ).toBe(false);
  });

  it('warns and omits routes when the disabled schema probe throws', async () => {
    const { database } = await world([]);
    const all = database.executor.all.bind(database.executor);
    vi.spyOn(database.executor, 'all').mockImplementation((statement) => {
      if (statement.sql.includes('sqlite_master')) throw new Error('probe unavailable');
      return all(statement);
    });
    const log = vi.fn();
    const kernel = await boot(database, undefined, undefined, { log }).ready();
    expect(kernel.routeTemplates.has('/_pb/projects/:project/notifications')).toBe(false);
    expect(log).toHaveBeenCalledWith({ level: 'warn', event: 'notifications.schema_probe_failed' });
  });

  it('registers no notification job and delivers nothing while the flag is off', async () => {
    const { database, org } = await world([ENDPOINT_A]);
    await capturePublished(database.executor, org);
    const { seen, connector } = recording();
    const kernel = await run(database, boot(database, undefined, connector));
    expect(kernel.routeTemplates.has('/_pb/projects/:project/notifications')).toBe(true);
    expect(
      kernel.registration.jobs.filter((job) => NOTIFICATION_TYPES.test(job.qualifiedName)),
    ).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(seen).toEqual([]);
    expect((await deliveries(database.executor, org)).map((d) => d.state)).toEqual(['pending']);
  }, 30_000);

  it('refuses an invalid notifications block at startup', async () => {
    const { database } = await world([]);
    let caught: unknown;
    try {
      boot(database, { enabled: 'yes' } as never);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(KernelConfigError);
    expect((caught as KernelConfigError).problems).toEqual([
      'notifications.enabled: must be a boolean',
    ]);
  });

  it('delivers work committed before this process started, signed with the sealed key', async () => {
    const { database, org } = await world([ENDPOINT_A]);
    await capturePublished(database.executor, org);
    const { seen, connector } = recording();
    const kernel = await run(database, boot(database, { enabled: true }, connector));
    expect(
      kernel.registration.jobs
        .filter((job) => NOTIFICATION_TYPES.test(job.qualifiedName))
        .map((job) => job.qualifiedName),
    ).toEqual([
      'core:notification-dispatch:v1',
      'core:notification-deliver:v1',
      'core:notification-retention:v1',
    ]);
    await vi.waitFor(
      async () =>
        expect(await deliveries(database.executor, org)).toEqual([
          { endpoint_id: ENDPOINT_A, state: 'delivered', attempts: 1, outcome_code: 'ok' },
        ]),
      { timeout: 15_000, interval: 50 },
    );
    expect(seen).toHaveLength(1);
    const [request] = seen;
    expect(request!.url).toBe(`https://hooks.example.com/${ENDPOINT_A}`);
    expect(JSON.parse(new TextDecoder().decode(request!.body))).toMatchObject({
      type: 'npm.package.published',
      package: { name: '@acme/widget', version: '1.0.0' },
    });
    const timestamp = Number(request!.headers.get('x-package-broker-timestamp'));
    expect(
      await verifyNotificationSignature({
        key: new Uint8Array(Buffer.from(SIGNING_KEY, 'base64url')),
        timestamp,
        deliveryId: request!.headers.get('x-package-broker-delivery')!,
        eventId: request!.headers.get('x-package-broker-event')!,
        method: 'POST',
        body: request!.body,
        signature: request!.headers.get('x-package-broker-signature')!,
        now: timestamp,
      }),
    ).toBe(true);
    const jobs = await database.executor.all<{ payload_json: string }>({
      sql: "SELECT payload_json FROM job WHERE org_id = ? AND type LIKE 'core:notification-%'",
      params: [org.orgId],
    });
    for (const job of jobs) expect(job.payload_json).not.toMatch(/hooks|Bearer|https/);
  }, 30_000);

  it('lets a second endpoint deliver while the first one is still sending', async () => {
    const { database, org } = await world([ENDPOINT_A, ENDPOINT_B]);
    await capturePublished(database.executor, org);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { seen, connector } = recording((url) =>
      url.endsWith(ENDPOINT_A) ? gate : Promise.resolve(),
    );
    await run(database, boot(database, { enabled: true }, connector), 3);
    await vi.waitFor(
      async () =>
        expect((await deliveries(database.executor, org)).map((d) => d.state)).toEqual([
          'sending',
          'delivered',
        ]),
      { timeout: 15_000, interval: 50 },
    );
    release();
    await vi.waitFor(
      async () =>
        expect((await deliveries(database.executor, org)).map((d) => d.state)).toEqual([
          'delivered',
          'delivered',
        ]),
      { timeout: 15_000, interval: 50 },
    );
    expect(seen).toHaveLength(2);
  }, 30_000);
});
