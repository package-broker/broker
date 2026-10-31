import type { MasterKey } from './master-key.js';

export type KeyPurpose =
  | 'credential-encryption'
  | 'login-state'
  | 'npm-login'
  | 'token-pepper'
  | 'password-pepper'
  | 'keyring-verifier';

type Subtle = typeof crypto.subtle;
export type CryptoKey = Awaited<ReturnType<Subtle['importKey']>>;
type DerivedAlgorithm = Parameters<Subtle['deriveKey']>[2];
type DerivedUsages = Parameters<Subtle['deriveKey']>[4];

type AesPurpose = 'credential-encryption' | 'login-state' | 'npm-login';
type HmacPurpose = 'token-pepper' | 'password-pepper' | 'keyring-verifier';

export interface Keyring {
  readonly currentVersion: number;
  readonly versions: readonly number[];
  aesKey(purpose: AesPurpose, version: number): Promise<CryptoKey>;
  hmacKey(purpose: HmacPurpose, version: number): Promise<CryptoKey>;
}

export class UnknownKeyVersionError extends Error {
  readonly version: number;

  constructor(version: number) {
    super(`Master key version ${version} is not loaded`);
    this.name = 'UnknownKeyVersionError';
    this.version = version;
  }
}

const MAX_KEYS = 4;
const KEY_BYTES = 32;
const MAX_VERSION = 999_999;
const AES_PURPOSES: ReadonlySet<string> = new Set([
  'credential-encryption',
  'login-state',
  'npm-login',
]);
const HMAC_PURPOSES: ReadonlySet<string> = new Set([
  'token-pepper',
  'password-pepper',
  'keyring-verifier',
]);
const NO_SALT = new Uint8Array(0);
const encoder = new TextEncoder();

function validate(keys: readonly MasterKey[]): void {
  if (keys.length === 0) throw new TypeError('At least one master key is required');
  if (keys.length > MAX_KEYS) throw new TypeError('At most four master keys are supported');
  let previous = Number.POSITIVE_INFINITY;
  for (const key of keys) {
    if (!Number.isInteger(key.version) || key.version < 1 || key.version > MAX_VERSION) {
      throw new TypeError('Master key version is out of range');
    }
    if (key.bytes.length !== KEY_BYTES) throw new TypeError('Master key must be 32 bytes');
    if (key.version >= previous) {
      throw new TypeError('Master key versions must be unique and descending');
    }
    previous = key.version;
  }
}

function importBase(key: MasterKey): Promise<CryptoKey> {
  const base = crypto.subtle.importKey('raw', key.bytes.slice(), 'HKDF', false, ['deriveKey']);
  base.catch(() => undefined);
  return base;
}

export function createKeyring(keys: readonly MasterKey[]): Keyring {
  validate(keys);
  const versions = keys.map((key) => key.version);
  const bases = new Map(keys.map((key) => [key.version, importBase(key)]));
  const derived = new Map<string, Promise<CryptoKey>>();

  function derive(
    purpose: KeyPurpose,
    version: number,
    algorithm: DerivedAlgorithm,
    usages: DerivedUsages,
  ): Promise<CryptoKey> {
    const base = bases.get(version);
    if (base === undefined) return Promise.reject(new UnknownKeyVersionError(version));
    const id = `${purpose}\u0000${version}`;
    const cached = derived.get(id);
    if (cached !== undefined) return cached;
    const pending = base.then((baseKey) =>
      crypto.subtle.deriveKey(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: NO_SALT,
          info: encoder.encode(`package-broker/v1/${purpose}`),
        },
        baseKey,
        algorithm,
        false,
        usages,
      ),
    );
    derived.set(id, pending);
    pending.catch(() => {
      if (derived.get(id) === pending) derived.delete(id);
    });
    return pending;
  }

  const keyring: Keyring = {
    currentVersion: versions[0] as number,
    versions: Object.freeze([...versions]),
    aesKey(purpose, version) {
      if (!AES_PURPOSES.has(purpose)) {
        return Promise.reject(new TypeError('Purpose is not an AES key purpose'));
      }
      return derive(purpose, version, { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']);
    },
    hmacKey(purpose, version) {
      if (!HMAC_PURPOSES.has(purpose)) {
        return Promise.reject(new TypeError('Purpose is not an HMAC key purpose'));
      }
      return derive(purpose, version, { name: 'HMAC', hash: 'SHA-256', length: 256 }, [
        'sign',
        'verify',
      ]);
    },
  };
  return Object.freeze(keyring);
}
