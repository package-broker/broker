import { createHmac, hkdfSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createSecretCipher } from './cipher.js';
import { createKeyring } from './keyring.js';
import {
  KeyringMismatchError,
  KeyringStoreUnavailableError,
  KeyringVerifierMissingError,
  KeyringVersionInUseError,
  verifyKeyring,
  type KeyringVerifierStore,
  type StoredVerifier,
} from './keyring-verifier.js';
import type { MasterKey } from './master-key.js';

function masterKey(version: number, start: number): MasterKey {
  return { version, bytes: Uint8Array.from({ length: 32 }, (_, index) => start + index) };
}

const V1 = (): MasterKey => masterKey(1, 0x00);
const V2 = (): MasterKey => masterKey(2, 0x20);
const V1_OTHER = (): MasterKey => masterKey(1, 0x60);
const V2_OTHER = (): MasterKey => masterKey(2, 0x70);

function expectedMac(key: MasterKey): Uint8Array {
  const derived = Buffer.from(
    hkdfSync('sha256', key.bytes, new Uint8Array(0), 'package-broker/v1/keyring-verifier', 32),
  );
  return new Uint8Array(
    createHmac('sha256', derived).update('package-broker/keyring-verifier/v1').digest(),
  );
}

function memoryStore(
  initial: readonly StoredVerifier[] = [],
  used: readonly number[] = [],
): KeyringVerifierStore & { rows: StoredVerifier[] } {
  const rows = [...initial];
  return {
    rows,
    async list() {
      return [...rows].sort((left, right) => right.version - left.version);
    },
    async checkUsedVersions(configured) {
      for (const version of used)
        if (!configured.includes(version)) throw new KeyringVersionInUseError(version);
      return used.length > 0;
    },
    async credentialSamples() {
      return [];
    },
    async enroll(row) {
      if (rows.length > 0) return false;
      rows.push(row);
      return true;
    },
    async add(row) {
      if (rows.some((existing) => existing.version === row.version)) return false;
      rows.push(row);
      return true;
    },
  };
}

async function reject(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('verifyKeyring', () => {
  it('writes the verifier for the current version on an empty store', async () => {
    const store = memoryStore();
    await verifyKeyring(createKeyring([V1()]), store);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.version).toBe(1);
    expect(store.rows[0]?.mac).toEqual(expectedMac(V1()));
  });

  it('passes when the stored verifier matches the current key', async () => {
    const store = memoryStore([{ version: 1, mac: expectedMac(V1()) }]);
    await verifyKeyring(createKeyring([V1()]), store);
    expect(store.rows).toHaveLength(1);
  });

  it('fails closed for a well-formed key that does not match the stored verifier', async () => {
    const store = memoryStore([{ version: 1, mac: expectedMac(V1()) }]);
    const error = await reject(verifyKeyring(createKeyring([V1_OTHER()]), store));
    expect(error).toBeInstanceOf(KeyringMismatchError);
    expect((error as KeyringMismatchError).keyVersion).toBe(1);
    expect(store.rows).toHaveLength(1);
  });

  it('fails closed when the stored mac has the wrong length', async () => {
    const store = memoryStore([{ version: 1, mac: expectedMac(V1()).slice(0, 31) }]);
    expect(await reject(verifyKeyring(createKeyring([V1()]), store))).toBeInstanceOf(
      KeyringMismatchError,
    );
  });

  it('rotation: current plus previous passes on the previous verifier and records the new one', async () => {
    const store = memoryStore([{ version: 1, mac: expectedMac(V1()) }]);
    await verifyKeyring(createKeyring([V2(), V1()]), store);
    expect(store.rows.map((row) => row.version).sort()).toEqual([1, 2]);
    expect(store.rows.find((row) => row.version === 2)?.mac).toEqual(expectedMac(V2()));
  });

  it('rotation: a wrong previous key fails closed and writes nothing', async () => {
    const store = memoryStore([{ version: 1, mac: expectedMac(V1()) }]);
    const error = await reject(verifyKeyring(createKeyring([V2(), V1_OTHER()]), store));
    expect(error).toBeInstanceOf(KeyringMismatchError);
    expect((error as KeyringMismatchError).keyVersion).toBe(1);
    expect(store.rows).toHaveLength(1);
  });

  it('removing the previous key before the new key was ever recorded fails closed', async () => {
    const store = memoryStore([{ version: 1, mac: expectedMac(V1()) }]);
    const error = await reject(verifyKeyring(createKeyring([V2()]), store));
    expect(error).toBeInstanceOf(KeyringMismatchError);
    expect(store.rows).toHaveLength(1);
  });

  it('passes with the new key alone once its verifier is recorded', async () => {
    const store = memoryStore([
      { version: 1, mac: expectedMac(V1()) },
      { version: 2, mac: expectedMac(V2()) },
    ]);
    await verifyKeyring(createKeyring([V2()]), store);
  });

  it('fails closed when the recorded current version belongs to another key', async () => {
    const store = memoryStore([
      { version: 1, mac: expectedMac(V1()) },
      { version: 2, mac: expectedMac(V2()) },
    ]);
    expect(await reject(verifyKeyring(createKeyring([V2_OTHER(), V1()]), store))).toBeInstanceOf(
      KeyringMismatchError,
    );
  });

  it('fails closed when another instance wins the first enrollment with a disjoint key version', async () => {
    const rival = { version: 5, mac: expectedMac(V1_OTHER()) };
    let listed = 0;
    const store: KeyringVerifierStore = {
      async list() {
        listed += 1;
        return listed === 1 ? [] : [rival];
      },
      async checkUsedVersions() {
        return false;
      },
      async credentialSamples() {
        return [];
      },
      async enroll() {
        return false;
      },
      async add() {
        return false;
      },
    };
    expect(await reject(verifyKeyring(createKeyring([V1()]), store))).toBeInstanceOf(
      KeyringMismatchError,
    );
  });

  it('fails closed when the enrollment loser shares a version but not the key', async () => {
    const rival = { version: 1, mac: expectedMac(V1_OTHER()) };
    let listed = 0;
    const store: KeyringVerifierStore = {
      async list() {
        listed += 1;
        return listed === 1 ? [] : [rival];
      },
      async checkUsedVersions() {
        return false;
      },
      async credentialSamples() {
        return [];
      },
      async enroll() {
        return false;
      },
      async add() {
        return false;
      },
    };
    expect(await reject(verifyKeyring(createKeyring([V1()]), store))).toBeInstanceOf(
      KeyringMismatchError,
    );
  });

  it('passes for an enrollment loser whose key matches the winner', async () => {
    const winner = { version: 1, mac: expectedMac(V1()) };
    let listed = 0;
    const store: KeyringVerifierStore = {
      async list() {
        listed += 1;
        return listed === 1 ? [] : [winner];
      },
      async checkUsedVersions() {
        return false;
      },
      async credentialSamples() {
        return [];
      },
      async enroll() {
        return false;
      },
      async add() {
        return false;
      },
    };
    await verifyKeyring(createKeyring([V1()]), store);
  });

  it('enrolls only on an empty store: key-dependent rows without a verifier fail closed naming the re-seed switch', async () => {
    const store = memoryStore([], [1]);
    const error = await reject(verifyKeyring(createKeyring([V1()]), store));
    expect(error).toBeInstanceOf(KeyringVerifierMissingError);
    expect((error as Error).message).toContain('PB_KEYRING_RESEED=1');
    expect((error as KeyringVerifierMissingError).keyVersion).toBe(1);
    expect(store.rows).toEqual([]);
  });

  it('re-seeds the current key on request when key-dependent rows exist and every used version is configured', async () => {
    const store = memoryStore([], [1, 2]);
    const result = await verifyKeyring(createKeyring([V2(), V1()]), store, { reseed: true });
    expect(result).toEqual({ keyVersion: 2, reseeded: true });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.version).toBe(2);
    expect(store.rows[0]?.mac).toEqual(expectedMac(V2()));
  });

  it('re-seed does not bypass a version that rows still use but the configuration dropped', async () => {
    const store = memoryStore([], [1, 2]);
    const error = await reject(verifyKeyring(createKeyring([V2()]), store, { reseed: true }));
    expect(error).toBeInstanceOf(KeyringVersionInUseError);
    expect(store.rows).toEqual([]);
  });

  it('does not report a re-seed when the first boot enrolls on an empty state', async () => {
    const store = memoryStore();
    const result = await verifyKeyring(createKeyring([V1()]), store, { reseed: true });
    expect(result.reseeded).toBe(false);
    expect(store.rows).toHaveLength(1);
  });

  it('re-seed never replaces an existing verifier', async () => {
    const store = memoryStore([{ version: 1, mac: expectedMac(V1()) }], [1]);
    const error = await reject(verifyKeyring(createKeyring([V1_OTHER()]), store, { reseed: true }));
    expect(error).toBeInstanceOf(KeyringMismatchError);
  });

  it('fails closed when the configuration drops a version that key-dependent rows still use', async () => {
    const store = memoryStore(
      [
        { version: 1, mac: expectedMac(V1()) },
        { version: 2, mac: expectedMac(V2()) },
      ],
      [1, 2],
    );
    const error = await reject(verifyKeyring(createKeyring([V2()]), store));
    expect(error).toBeInstanceOf(KeyringVersionInUseError);
    expect((error as KeyringVersionInUseError).keyVersion).toBe(1);
  });

  it('passes when the dropped version is no longer used', async () => {
    const store = memoryStore(
      [
        { version: 1, mac: expectedMac(V1()) },
        { version: 2, mac: expectedMac(V2()) },
      ],
      [2],
    );
    await verifyKeyring(createKeyring([V2()]), store);
  });

  it('carries only the key version and no key material in the error', async () => {
    const store = memoryStore([{ version: 1, mac: expectedMac(V1()) }]);
    const error = (await reject(verifyKeyring(createKeyring([V1_OTHER()]), store))) as Error;
    const text = `${error.name} ${error.message} ${JSON.stringify(error)}`;
    expect(text).toContain('1');
    expect(text).not.toContain(Buffer.from(V1_OTHER().bytes).toString('hex'));
    expect(text).not.toContain(Buffer.from(expectedMac(V1())).toString('hex'));
    expect(text).not.toContain(Buffer.from(expectedMac(V1_OTHER())).toString('hex'));
    expect(text).not.toContain('pbmk_');
  });

  it('the in-use and missing-verifier errors carry only key versions', async () => {
    const missing = (await reject(
      verifyKeyring(createKeyring([V1_OTHER()]), memoryStore([], [1])),
    )) as Error;
    const inUse = (await reject(
      verifyKeyring(
        createKeyring([V2()]),
        memoryStore([{ version: 2, mac: expectedMac(V2()) }], [1]),
      ),
    )) as Error;
    for (const error of [missing, inUse]) {
      const text = `${error.name} ${error.message} ${JSON.stringify(error)}`;
      expect(text).not.toContain(Buffer.from(V1_OTHER().bytes).toString('hex'));
      expect(text).not.toContain(Buffer.from(V2().bytes).toString('hex'));
      expect(text).not.toContain(Buffer.from(expectedMac(V2())).toString('hex'));
      expect(text).not.toContain('pbmk_');
    }
  });

  it('propagates a store failure unchanged', async () => {
    const failure = new KeyringStoreUnavailableError();
    const store: KeyringVerifierStore = {
      async list() {
        throw failure;
      },
      async checkUsedVersions() {
        return false;
      },
      async credentialSamples() {
        return [];
      },
      async enroll() {
        return false;
      },
      async add() {
        return false;
      },
    };
    expect(await reject(verifyKeyring(createKeyring([V1()]), store))).toBe(failure);
  });
  it('authenticates one credential per used version before re-seeding and writes nothing for a wrong previous key', async () => {
    const aad = 'credential/c/org/k';
    const samples = await Promise.all(
      [V2(), V1()].map(async (key) => ({
        sealed: await createSecretCipher(createKeyring([key]), 'credential-encryption').seal(
          new Uint8Array([7]),
          aad,
        ),
        aad,
      })),
    );
    const store = memoryStore([], [1, 2]);
    store.credentialSamples = async () => samples;
    await expect(
      verifyKeyring(createKeyring([V2(), V1_OTHER()]), store, { reseed: true }),
    ).rejects.toMatchObject({ name: 'KeyringMismatchError', keyVersion: 1 });
    expect(store.rows).toEqual([]);
    await expect(
      verifyKeyring(createKeyring([V2(), V1()]), store, { reseed: true }),
    ).resolves.toMatchObject({ reseeded: true });
  });

  it('concurrent re-seeds report only the caller that inserted', async () => {
    const store = memoryStore([], [1]);
    const ignored = vi.fn();
    const results = await Promise.all(
      [1, 2].map(() =>
        verifyKeyring(createKeyring([V1()]), store, {
          reseed: true,
          onReseedIgnored: ignored,
        }),
      ),
    );
    expect(results.filter((result) => result.reseeded)).toHaveLength(1);
    expect(ignored).toHaveBeenCalledExactlyOnceWith(1);
    expect(store.rows).toHaveLength(1);
  });

  it('reports an ignored re-seed switch even when the stored verifier fails verification', async () => {
    const ignored = vi.fn();
    await expect(
      verifyKeyring(
        createKeyring([V1_OTHER()]),
        memoryStore([{ version: 1, mac: expectedMac(V1()) }]),
        { reseed: true, onReseedIgnored: ignored },
      ),
    ).rejects.toBeInstanceOf(KeyringMismatchError);
    expect(ignored).toHaveBeenCalledExactlyOnceWith(1);
  });
});
