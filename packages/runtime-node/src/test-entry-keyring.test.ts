import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KernelConfigError } from '@package-broker/core/kernel/registry';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { parseMasterKey } from '@package-broker/core/secrets/master-key';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { createKeyringVerifierStore } from '@package-broker/db-sqlite/repositories/keyring-verifier';
import {
  openMigratedDatabase,
  type MigratedDatabase,
} from '@package-broker/db-sqlite/testing/migrated-database';
import { createNodeServer, type NodeBroker, type NodeServerOptions } from './index.js';
import { createLocalLoginSeed } from './testing/local-login.js';
import { createNodeServerWithSeams } from './testing/node-server.js';

const captured = vi.hoisted(() => ({
  handler: undefined as ((request: Request) => Response | Promise<Response>) | undefined,
}));
vi.mock('@hono/node-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hono/node-server')>();
  return {
    ...actual,
    getRequestListener: (...args: Parameters<typeof actual.getRequestListener>) => {
      captured.handler = args[0] as (request: Request) => Response | Promise<Response>;
      return actual.getRequestListener(...args);
    },
  };
});

const KEY = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const keyring = createKeyring([parseMasterKey(KEY, 'PB_MASTER_KEY')]);
const ORG = '01ORG';
const USER = '01USER';

describe.each([
  {
    name: 'createNodeServer',
    create: (options: NodeServerOptions) => createNodeServer([], options),
  },
  {
    name: 'createNodeServerWithSeams',
    create: (options: NodeServerOptions) => createNodeServerWithSeams([], options, {}),
  },
])('$name startup keyring verification', ({ create }) => {
  let db: MigratedDatabase;
  let broker: NodeBroker | undefined;

  beforeEach(async () => {
    db = await openMigratedDatabase();
    await createOrganizationBootstrap(db.executor).bootstrap({
      id: ORG,
      slug: 'acme',
      name: 'Acme',
      now: new Date().toISOString(),
    });
    await db.executor.batch([
      {
        sql: 'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
        params: [USER, ORG, 'reader@example.test'],
      },
    ]);
    const { sealed, aad, passwordHash } = await createLocalLoginSeed(db.executor, keyring, {
      orgId: ORG,
      userId: USER,
      credentialId: '01CREDENTIAL',
    });
    await db.executor.batch([
      {
        sql: "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES (?, ?, 'totp', ?, ?, ?, ?)",
        params: ['01CREDENTIAL', ORG, sealed.ciphertext, sealed.nonce, sealed.keyVersion, aad],
      },
      {
        sql: 'INSERT INTO local_login (user_id, org_id, password_hash, totp_credential_id, totp_enabled_at) VALUES (?, ?, ?, ?, ?)',
        params: [USER, ORG, passwordHash, '01CREDENTIAL', new Date().toISOString()],
      },
    ]);
  });

  afterEach(async () => {
    await broker?.close();
    broker = undefined;
    await db.close();
  });

  function boot(options: Partial<NodeServerOptions> = {}): void {
    broker = create({
      executor: db.executor,
      auth: { keyring, publicOrigin: 'https://broker.test', env: {} },
      log: () => undefined,
      ...options,
    });
  }

  it.each([
    { name: 'without a serving gate', options: {} },
    { name: 'with an open serving gate', options: { servingGate: async () => true } },
  ])(
    'refuses an unreadable stored password hash $name with 503 misconfigured',
    async ({ options }) => {
      const unreadable = 'pbkdf2-sha256$unreadable-fixture';
      await db.executor.batch([
        {
          sql: 'UPDATE local_login SET password_hash = ? WHERE org_id = ? AND user_id = ?',
          params: [unreadable, ORG, USER],
        },
      ]);
      boot(options);
      await expect(broker?.ready()).rejects.toBeInstanceOf(KernelConfigError);
      const response = await captured.handler?.(
        new Request('https://broker.test/_pb/auth/providers'),
      );
      if (response === undefined) throw new Error('No request handler captured');
      expect(response.status).toBe(503);
      const body = await response.text();
      expect(JSON.parse(body)).toMatchObject({ error: { code: 'misconfigured' } });
      expect(body).not.toContain(unreadable);
      expect(body).not.toContain(KEY);
    },
  );

  it('verifies the keyring when a closed serving gate opens', async () => {
    let serving = false;
    await db.executor.batch([
      {
        sql: 'UPDATE local_login SET password_hash = ? WHERE org_id = ? AND user_id = ?',
        params: ['pbkdf2-sha256$unreadable-fixture', ORG, USER],
      },
    ]);
    boot({ servingGate: async () => serving });
    await broker?.ready();
    const request = () => captured.handler?.(new Request('https://broker.test/_pb/auth/providers'));
    const blocked = await request();
    expect(blocked?.status).toBe(503);
    expect(await blocked?.json()).toMatchObject({ error: { code: 'not_ready' } });

    serving = true;
    const refused = await request();
    expect(refused?.status).toBe(503);
    expect(await refused?.json()).toMatchObject({ error: { code: 'misconfigured' } });
  });

  it('keeps liveness available and defers reseeding until the serving gate opens', async () => {
    let serving = false;
    await db.executor.batch([{ sql: 'DELETE FROM keyring_verifier', params: [] }]);
    boot({
      servingGate: async () => serving,
      auth: { keyring, publicOrigin: 'https://broker.test', env: { PB_KEYRING_RESEED: '1' } },
    });
    await broker?.ready();
    expect((await captured.handler?.(new Request('https://broker.test/health/live')))?.status).toBe(
      200,
    );
    expect(
      (await captured.handler?.(new Request('https://broker.test/_pb/auth/providers')))?.status,
    ).toBe(503);
    expect(await createKeyringVerifierStore(db.executor).list()).toEqual([]);

    serving = true;
    expect(
      (await captured.handler?.(new Request('https://broker.test/_pb/auth/providers')))?.status,
    ).toBe(200);
    expect(await createKeyringVerifierStore(db.executor).list()).toEqual([
      expect.objectContaining({ version: keyring.currentVersion }),
    ]);
  });

  it.each([undefined, '0', 'true', '1'])(
    'matches production reseeding with PB_KEYRING_RESEED=%s in the supplied environment',
    async (reseed) => {
      await db.executor.batch([{ sql: 'DELETE FROM keyring_verifier', params: [] }]);
      boot({
        auth: { keyring, publicOrigin: 'https://broker.test', env: { PB_KEYRING_RESEED: reseed } },
      });
      if (reseed === '1') {
        await broker?.ready();
        expect(
          (await captured.handler?.(new Request('https://broker.test/_pb/auth/providers')))?.status,
        ).toBe(200);
        expect(await createKeyringVerifierStore(db.executor).list()).toEqual([
          expect.objectContaining({ version: keyring.currentVersion }),
        ]);
      } else {
        await expect(broker?.ready()).rejects.toBeInstanceOf(KernelConfigError);
        expect(await createKeyringVerifierStore(db.executor).list()).toEqual([]);
      }
    },
  );

  it('serves a database seeded with a real password hash', async () => {
    boot();
    await broker?.ready();
    expect(
      (await captured.handler?.(new Request('https://broker.test/_pb/auth/providers')))?.status,
    ).toBe(200);
  });
});
