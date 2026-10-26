import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { ulid } from '@package-broker/core/ids';
import { definePlugin } from '@package-broker/core/plugin';
import type { PluginDefinition, PluginPorts } from '@package-broker/core/plugin';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { loadMigrationSource } from '@package-broker/db-sqlite/migrations/source';
import type { MigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { createD1Executor, type D1DatabaseLike } from './db/d1-executor.js';
import { createWorker } from './index.js';

const bindings = Array.from({ length: 8 }, (_, index) => `WDB${index}`);

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-10-01',
    d1Databases: bindings,
  } as Parameters<typeof convertV4MiniflareOptions>[0]),
);
let next = 0;

afterAll(async () => {
  await mf.dispose();
});

const require = createRequire(import.meta.url);
const migrationsDirectory = join(
  dirname(require.resolve('@package-broker/db-sqlite/package.json')),
  'migrations',
);
let init: MigrationSource | undefined;

async function initSource(): Promise<MigrationSource> {
  init ??= await loadMigrationSource(
    'core',
    '0001_init.sql',
    await readFile(join(migrationsDirectory, '0001_init.sql'), 'utf8'),
  );
  return init;
}

async function migratedDatabase(): Promise<D1DatabaseLike> {
  const binding = bindings[next];
  next += 1;
  if (binding === undefined) throw new Error('out of D1 bindings');
  const db = (await mf.getD1Database(binding)) as unknown as D1DatabaseLike;
  await migrate(createD1Executor(db), [await initSource()], {
    holder: 'worker-test',
  });
  return db;
}

async function bootstrap(db: D1DatabaseLike): Promise<string> {
  const id = ulid();
  await createOrganizationBootstrap(createD1Executor(db)).bootstrap({
    id,
    slug: 'acme',
    name: 'Acme',
    now: new Date().toISOString(),
  });
  return id;
}

function env(db: D1DatabaseLike) {
  return {
    DB: db,
    PB_MASTER_KEY: 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
    PB_PUBLIC_URL: 'https://broker.test',
  };
}

function request(path: string): Request {
  return new Request(`https://broker.invalid${path}`);
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { code: string } };
  return body.error.code;
}

function whoamiPlugin(): PluginDefinition {
  return definePlugin({
    id: 'whoami',
    package: 'test/whoami',
    platforms: ['cloudflare'],
    apiVersion: 3,
    register(registry) {
      registry.route({
        method: 'GET',
        path: '/whoami',
        permission: null,
        handler: (ctx) => Response.json({ orgId: ctx.org === null ? null : ctx.org.orgId }),
      });
    },
  });
}

function pingPlugin(onInit: (ports: PluginPorts) => void = () => undefined): PluginDefinition {
  return definePlugin({
    id: 'ping',
    package: 'test/ping',
    platforms: ['cloudflare'],
    apiVersion: 3,
    register(registry) {
      registry.route({
        method: 'GET',
        path: '/ping',
        permission: null,
        needsOrg: false,
        handler: () => Response.json({ pong: true }),
      });
    },
    init(ports) {
      onInit(ports);
    },
  });
}

describe('createWorker', () => {
  it('answers /whoami with the organization id only after bootstrap', async () => {
    const db = await migratedDatabase();
    const worker = createWorker([whoamiPlugin()]);

    const before = await worker.fetch(request('/whoami'), env(db));
    expect(before.status).toBe(503);
    expect(await errorCode(before)).toBe('not_bootstrapped');

    const id = await bootstrap(db);

    const after = await worker.fetch(request('/whoami'), env(db));
    expect(after.status).toBe(200);
    expect(((await after.json()) as { orgId: string }).orgId).toBe(id);

    const ready = await worker.fetch(request('/health/ready'), env(db));
    expect(ready.status).toBe(200);
  });

  it('reports not ready when the organization table disappears', async () => {
    const db = await migratedDatabase();
    await bootstrap(db);
    const worker = createWorker([]);

    const first = await worker.fetch(request('/health/ready'), env(db));
    expect(first.status).toBe(200);

    const executor = createD1Executor(db);
    await executor.batch([{ sql: 'PRAGMA defer_foreign_keys = on', params: [] }]);
    await executor.all({ sql: 'DROP TABLE organization', params: [] });

    const second = await worker.fetch(request('/health/ready'), env(db));
    expect(second.status).toBe(503);
  });

  it('keeps the missing binding out of the binding kernel cache', async () => {
    const db = await migratedDatabase();
    await bootstrap(db);
    const worker = createWorker([]);

    const withoutBinding = await worker.fetch(request('/health/ready'));
    expect(withoutBinding.status).toBe(503);

    const withBinding = await worker.fetch(request('/health/ready'), env(db));
    expect(withBinding.status).toBe(200);

    const again = await worker.fetch(request('/health/ready'), env(db));
    expect(again.status).toBe(200);
  });

  it('retries kernel creation after a failed init', async () => {
    let attempts = 0;
    const plugin = definePlugin({
      id: 'flaky',
      package: 'test/flaky',
      platforms: ['cloudflare'],
      apiVersion: 3,
      register(registry) {
        registry.route({
          method: 'GET',
          path: '/flaky',
          permission: null,
          needsOrg: false,
          handler: () => Response.json({ ok: true }),
        });
      },
      init() {
        attempts += 1;
        if (attempts === 1) throw new Error('init failed');
      },
    });
    const worker = createWorker([plugin]);

    const first = await worker.fetch(request('/flaky'));
    expect(first.status).toBe(500);
    expect(await errorCode(first)).toBe('internal');

    const second = await worker.fetch(request('/flaky'));
    expect(second.status).toBe(200);
    expect(attempts).toBe(2);
  });

  it('retries kernel creation after a failed init for a binding', async () => {
    const db = await migratedDatabase();
    let attempts = 0;
    const plugin = definePlugin({
      id: 'flaky-binding',
      package: 'test/flaky-binding',
      platforms: ['cloudflare'],
      apiVersion: 3,
      register(registry) {
        registry.route({
          method: 'GET',
          path: '/flaky-binding',
          permission: null,
          needsOrg: false,
          handler: () => Response.json({ ok: true }),
        });
      },
      init() {
        attempts += 1;
        if (attempts === 1) throw new Error('init failed');
      },
    });
    const worker = createWorker([plugin]);

    const first = await worker.fetch(request('/flaky-binding'), env(db));
    expect(first.status).toBe(500);
    expect(await errorCode(first)).toBe('internal');

    const second = await worker.fetch(request('/flaky-binding'), env(db));
    expect(second.status).toBe(200);
    expect(attempts).toBe(2);
  });

  it('initializes once per binding', async () => {
    const db = await migratedDatabase();
    let inits = 0;
    const worker = createWorker([pingPlugin(() => (inits += 1))]);

    await worker.fetch(request('/ping'), env(db));
    await worker.fetch(request('/ping'), env(db));

    expect(inits).toBe(1);
  });

  it('exposes an organization port with exactly one own key', async () => {
    const db = await migratedDatabase();
    let received: PluginPorts | null = null;
    const worker = createWorker([
      pingPlugin((ports) => {
        received = ports;
      }),
    ]);

    await worker.fetch(request('/ping'), env(db));

    if (received === null) throw new Error('init did not run');
    const organizations = (received as PluginPorts).organizations as unknown as Record<
      string,
      unknown
    >;
    expect(Object.keys(organizations)).toEqual(['get']);
    expect(organizations['updateSettings']).toBeUndefined();
    expect(Object.isFrozen(organizations)).toBe(true);
  });
});

it('reports schema drift through the Worker with a real Miniflare D1 database', async () => {
  const db = await migratedDatabase();
  await bootstrap(db);
  const source = await initSource();
  const executor = createD1Executor(db);
  const worker = () => createWorker([], { migrations: [source], log: () => undefined });
  const ready = (app: ReturnType<typeof createWorker>) =>
    app.fetch(request('/health/ready'), env(db));
  const healthy = await ready(worker());
  expect(healthy.status).toBe(200);
  expect(await healthy.json()).toEqual({ status: 'ready' });

  await executor.all({
    sql: 'UPDATE schema_migration SET checksum = ? WHERE id = ?',
    params: ['0'.repeat(64), source.id],
  });
  const drifting = worker();
  const mismatch = await ready(drifting);
  expect(mismatch.status).toBe(503);
  expect(await mismatch.json()).toEqual({ status: 'not_ready', reason: 'schema_drift' });
  const live = await drifting.fetch(request('/health/live'), env(db));
  expect(live.status).toBe(200);
  expect(await live.json()).toEqual({ status: 'live' });

  await executor.all({
    sql: 'UPDATE schema_migration SET checksum = ? WHERE id = ?',
    params: [source.checksum, source.id],
  });
  expect((await ready(drifting)).status).toBe(200);

  await executor.all({ sql: 'DROP TABLE schema_migration', params: [] });
  const missing = await ready(worker());
  expect(missing.status).toBe(503);
  expect(await missing.json()).toEqual({ status: 'not_ready', reason: 'schema_drift' });
});
