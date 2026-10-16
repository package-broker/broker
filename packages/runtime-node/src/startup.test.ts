import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SUPPORTED_PLUGIN_API, type PluginDefinition } from '@package-broker/core/plugin';
import { MigrationChecksumError } from '@package-broker/db-sqlite/migrations/runner';
import {
  loadMigrationSource,
  type MigrationSource,
} from '@package-broker/db-sqlite/migrations/source';
import { AlreadyBootstrappedError, startNode } from './startup.js';
import { openBetterSqliteExecutor } from './db/better-sqlite3-executor.js';
import type { NodeBroker } from './index.js';

const recorded = vi.hoisted(() => ({
  closes: [] as string[],
  events: [] as Array<Readonly<Record<string, unknown>>>,
}));

vi.mock('./db/better-sqlite3-executor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./db/better-sqlite3-executor.js')>();
  return {
    ...actual,
    openBetterSqliteExecutor: (path: string, options?: { readonly busyTimeoutMs?: number }) => {
      const opened = actual.openBetterSqliteExecutor(path, options);
      return {
        executor: opened.executor,
        close: async (): Promise<void> => {
          recorded.closes.push(path);
          await opened.close();
        },
      };
    },
  };
});

const require = createRequire(import.meta.url);
const migrationsDirectory = join(
  dirname(require.resolve('@package-broker/db-sqlite/package.json')),
  'migrations',
);

async function canTakeWriteLock(path: string): Promise<boolean> {
  const reopened = openBetterSqliteExecutor(path);
  try {
    await reopened.executor.batch([{ sql: 'SELECT 1', params: [] }]);
    return true;
  } finally {
    await reopened.close();
  }
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { code: string } };
  return body.error.code;
}

function healthyPlugin(): PluginDefinition {
  return {
    id: 'healthy',
    package: '@test/healthy',
    apiVersion: SUPPORTED_PLUGIN_API[0],
    platforms: ['node'],
  };
}

describe('startNode', () => {
  let directory: string;
  const running: NodeBroker[] = [];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'pb-startup-'));
    recorded.closes.length = 0;
    recorded.events.length = 0;
  });

  afterEach(async () => {
    for (const broker of running.splice(0)) await broker.close();
    await rm(directory, { recursive: true, force: true });
  });

  function databasePath(name = 'broker.sqlite'): string {
    return join(directory, name);
  }

  async function initSource(sql?: string): Promise<MigrationSource> {
    const text = sql ?? (await readFile(join(migrationsDirectory, '0001_init.sql'), 'utf8'));
    return loadMigrationSource('core', '0001_init.sql', text);
  }

  async function epochSources(): Promise<MigrationSource[]> {
    return Promise.all(
      ['0003_access_model.sql', '0004_cache_epoch.sql', '0005_admin_permission_topup.sql'].map(
        async (name) =>
          loadMigrationSource(
            'core',
            name,
            await readFile(join(migrationsDirectory, name), 'utf8'),
          ),
      ),
    );
  }

  async function listen(broker: NodeBroker): Promise<string> {
    running.push(broker);
    await new Promise<void>((resolve) => broker.server.listen(0, '127.0.0.1', resolve));
    const { port } = broker.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async function rejection(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => undefined,
      (error: unknown) => error,
    );
  }

  it('1: migrates, bootstraps, resolves ready, and close() closes the database', async () => {
    const path = databasePath();
    const broker = await startNode({
      plugins: [healthyPlugin()],
      migrations: [await initSource(), ...(await epochSources())],
      env: {
        PB_SQLITE_PATH: path,
        PB_ORG_SLUG: 'acme',
        PB_ORG_NAME: 'Acme',
        PB_MASTER_KEY: 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
        PB_PUBLIC_URL: 'http://127.0.0.1',
      },
      log: (event) => {
        recorded.events.push(event);
      },
    });

    const base = await listen(broker);
    const ready = await fetch(`${base}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ready' });

    await broker.close();

    expect(recorded.closes).toEqual([path]);
    expect(
      recorded.events.some(
        (event) => event['level'] === 'info' && event['id'] === 'core:0001_init',
      ),
    ).toBe(true);
    await expect(canTakeWriteLock(path)).resolves.toBe(true);
  });

  it('2: PB_MIGRATE=off leaves a fresh database not ready', async () => {
    const path = databasePath();
    const broker = await startNode({
      plugins: [healthyPlugin()],
      migrations: [],
      env: {
        PB_SQLITE_PATH: path,
        PB_MIGRATE: 'off',
        PB_MASTER_KEY: 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
        PB_PUBLIC_URL: 'http://127.0.0.1',
      },
    });

    const base = await listen(broker);
    const ready = await fetch(`${base}/health/ready`);
    expect(ready.status).toBe(503);
    expect(await errorCode(ready)).toBe('not_ready');
  });

  it('3: an edited applied migration rejects with MigrationChecksumError and closes the database', async () => {
    const path = databasePath();
    const first = await startNode({
      plugins: [],
      migrations: [await initSource(), ...(await epochSources())],
      env: {
        PB_SQLITE_PATH: path,
        PB_ORG_SLUG: 'acme',
        PB_ORG_NAME: 'Acme',
        PB_MASTER_KEY: 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
        PB_PUBLIC_URL: 'http://127.0.0.1',
      },
    });
    await first.close();
    recorded.closes.length = 0;

    const edited = await initSource(`${(await initSource()).sql}\n-- edited\n`);
    const failure = await rejection(
      startNode({
        plugins: [],
        migrations: [edited],
        env: {
          PB_SQLITE_PATH: path,
          PB_MASTER_KEY: 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
          PB_PUBLIC_URL: 'http://127.0.0.1',
        },
      }),
    );

    expect(failure).toBeInstanceOf(MigrationChecksumError);
    expect(recorded.closes).toEqual([path]);
    await expect(canTakeWriteLock(path)).resolves.toBe(true);
  });

  it('4: a restart with another slug rejects AlreadyBootstrappedError', async () => {
    const path = databasePath();
    const first = await startNode({
      plugins: [],
      migrations: [await initSource(), ...(await epochSources())],
      env: {
        PB_SQLITE_PATH: path,
        PB_ORG_SLUG: 'acme',
        PB_ORG_NAME: 'Acme',
        PB_MASTER_KEY: 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
        PB_PUBLIC_URL: 'http://127.0.0.1',
      },
    });
    await first.close();
    recorded.closes.length = 0;

    const failure = await rejection(
      startNode({
        plugins: [],
        migrations: [await initSource(), ...(await epochSources())],
        env: {
          PB_SQLITE_PATH: path,
          PB_ORG_SLUG: 'other',
          PB_ORG_NAME: 'Other',
          PB_MASTER_KEY: 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
          PB_PUBLIC_URL: 'http://127.0.0.1',
        },
      }),
    );

    expect(failure).toBeInstanceOf(AlreadyBootstrappedError);
    expect((failure as AlreadyBootstrappedError).slug).toBe('acme');
    expect(recorded.closes).toEqual([path]);
  });

  it('5: a plugin init failure rejects before listening and closes the database once', async () => {
    const path = databasePath();
    const listenSpy = vi.spyOn(Server.prototype, 'listen');
    try {
      const broken: PluginDefinition = {
        id: 'broken',
        package: '@test/broken',
        apiVersion: SUPPORTED_PLUGIN_API[0],
        platforms: ['node'],
        init() {
          throw new Error('init failed');
        },
      };

      const failure = await rejection(
        startNode({
          plugins: [broken],
          migrations: [await initSource(), ...(await epochSources())],
          env: {
            PB_SQLITE_PATH: path,
            PB_ORG_SLUG: 'acme',
            PB_ORG_NAME: 'Acme',
            PB_MASTER_KEY: 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
            PB_PUBLIC_URL: 'http://127.0.0.1',
          },
        }),
      );

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe('init failed');
      expect(listenSpy).not.toHaveBeenCalled();
      expect(recorded.closes).toEqual([path]);
      await expect(canTakeWriteLock(path)).resolves.toBe(true);
    } finally {
      listenSpy.mockRestore();
    }
  });

  it('6: rejects when only one organization variable is set', async () => {
    const path = databasePath();
    const failure = await rejection(
      startNode({
        plugins: [],
        migrations: [await initSource(), ...(await epochSources())],
        env: {
          PB_SQLITE_PATH: path,
          PB_ORG_SLUG: 'acme',
          PB_MASTER_KEY: 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
          PB_PUBLIC_URL: 'http://127.0.0.1',
        },
      }),
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('PB_ORG_SLUG and PB_ORG_NAME must be set together');
    expect(recorded.closes).toEqual([path]);
  });
});
