import type { Keyring } from './keyring.js';

export interface StoredVerifier {
  readonly version: number;
  readonly mac: Uint8Array;
}

export interface KeyringVerifierStore {
  list(): Promise<readonly StoredVerifier[]>;
  /** Distinct key versions that key-dependent rows (credentials, token hashes, password hashes) still use. */
  usedVersions(): Promise<readonly number[]>;
  /** One atomic statement: stores the row only while the store is empty. Returns whether it stored. */
  enroll(row: StoredVerifier): Promise<boolean>;
  /** Stores the row unless the version already has one; never replaces. */
  add(row: StoredVerifier): Promise<void>;
}

export interface VerifyOptions {
  readonly reseed?: boolean;
}

export interface VerifyResult {
  readonly keyVersion: number;
  readonly reseeded: boolean;
}

export const RESEED_VARIABLE = 'PB_KEYRING_RESEED';

export class KeyringMismatchError extends Error {
  readonly keyVersion: number;

  constructor(keyVersion: number) {
    super(`Master key version ${keyVersion} does not match the stored keyring`);
    this.name = 'KeyringMismatchError';
    this.keyVersion = keyVersion;
  }
}

export class KeyringVerifierMissingError extends Error {
  readonly keyVersion: number;

  constructor(keyVersion: number) {
    super(
      `No keyring verifier is stored but key-dependent rows exist; check master key version ${keyVersion} and set ${RESEED_VARIABLE}=1 for one start to record it`,
    );
    this.name = 'KeyringVerifierMissingError';
    this.keyVersion = keyVersion;
  }
}

export class KeyringVersionInUseError extends Error {
  readonly keyVersion: number;

  constructor(keyVersion: number) {
    super(`Master key version ${keyVersion} is not configured but stored rows still use it`);
    this.name = 'KeyringVersionInUseError';
    this.keyVersion = keyVersion;
  }
}

export class KeyringStoreUnavailableError extends Error {
  constructor() {
    super('Keyring verifier store is unavailable; migrations are not applied');
    this.name = 'KeyringStoreUnavailableError';
  }
}

const LABEL = new TextEncoder().encode('package-broker/keyring-verifier/v1');

async function computeMac(keyring: Keyring, version: number): Promise<Uint8Array> {
  const key = await keyring.hmacKey('keyring-verifier', version);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, LABEL));
}

async function matches(keyring: Keyring, row: StoredVerifier): Promise<boolean> {
  const key = await keyring.hmacKey('keyring-verifier', row.version);
  return crypto.subtle.verify('HMAC', key, row.mac.slice(), LABEL);
}

async function checkLoaded(keyring: Keyring, rows: readonly StoredVerifier[]): Promise<boolean> {
  let loaded = false;
  for (const row of rows) {
    if (!keyring.versions.includes(row.version)) continue;
    loaded = true;
    if (!(await matches(keyring, row))) throw new KeyringMismatchError(row.version);
  }
  return loaded;
}

async function assertUsedVersionsLoaded(
  keyring: Keyring,
  store: KeyringVerifierStore,
): Promise<boolean> {
  const used = await store.usedVersions();
  for (const version of [...used].sort((left, right) => left - right)) {
    if (!keyring.versions.includes(version)) throw new KeyringVersionInUseError(version);
  }
  return used.length > 0;
}

/**
 * Decides whether the configured master keys can open the stored keyring without decrypting any
 * secret. Only an empty store on a deployment without key-dependent rows is enrolled on first use;
 * with such rows a missing verifier fails closed unless `reseed` records the current key. Enrollment
 * is one atomic statement, so a concurrent first boot with other keys loses and must verify against
 * the winner. A stored version that is configured must verify; a version that rows still use must
 * be configured.
 */
export async function verifyKeyring(
  keyring: Keyring,
  store: KeyringVerifierStore,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  const current = keyring.currentVersion;
  let stored = await store.list();
  let reseeded = false;

  if (stored.length === 0) {
    const used = await assertUsedVersionsLoaded(keyring, store);
    const row = { version: current, mac: await computeMac(keyring, current) };
    if (used && options.reseed !== true) throw new KeyringVerifierMissingError(current);
    if (used) {
      await store.add(row);
      reseeded = true;
    } else if (await store.enroll(row)) {
      return { keyVersion: current, reseeded: false };
    }
    stored = await store.list();
  }

  const loaded = await checkLoaded(keyring, stored);
  if (!loaded) throw new KeyringMismatchError(current);
  await assertUsedVersionsLoaded(keyring, store);
  if (stored.some((row) => row.version === current)) return { keyVersion: current, reseeded };

  await store.add({ version: current, mac: await computeMac(keyring, current) });
  const settled = (await store.list()).filter((row) => row.version === current);
  if (settled.length === 0 || !(await checkLoaded(keyring, settled))) {
    throw new KeyringMismatchError(current);
  }
  return { keyVersion: current, reseeded };
}
