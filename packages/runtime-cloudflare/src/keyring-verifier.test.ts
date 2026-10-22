import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { loadMigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { createD1Executor, type D1DatabaseLike } from './db/d1-executor.js';
import { createSecretCipher, credentialAad } from '@package-broker/core/secrets/cipher';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { readMasterKeys } from '@package-broker/core/secrets/master-key';
import { createWorker } from './index.js';
import type { Env } from './index.js';

const KEY_V1 = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const KEY_V1_OTHER = 'pbmk_v1_YGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn8';
const KEY_V2 = 'pbmk_v2_ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8';
const PUBLIC_URL = 'https://broker.test';

const bindings = Array.from({ length: 16 }, (_, index) => `KVDB${index}`);
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

async function database(applyVerifierMigration = true): Promise<D1DatabaseLike> {
  const binding = bindings[next];
  next += 1;
  if (binding === undefined) throw new Error('out of D1 bindings');
  const db = (await mf.getD1Database(binding)) as unknown as D1DatabaseLike;
  const names = ['0001_init.sql'];
  const sources = await Promise.all(
    names.map(async (name) =>
      loadMigrationSource('core', name, await readFile(join(migrationsDirectory, name), 'utf8')),
    ),
  );
  await migrate(createD1Executor(db), sources, { holder: 'keyring-verifier-test' });
  if (!applyVerifierMigration)
    await createD1Executor(db).all({ sql: 'DROP TABLE keyring_verifier', params: [] });
  return db;
}

function env(db: D1DatabaseLike, overrides: Record<string, string | undefined> = {}): Env {
  const base: Record<string, unknown> = {
    DB: db,
    PB_MASTER_KEY: KEY_V1,
    PB_PUBLIC_URL: PUBLIC_URL,
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete base[name];
    else base[name] = value;
  }
  return base as unknown as Env;
}

async function probe(
  db: D1DatabaseLike,
  overrides: Record<string, string | undefined> = {},
): Promise<{ status: number; text: string; logs: string }> {
  const entries: string[] = [];
  const worker = createWorker([], { log: (entry) => void entries.push(JSON.stringify(entry)) });
  const response = await worker.fetch(
    new Request(`${PUBLIC_URL}/_pb/auth/providers`),
    env(db, overrides),
  );
  return { status: response.status, text: await response.text(), logs: entries.join('\n') };
}

async function versions(db: D1DatabaseLike): Promise<number[]> {
  const rows = await createD1Executor(db).all<{ key_version: number }>({
    sql: 'SELECT key_version FROM keyring_verifier ORDER BY key_version',
    params: [],
  });
  return rows.map((row) => row.key_version);
}

function code(text: string): string {
  return (JSON.parse(text) as { error: { code: string } }).error.code;
}

describe('keyring verification on Miniflare D1', () => {
  it('1: a well-formed key that does not match the stored keyring answers 503 misconfigured without key material', async () => {
    const db = await database();
    expect((await probe(db)).status).toBe(200);

    const result = await probe(db, { PB_MASTER_KEY: KEY_V1_OTHER });

    expect(result.status).toBe(503);
    expect(code(result.text)).toBe('misconfigured');
    expect(result.logs).toContain('version 1');
    for (const fragment of [KEY_V1_OTHER, KEY_V1_OTHER.slice(8), KEY_V1.slice(8)]) {
      expect(result.text).not.toContain(fragment);
      expect(result.logs).not.toContain(fragment);
    }
    expect((await probe(db)).status).toBe(200);
  });

  it('2a: rotation with the previous key still configured passes and records the new version', async () => {
    const db = await database();
    expect((await probe(db)).status).toBe(200);

    const rotated = await probe(db, { PB_MASTER_KEY: KEY_V2, PB_MASTER_KEY_PREVIOUS: KEY_V1 });

    expect(rotated.status).toBe(200);
    expect(await versions(db)).toEqual([1, 2]);
  });

  it('2b: dropping the previous key before the new key was ever recorded fails closed', async () => {
    const db = await database();
    expect((await probe(db)).status).toBe(200);

    const result = await probe(db, { PB_MASTER_KEY: KEY_V2 });

    expect(result.status).toBe(503);
    expect(code(result.text)).toBe('misconfigured');
    expect(await versions(db)).toEqual([1]);
  });

  it('3: first boot records the verifier', async () => {
    const db = await database();
    expect(await versions(db)).toEqual([]);
    expect((await probe(db)).status).toBe(200);
    expect(await versions(db)).toEqual([1]);
  });

  it('4: a database without the verifier table answers 503 misconfigured', async () => {
    const db = await database(false);
    const result = await probe(db);
    expect(result.status).toBe(503);
    expect(code(result.text)).toBe('misconfigured');
    expect(result.logs).toContain('keyring_verifier');
  });

  async function seedCredential(db: D1DatabaseLike, version: number): Promise<void> {
    const aad = credentialAad({ id: `01C${version}`, orgId: '01ORG', kind: 'k' });
    const sealed = await createSecretCipher(
      createKeyring(readMasterKeys({ current: version === 1 ? KEY_V1 : KEY_V2 })),
      'credential-encryption',
    ).seal(new Uint8Array([7]), aad);
    await createD1Executor(db).batch([
      {
        sql: "INSERT OR IGNORE INTO organization (id, slug, name) VALUES ('01ORG', 'acme', 'Acme')",
        params: [],
      },
      {
        sql: `INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES ('01C${version}', '01ORG', 'k', X'${Buffer.from(sealed.ciphertext).toString('hex')}', X'${Buffer.from(sealed.nonce).toString('hex')}', ${version}, '${aad}')`,
        params: [],
      },
    ]);
  }

  it('5: deleting every verifier row on a deployment with credentials answers 503 naming the re-seed switch', async () => {
    const db = await database();
    expect((await probe(db)).status).toBe(200);
    await seedCredential(db, 1);
    await createD1Executor(db).batch([{ sql: 'DELETE FROM keyring_verifier', params: [] }]);

    const result = await probe(db, { PB_MASTER_KEY: KEY_V1_OTHER });

    expect(result.status).toBe(503);
    expect(code(result.text)).toBe('misconfigured');
    expect(result.logs).toContain('PB_KEYRING_RESEED=1');
    expect(result.logs).not.toContain(KEY_V1_OTHER.slice(8));
    expect(await versions(db)).toEqual([]);
  });

  it('6: PB_KEYRING_RESEED=1 records the current key and logs only the key version', async () => {
    const db = await database();
    expect((await probe(db)).status).toBe(200);
    await seedCredential(db, 1);
    await createD1Executor(db).batch([{ sql: 'DELETE FROM keyring_verifier', params: [] }]);

    const result = await probe(db, { PB_KEYRING_RESEED: '1' });

    expect(result.status).toBe(200);
    expect(await versions(db)).toEqual([1]);
    expect(result.logs).toContain('keyring.reseeded');
    expect(result.logs).toContain('"key_version":1');
    expect(result.logs).not.toContain(KEY_V1.slice(8));
    const again = await probe(db, { PB_KEYRING_RESEED: '1' });
    expect(again.status).toBe(200);
    expect(again.logs).not.toContain('keyring.reseeded');
    expect(again.logs).toContain('keyring.reseed_ignored');
  });

  it('7: two first boots with disjoint key versions enroll exactly one', async () => {
    const db = await database();

    const [first, second] = await Promise.all([
      probe(db, { PB_MASTER_KEY: KEY_V1 }),
      probe(db, { PB_MASTER_KEY: KEY_V2 }),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 503]);
    expect(await versions(db)).toHaveLength(1);
  });

  it('8: dropping a version that a credential row still uses answers 503', async () => {
    const db = await database();
    expect((await probe(db)).status).toBe(200);
    await seedCredential(db, 1);
    expect(
      (await probe(db, { PB_MASTER_KEY: KEY_V2, PB_MASTER_KEY_PREVIOUS: KEY_V1 })).status,
    ).toBe(200);

    const result = await probe(db, { PB_MASTER_KEY: KEY_V2 });

    expect(result.status).toBe(503);
    expect(code(result.text)).toBe('misconfigured');
    expect(result.logs).toContain('version 1');
  });
  it('refuses authenticated re-seed with a wrong master key without recording a verifier', async () => {
    const db = await database();
    await seedCredential(db, 1);
    const result = await probe(db, { PB_MASTER_KEY: KEY_V1_OTHER, PB_KEYRING_RESEED: '1' });
    expect(result.status).toBe(503);
    expect(await versions(db)).toEqual([]);
  });
});
