import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SUPPORTED_PLUGIN_API, type PluginDefinition } from '@package-broker/core/plugin';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import {
  KeyringMismatchError,
  KeyringVerifierMissingError,
  KeyringVersionInUseError,
  verifyKeyring,
} from '@package-broker/core/secrets/keyring-verifier';
import { readMasterKeys } from '@package-broker/core/secrets/master-key';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import {
  loadMigrationSource,
  type MigrationSource,
} from '@package-broker/db-sqlite/migrations/source';
import { createKeyringVerifierStore } from '@package-broker/db-sqlite/repositories/keyring-verifier';
import { openBetterSqliteExecutor } from './db/better-sqlite3-executor.js';
import type { NodeBroker } from './index.js';
import { startNode } from './startup.js';

const KEY_V1 = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const KEY_V1_OTHER = 'pbmk_v1_YGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn8';
const KEY_V2 = 'pbmk_v2_ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8';

const require = createRequire(import.meta.url);
const migrationsDirectory = join(
  dirname(require.resolve('@package-broker/db-sqlite/package.json')),
  'migrations',
);

async function allMigrations(): Promise<MigrationSource[]> {
  const names = (await readdir(migrationsDirectory)).filter((name) => name.endsWith('.sql')).sort();
  return Promise.all(
    names.map(async (name) =>
      loadMigrationSource('core', name, await readFile(join(migrationsDirectory, name), 'utf8')),
    ),
  );
}

const plugin: PluginDefinition = {
  id: 'healthy',
  package: '@test/healthy',
  apiVersion: SUPPORTED_PLUGIN_API[0],
  platforms: ['node'],
};

describe('startNode keyring verification', () => {
  let directory: string;
  let path: string;
  const running: NodeBroker[] = [];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'pb-keyring-'));
    path = join(directory, 'broker.sqlite');
  });

  afterEach(async () => {
    for (const broker of running.splice(0)) await broker.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function start(
    env: Readonly<Record<string, string>>,
    logs: Array<Readonly<Record<string, unknown>>> = [],
  ): Promise<NodeBroker> {
    const broker = await startNode({
      plugins: [plugin],
      migrations: await allMigrations(),
      env: { PB_SQLITE_PATH: path, PB_PUBLIC_URL: 'http://127.0.0.1', ...env },
      log: (event) => {
        logs.push(event);
      },
    });
    running.push(broker);
    return broker;
  }

  async function verifierVersions(): Promise<number[]> {
    const opened = openBetterSqliteExecutor(path);
    try {
      const rows = await opened.executor.all<{ key_version: number }>({
        sql: 'SELECT key_version FROM keyring_verifier ORDER BY key_version',
        params: [],
      });
      return rows.map((row) => row.key_version);
    } finally {
      await opened.close();
    }
  }

  async function stop(): Promise<void> {
    for (const broker of running.splice(0)) await broker.close();
  }

  it('1: a well-formed key that does not match the stored keyring fails startup without key material', async () => {
    await (await start({ PB_MASTER_KEY: KEY_V1 })).close();
    running.length = 0;
    const logs: Array<Readonly<Record<string, unknown>>> = [];

    const failure = await start({ PB_MASTER_KEY: KEY_V1_OTHER }, logs).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(KeyringMismatchError);
    const text = `${(failure as Error).message} ${JSON.stringify(logs)}`;
    expect(text).toContain('version 1');
    expect(text).not.toContain(KEY_V1_OTHER);
    expect(text).not.toContain(KEY_V1_OTHER.slice(8));
    expect(text).not.toContain(KEY_V1.slice(8));
  });

  it('2a: rotation with the previous key still configured passes and records the new version', async () => {
    await stop();
    await (await start({ PB_MASTER_KEY: KEY_V1 })).close();
    running.length = 0;

    await start({ PB_MASTER_KEY: KEY_V2, PB_MASTER_KEY_PREVIOUS: KEY_V1 });
    await stop();

    expect(await verifierVersions()).toEqual([1, 2]);
  });

  it('2b: dropping the previous key before the new key was ever recorded fails closed', async () => {
    await (await start({ PB_MASTER_KEY: KEY_V1 })).close();
    running.length = 0;

    const failure = await start({ PB_MASTER_KEY: KEY_V2 }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(KeyringMismatchError);
    expect(await verifierVersions()).toEqual([1]);
  });

  it('3: first boot records the verifier and a restart with the same key passes', async () => {
    await (await start({ PB_MASTER_KEY: KEY_V1 })).close();
    running.length = 0;
    expect(await verifierVersions()).toEqual([1]);

    await start({ PB_MASTER_KEY: KEY_V1 });
  });

  async function sql(
    statements: readonly { sql: string; params?: (string | number)[] }[],
  ): Promise<void> {
    const opened = openBetterSqliteExecutor(path);
    try {
      await opened.executor.batch(
        statements.map((item) => ({ sql: item.sql, params: item.params ?? [] })),
      );
    } finally {
      await opened.close();
    }
  }

  const ORG = "INSERT INTO organization (id, slug, name) VALUES ('01ORG', 'acme', 'Acme')";
  const credential = (version: number): { sql: string } => ({
    sql: `INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES ('01C${version}', '01ORG', 'k', X'00', X'000000000000000000000000', ${version}, 'a')`,
  });

  async function failureOf(
    env: Readonly<Record<string, string>>,
    logs: Array<Readonly<Record<string, unknown>>> = [],
  ): Promise<unknown> {
    return start(env, logs).then(
      () => undefined,
      (error: unknown) => error,
    );
  }

  it('4: deleting every verifier row on a deployment with credentials fails closed', async () => {
    await (await start({ PB_MASTER_KEY: KEY_V1 })).close();
    running.length = 0;
    await sql([{ sql: ORG }, credential(1), { sql: 'DELETE FROM keyring_verifier' }]);

    const failure = await failureOf({ PB_MASTER_KEY: KEY_V1_OTHER });

    expect(failure).toBeInstanceOf(KeyringVerifierMissingError);
    expect((failure as Error).message).toContain('PB_KEYRING_RESEED=1');
    expect((failure as Error).message).not.toContain(KEY_V1_OTHER.slice(8));
    expect(await verifierVersions()).toEqual([]);
  });

  it('5: PB_KEYRING_RESEED=1 records the current key once and logs only the key version', async () => {
    await (await start({ PB_MASTER_KEY: KEY_V1 })).close();
    running.length = 0;
    await sql([{ sql: ORG }, credential(1), { sql: 'DELETE FROM keyring_verifier' }]);
    const logs: Array<Readonly<Record<string, unknown>>> = [];

    await (await start({ PB_MASTER_KEY: KEY_V1, PB_KEYRING_RESEED: '1' }, logs)).close();
    running.length = 0;

    expect(await verifierVersions()).toEqual([1]);
    const reseeded = logs.filter((entry) => entry['event'] === 'keyring.reseeded');
    expect(reseeded).toEqual([expect.objectContaining({ key_version: 1 })]);
    expect(JSON.stringify(logs)).not.toContain(KEY_V1.slice(8));

    await (await start({ PB_MASTER_KEY: KEY_V1, PB_KEYRING_RESEED: '1' }, logs)).close();
    running.length = 0;
    expect(logs.filter((entry) => entry['event'] === 'keyring.reseeded')).toHaveLength(1);
  });

  it('6: two first boots with disjoint key versions enroll exactly one and fail the other closed', async () => {
    const preparedMigrations = await allMigrations();
    const prepared = openBetterSqliteExecutor(path);
    await migrate(prepared.executor, preparedMigrations, { holder: 'prepare' });
    await prepared.close();

    const results = await Promise.allSettled([
      start({ PB_MASTER_KEY: KEY_V1, PB_MIGRATE: 'off' }),
      start({ PB_MASTER_KEY: KEY_V2, PB_MIGRATE: 'off' }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((result) => result.status === 'rejected');
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(KeyringMismatchError);
    await stop();
    expect(await verifierVersions()).toHaveLength(1);
  });

  it('7: dropping a version that a credential row still uses fails closed', async () => {
    await (await start({ PB_MASTER_KEY: KEY_V1 })).close();
    running.length = 0;
    await sql([{ sql: ORG }, credential(1)]);
    await (await start({ PB_MASTER_KEY: KEY_V2, PB_MASTER_KEY_PREVIOUS: KEY_V1 })).close();
    running.length = 0;

    const failure = await failureOf({ PB_MASTER_KEY: KEY_V2 });

    expect(failure).toBeInstanceOf(KeyringVersionInUseError);
    expect((failure as KeyringVersionInUseError).keyVersion).toBe(1);
  });

  it('8: an unmigrated database with PB_MIGRATE=off starts not ready and becomes ready once migrated and verified', async () => {
    const logs: Array<Readonly<Record<string, unknown>>> = [];
    const broker = await start({ PB_MASTER_KEY: KEY_V1, PB_MIGRATE: 'off' }, logs);
    await new Promise<void>((resolve) => broker.server.listen(0, '127.0.0.1', resolve));
    const { port } = broker.server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    const early = await fetch(`${base}/health/ready`);
    expect(early.status).toBe(503);
    expect(((await early.json()) as { error: { code: string } }).error.code).toBe('not_ready');
    expect((await fetch(`${base}/_pb/auth/providers`)).status).toBe(503);
    expect((await fetch(`${base}/health/live`)).status).toBe(200);

    const prepared = openBetterSqliteExecutor(path);
    await migrate(prepared.executor, await allMigrations(), { holder: 'late' });
    await prepared.executor.batch([
      {
        sql: "INSERT INTO organization (id, slug, name) VALUES ('01ORG', 'acme', 'Acme')",
        params: [],
      },
      {
        sql: "INSERT INTO cache_epoch (org_id, version) VALUES ('01ORG', hex(randomblob(16)))",
        params: [],
      },
    ]);
    await prepared.close();

    expect((await fetch(`${base}/health/ready`)).status).toBe(200);
    expect(await verifierVersions()).toEqual([1]);
    expect(JSON.stringify(logs)).not.toContain(KEY_V1.slice(8));
  });

  it('9: a verifier that does not match keeps the broker not ready after the late migration', async () => {
    const broker = await start({ PB_MASTER_KEY: KEY_V1, PB_MIGRATE: 'off' });
    await new Promise<void>((resolve) => broker.server.listen(0, '127.0.0.1', resolve));
    const { port } = broker.server.address() as AddressInfo;
    const prepared = openBetterSqliteExecutor(path);
    await migrate(prepared.executor, await allMigrations(), { holder: 'late' });
    await prepared.executor.batch([
      {
        sql: "INSERT INTO organization (id, slug, name) VALUES ('01ORG', 'acme', 'Acme')",
        params: [],
      },
      {
        sql: "INSERT INTO cache_epoch (org_id, version) VALUES ('01ORG', hex(randomblob(16)))",
        params: [],
      },
    ]);
    await verifyKeyring(
      createKeyring(readMasterKeys({ current: KEY_V1_OTHER })),
      createKeyringVerifierStore(prepared.executor),
    );
    await prepared.close();

    expect((await fetch(`http://127.0.0.1:${port}/health/ready`)).status).toBe(503);
    expect((await fetch(`http://127.0.0.1:${port}/_pb/auth/providers`)).status).toBe(503);
  });
});
