import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqlExecutor } from '@package-broker/core/db/port';
import {
  SUPPORTED_PLUGIN_API,
  type PluginDefinition,
  type PluginPorts,
} from '@package-broker/core/plugin';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { loadMigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { openBetterSqliteExecutor } from './db/better-sqlite3-executor.js';
import { createNodeServer, type NodeBroker } from './index.js';

const require = createRequire(import.meta.url);
const migrationsDirectory = join(
  dirname(require.resolve('@package-broker/db-sqlite/package.json')),
  'migrations',
);

const log = (): void => undefined;

function brokerPlugin(id: string): {
  readonly plugin: PluginDefinition;
  readonly ports: PluginPorts[];
} {
  const ports: PluginPorts[] = [];
  const plugin: PluginDefinition = {
    id,
    package: `@test/${id}`,
    apiVersion: SUPPORTED_PLUGIN_API[0],
    platforms: ['node'],
    register(registry) {
      registry.route({
        method: 'GET',
        path: '/whoami',
        permission: null,
        handler: (ctx) => Response.json({ org: ctx.org?.orgId ?? null }),
      });
      registry.route({
        method: 'POST',
        path: '/echo',
        permission: null,
        handler: async (ctx) => new Response(await ctx.request.text()),
      });
    },
    init(received) {
      ports.push(received);
    },
  };
  return { plugin, ports };
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { code: string } };
  return body.error.code;
}

async function bootstrapOrganization(executor: SqlExecutor): Promise<string> {
  const id = randomUUID();
  await createOrganizationBootstrap(executor).bootstrap({
    id,
    slug: 'acme',
    name: 'Acme',
    now: new Date().toISOString(),
  });
  return id;
}

describe('createNodeServer', () => {
  let directory: string;
  let opened: ReturnType<typeof openBetterSqliteExecutor>;
  const running: NodeBroker[] = [];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'pb-runtime-node-server-'));
    opened = openBetterSqliteExecutor(join(directory, 'broker.db'));
    const init = await loadMigrationSource(
      'core',
      '0001_init.sql',
      await readFile(join(migrationsDirectory, '0001_init.sql'), 'utf8'),
    );
    const later = await Promise.all(
      [
        '0002_local_login.sql',
        '0003_access_model.sql',
        '0004_cache_epoch.sql',
        '0005_admin_permission_topup.sql',
        '0006_ports.sql',
        '0015_keyring_verifier.sql',
      ].map(async (name) =>
        loadMigrationSource('core', name, await readFile(join(migrationsDirectory, name), 'utf8')),
      ),
    );
    await migrate(opened.executor, [init, ...later], { holder: 'runtime-node-server-test' });
  });

  afterEach(async () => {
    try {
      for (const broker of running.splice(0)) await broker.close();
    } finally {
      await opened.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  async function listen(broker: NodeBroker): Promise<string> {
    running.push(broker);
    await new Promise<void>((resolve) => broker.server.listen(0, '127.0.0.1', resolve));
    const { port } = broker.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  function brokerFor(
    plugins: readonly PluginDefinition[],
    overrides: { closeDatabase?: () => Promise<void> } = {},
  ): NodeBroker {
    return createNodeServer(plugins, {
      executor: opened.executor,
      log,
      ...overrides,
    });
  }

  it('1: 503 before bootstrap, the id after, ready 200, and 503 once the table is dropped', async () => {
    const { plugin } = brokerPlugin('whoami');
    const broker = brokerFor([plugin]);
    const base = await listen(broker);
    await broker.ready();

    const before = await fetch(`${base}/whoami`);
    expect(before.status).toBe(503);
    expect(await errorCode(before)).toBe('not_bootstrapped');

    const id = await bootstrapOrganization(opened.executor);

    const after = await fetch(`${base}/whoami`);
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual({ org: id });

    const ready = await fetch(`${base}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ready' });

    await opened.executor.all({ sql: 'DROP TABLE organization', params: [] });

    const notReady = await fetch(`${base}/health/ready`);
    expect(notReady.status).toBe(503);
    expect(await errorCode(notReady)).toBe('not_ready');
  });

  it('2: rejects ready() and answers 500 without reporting an unhandled rejection when init fails', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const plugin: PluginDefinition = {
        id: 'broken',
        package: '@test/broken',
        apiVersion: SUPPORTED_PLUGIN_API[0],
        platforms: ['node'],
        init() {
          throw new Error('init failed');
        },
      };
      const broker = brokerFor([plugin]);
      const base = await listen(broker);

      await expect(broker.ready()).rejects.toThrow('init failed');

      const response = await fetch(`${base}/whoami`);
      expect(response.status).toBe(500);
      expect(await errorCode(response)).toBe('internal');

      await broker.close();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('3: close() stops a listening server and calls closeDatabase once', async () => {
    const closeDatabase = vi.fn(async (): Promise<void> => undefined);
    const { plugin } = brokerPlugin('whoami');
    const broker = brokerFor([plugin], { closeDatabase });
    const base = await listen(broker);
    await broker.ready();
    expect((await fetch(`${base}/health/live`)).status).toBe(200);

    await broker.close();

    expect(closeDatabase).toHaveBeenCalledTimes(1);
    expect(broker.server.listening).toBe(false);
    await expect(fetch(`${base}/health/live`)).rejects.toThrow();
  });

  it('4: hands a POST body to the route unchanged', async () => {
    const { plugin } = brokerPlugin('whoami');
    const broker = brokerFor([plugin]);
    const base = await listen(broker);
    await bootstrapOrganization(opened.executor);
    const body = 'line one\nline two\n{"json":true,"empty":""}';

    const response = await fetch(`${base}/echo`, { method: 'POST', body });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(body);
  });

  it('10: a POST whose body the handler reads completes once at info with its status', async () => {
    const { plugin } = brokerPlugin('whoami');
    const entries: Array<Readonly<Record<string, unknown>>> = [];
    const broker = createNodeServer([plugin], {
      executor: opened.executor,
      log: (entry) => {
        entries.push(entry);
      },
    });
    const base = await listen(broker);
    await bootstrapOrganization(opened.executor);
    const body = 'x'.repeat(256 * 1024);

    const response = await fetch(`${base}/echo`, { method: 'POST', body });
    expect(await response.text()).toBe(body);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const completions = entries.filter((entry) => entry['event'] === 'http.request');
    expect(completions).toEqual([
      expect.objectContaining({ level: 'info', status: 200, method: 'POST', route: '/echo' }),
    ]);
    expect(JSON.stringify(entries)).not.toContain('request.aborted');
  });

  it('5: exposes exactly one own key, get, on the organizations port', async () => {
    const { plugin, ports } = brokerPlugin('whoami');
    const broker = brokerFor([plugin]);
    await broker.ready();

    expect(ports).toHaveLength(1);
    expect(Object.keys(ports[0]!.organizations)).toEqual(['get']);
    expect(Object.getOwnPropertySymbols(ports[0]!.organizations)).toEqual([]);
  });

  it('6: without an executor every kernel database call fails as an internal error', async () => {
    const { plugin } = brokerPlugin('whoami');
    const logs: Array<Readonly<Record<string, unknown>>> = [];
    const broker = createNodeServer([plugin], { log: (entry) => logs.push(entry) });
    const base = await listen(broker);

    const response = await fetch(`${base}/whoami`);

    expect(response.status).toBe(500);
    expect(await errorCode(response)).toBe('internal');
    expect(logs.some((entry) => entry['level'] === 'error')).toBe(true);
  });

  it('7: hands plugins a frozen ports object and a frozen organizations port', async () => {
    const { plugin, ports } = brokerPlugin('whoami');
    const broker = brokerFor([plugin]);
    await broker.ready();

    const received = ports[0]!;
    expect(Object.isFrozen(received)).toBe(true);
    expect(Object.isFrozen(received.organizations)).toBe(true);

    const assignable = received.organizations as { get: unknown };
    expect(() => {
      assignable.get = () => undefined;
    }).toThrow(TypeError);
  });

  it('8: close() is idempotent and closes the database only once', async () => {
    const closeDatabase = vi.fn(async (): Promise<void> => undefined);
    const { plugin } = brokerPlugin('whoami');
    const broker = brokerFor([plugin], { closeDatabase });
    await listen(broker);
    await broker.ready();

    await broker.close();
    await broker.close();

    expect(closeDatabase).toHaveBeenCalledTimes(1);
    expect(broker.server.listening).toBe(false);
  });

  it('9: closes the database even when server.close reports an error', async () => {
    const closeDatabase = vi.fn(async (): Promise<void> => undefined);
    const { plugin } = brokerPlugin('whoami');
    const broker = brokerFor([plugin], { closeDatabase });
    await listen(broker);

    const failure = new Error('close failed');
    const spy = vi
      .spyOn(broker.server, 'close')
      .mockImplementation((callback?: (error?: Error) => void) => {
        callback?.(failure);
        return broker.server;
      });

    await expect(broker.close()).rejects.toThrow('close failed');
    expect(closeDatabase).toHaveBeenCalledTimes(1);

    spy.mockRestore();
    await new Promise<void>((resolve) => broker.server.close(() => resolve()));
  });
});
