import { createSecretCipher, type Sealed } from './cipher.js';
import type { Keyring } from './keyring.js';

export interface StoredVerifier {
  readonly version: number;
  readonly mac: Uint8Array;
}

export interface KeyringVerifierStore {
  list(): Promise<readonly StoredVerifier[]>;
  /** Checks configured versions against installation-wide key-dependent rows; returns whether any exist. */
  checkUsedVersions(configured: readonly number[]): Promise<boolean>;
  /** At most one credential sample per configured version, for authenticated trial decryption. */
  credentialSamples(
    configured: readonly number[],
  ): Promise<readonly { sealed: Sealed; aad: string }[]>;
  /** One atomic statement: stores the row only while the store is empty. Returns whether it stored. */
  enroll(row: StoredVerifier): Promise<boolean>;
  /** Stores the row unless the version already has one; never replaces. */
  add(row: StoredVerifier): Promise<boolean>;
}

export interface VerifyOptions {
  readonly reseed?: boolean;
  readonly onReseedIgnored?: (keyVersion: number) => void;
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

  constructor(keyVersion: number, table?: 'credential' | 'token' | 'local_login') {
    super(
      `Master key version ${keyVersion} is not configured but ${table ?? 'stored rows'} still use it`,
    );
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

export class KeyringPasswordHashUnreadableError extends Error {
  constructor() {
    super('local_login contains an unreadable password hash');
    this.name = 'KeyringPasswordHashUnreadableError';
  }
}

/**
 * A missing verifier requires explicit re-seeding when key-dependent rows exist. Re-seeding
 * authenticates one credential per used version before writing; with no credentials it is blind.
 * Enrollment is atomic, and every caller verifies the winner after a concurrent insertion.
 */
export async function verifyKeyring(
  keyring: Keyring,
  store: KeyringVerifierStore,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  const current = keyring.currentVersion;
  let stored = await store.list();
  let reseeded = false;
  if (stored.length > 0 && options.reseed === true) options.onReseedIgnored?.(current);

  if (stored.length === 0) {
    const used = await store.checkUsedVersions(keyring.versions);
    const row = { version: current, mac: await computeMac(keyring, current) };
    if (used && options.reseed !== true) throw new KeyringVerifierMissingError(current);
    if (used) {
      const cipher = createSecretCipher(keyring, 'credential-encryption');
      for (const sample of await store.credentialSamples(keyring.versions)) {
        try {
          const plaintext = await cipher.open(sample.sealed, sample.aad);
          plaintext.fill(0);
        } catch {
          throw new KeyringMismatchError(sample.sealed.keyVersion);
        }
      }
      reseeded = await store.add(row);
    } else if (await store.enroll(row)) {
      return { keyVersion: current, reseeded: false };
    }
    stored = await store.list();
    if (!reseeded && options.reseed === true && stored.length > 0)
      options.onReseedIgnored?.(current);
  }

  const loaded = await checkLoaded(keyring, stored);
  if (!loaded) throw new KeyringMismatchError(current);
  await store.checkUsedVersions(keyring.versions);
  if (stored.some((row) => row.version === current)) return { keyVersion: current, reseeded };

  await store.add({ version: current, mac: await computeMac(keyring, current) });
  const settled = (await store.list()).filter((row) => row.version === current);
  if (settled.length === 0 || !(await checkLoaded(keyring, settled))) {
    throw new KeyringMismatchError(current);
  }
  return { keyVersion: current, reseeded };
}
