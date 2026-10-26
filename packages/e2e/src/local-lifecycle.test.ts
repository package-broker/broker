import { access, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { repository, startLocal } from './local.js';

vi.mock('node:net', () => ({
  createServer: () => ({
    listening: true,
    once() {},
    listen(_port: number, _host: string, accept: () => void) {
      accept();
    },
    address: () => ({ port: 12345 }),
    close(accept: () => void) {
      accept();
    },
  }),
}));

const require = createRequire(join(repository, 'packages/runtime-cloudflare/package.json'));
const miniflarePath = require.resolve('miniflare');
const instances: FakeMiniflare[] = [];
let startupError: Error | undefined;
let databaseError: Error | undefined;
let disposalError: Error | undefined;
let disposalGate: Promise<void> | undefined;

class FakeMiniflare {
  readonly ready: Promise<URL>;
  readonly database: string;
  connection: DatabaseSync | undefined;
  readonly dispose = vi.fn(async () => {
    await disposalGate;
    this.connection?.close();
    this.connection = undefined;
    if (disposalError) throw disposalError;
  });

  constructor(readonly options: { resourcePersistencePath: string; port: number }) {
    instances.push(this);
    this.database = join(
      options.resourcePersistencePath,
      'd1/miniflare-D1DatabaseObject/fixture.sqlite',
    );
    this.ready = startupError
      ? Promise.reject(startupError)
      : Promise.resolve(new URL(`http://127.0.0.1:${options.port}`));
  }

  async getD1Database(name: string) {
    expect(name).toBe('DB');
    expect(this.dispose).not.toHaveBeenCalled();
    if (databaseError) throw databaseError;
    if (!this.connection) {
      await mkdir(dirname(this.database), { recursive: true });
      this.connection = new DatabaseSync(this.database);
      this.connection.exec('PRAGMA journal_mode = WAL');
    }
    const connection = this.connection;
    return {
      prepare(sql: string) {
        return {
          bind(...params: (string | number)[]) {
            return { all: async () => ({ results: connection.prepare(sql).all(...params) }) };
          },
        };
      },
    };
  }
}

vi.doMock(miniflarePath, () => ({
  Miniflare: FakeMiniflare,
  convertV4MiniflareOptions: (options: unknown) => options,
}));

afterEach(async () => {
  for (const instance of instances.splice(0)) {
    instance.connection?.close();
    const directory = dirname(instance.options.resourcePersistencePath);
    await rm(directory, { recursive: true, force: true });
  }
  startupError = undefined;
  databaseError = undefined;
  disposalError = undefined;
  disposalGate = undefined;
  vi.unstubAllGlobals();
});

describe('Cloudflare launcher lifecycle', () => {
  it('keeps the same runtime and D1 connection through built migrations and bootstrap', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
    const broker = await startLocal('cloudflare', 'http://127.0.0.1:1234');
    try {
      expect(instances).toHaveLength(1);
      const instance = instances[0]!;
      expect(instance.dispose).not.toHaveBeenCalled();
      // Query through the connection opened before the CLI created the schema and organization.
      const db = await instance.getD1Database('DB');
      const { results } = await db
        .prepare('SELECT id FROM organization WHERE slug = ?')
        .bind('acme')
        .all();
      expect(results).toHaveLength(1);
      expect(
        await broker.read('SELECT COUNT(*) AS count FROM user_account WHERE org_id = ?', [
          String(results[0]!['id']),
        ]),
      ).toEqual([{ count: 1 }]);
      let releaseDisposal!: () => void;
      disposalGate = new Promise<void>((resolve) => {
        releaseDisposal = resolve;
      });
      const firstClose = broker.close();
      const secondClose = broker.close();
      try {
        await expect(
          access(dirname(instance.options.resourcePersistencePath)),
        ).resolves.toBeUndefined();
        expect(instance.connection?.isOpen).toBe(true);
      } finally {
        releaseDisposal();
        await Promise.all([firstClose, secondClose]);
      }
      expect(instance.dispose).toHaveBeenCalledOnce();
      await expect(access(dirname(instance.options.resourcePersistencePath))).rejects.toMatchObject(
        {
          code: 'ENOENT',
        },
      );
    } finally {
      await broker.close();
    }
  });

  it.each([
    ['ready', false],
    ['ready', true],
    ['database', false],
    ['database', true],
  ] as const)(
    'preserves a %s failure when disposal also fails: %s',
    async (stage, failDisposal) => {
      const error = new Error('WorkerStartupFailed');
      if (stage === 'ready') startupError = error;
      else databaseError = error;
      if (failDisposal) disposalError = new Error('WorkerDisposalFailed');
      await expect(startLocal('cloudflare', 'http://127.0.0.1:1234')).rejects.toBe(error);
      if (failDisposal) {
        expect(error.cause).toBeInstanceOf(Error);
        expect((error.cause as Error).message).toBe('LocalCleanupFailed');
        expect((error.cause as Error).cause).toBeInstanceOf(AggregateError);
        expect(((error.cause as Error).cause as AggregateError).errors).toEqual([disposalError]);
      } else expect(error.cause).toBeUndefined();
      expect(instances).toHaveLength(1);
      expect(instances[0]!.dispose).toHaveBeenCalledOnce();
      await expect(
        access(dirname(instances[0]!.options.resourcePersistencePath)),
      ).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );

  it.each(['ready', 'database'] as const)(
    'handles disposal repeating the %s failure',
    async (stage) => {
      const error = new Error('WorkerStartupFailed');
      if (stage === 'ready') startupError = error;
      else databaseError = error;
      disposalError = error;
      await expect(startLocal('cloudflare', 'http://127.0.0.1:1234')).rejects.toBe(error);
      if (stage === 'ready') expect(error.cause).toBeUndefined();
      else {
        expect(error.cause).toBeInstanceOf(Error);
        expect(((error.cause as Error).cause as AggregateError).errors).toEqual([error]);
      }
      expect(instances[0]!.dispose).toHaveBeenCalledOnce();
      await expect(
        access(dirname(instances[0]!.options.resourcePersistencePath)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('reports a normal teardown failure and disposes only once across repeated close calls', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
    const broker = await startLocal('cloudflare', 'http://127.0.0.1:1234');
    const active = instances[instances.length - 1]!;
    disposalError = new Error('WorkerDisposalFailed');
    await expect(broker.close()).rejects.toThrow('LocalCleanupFailed');
    await expect(broker.close()).rejects.toThrow('LocalCleanupFailed');
    expect(active.dispose).toHaveBeenCalledOnce();
    await expect(access(dirname(active.options.resourcePersistencePath))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
