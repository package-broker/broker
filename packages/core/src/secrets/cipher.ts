import type { Keyring } from './keyring.js';

export interface Sealed {
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly keyVersion: number;
}

export type SecretDecryptProblem =
  'unknown_key_version' | 'bad_nonce' | 'aad_mismatch' | 'authentication_failed';

export class SecretDecryptError extends Error {
  readonly problem: SecretDecryptProblem;

  constructor(problem: SecretDecryptProblem) {
    super(`Secret decryption failed: ${problem}`);
    this.name = 'SecretDecryptError';
    this.problem = problem;
  }
}

export interface SecretCipher {
  readonly currentVersion: number;
  seal(plaintext: Uint8Array, aad: string): Promise<Sealed>;
  open(sealed: Sealed, aad: string): Promise<Uint8Array>;
  needsReseal(sealed: Sealed): boolean;
}

export const CREDENTIAL_KIND_PATTERN: RegExp = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_PLAINTEXT_BYTES = 65_536;
const AES_PURPOSES: ReadonlySet<string> = new Set([
  'credential-encryption',
  'login-state',
  'npm-login',
]);
const LONE_SURROGATE = /\p{Surrogate}/u;
const encoder = new TextEncoder();

function requireAad(aad: string): Uint8Array {
  if (typeof aad !== 'string' || aad.length === 0) {
    throw new TypeError('AAD must be a non-empty string');
  }
  return encoder.encode(aad);
}

export function createSecretCipher(
  keyring: Keyring,
  purpose: 'credential-encryption' | 'login-state' | 'npm-login',
): SecretCipher {
  if (!AES_PURPOSES.has(purpose)) throw new TypeError('Purpose is not an AES key purpose');
  const currentVersion = keyring.currentVersion;

  const cipher: SecretCipher = {
    currentVersion,
    async seal(plaintext, aad) {
      const additionalData = requireAad(aad);
      if (plaintext.length > MAX_PLAINTEXT_BYTES) {
        throw new RangeError('Plaintext exceeds 65536 bytes');
      }
      const key = await keyring.aesKey(purpose, currentVersion);
      const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
      const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce, additionalData, tagLength: TAG_BYTES * 8 },
        key,
        plaintext,
      );
      return { ciphertext: new Uint8Array(encrypted), nonce, keyVersion: currentVersion };
    },
    async open(sealed, aad) {
      const additionalData = requireAad(aad);
      if (sealed.nonce.length !== NONCE_BYTES) throw new SecretDecryptError('bad_nonce');
      if (!keyring.versions.includes(sealed.keyVersion)) {
        throw new SecretDecryptError('unknown_key_version');
      }
      if (sealed.ciphertext.length < TAG_BYTES) {
        throw new SecretDecryptError('authentication_failed');
      }
      try {
        const key = await keyring.aesKey(purpose, sealed.keyVersion);
        const decrypted = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: sealed.nonce, additionalData, tagLength: TAG_BYTES * 8 },
          key,
          sealed.ciphertext,
        );
        return new Uint8Array(decrypted);
      } catch {
        throw new SecretDecryptError('authentication_failed');
      }
    },
    needsReseal(sealed) {
      return sealed.keyVersion < currentVersion;
    },
  };
  return Object.freeze(cipher);
}

export function credentialAad(input: {
  readonly id: string;
  readonly orgId: string;
  readonly kind: string;
}): string {
  for (const part of [input.id, input.orgId, input.kind]) {
    if (
      typeof part !== 'string' ||
      part.length === 0 ||
      part.includes('/') ||
      LONE_SURROGATE.test(part)
    ) {
      throw new TypeError('Credential AAD parts must be non-empty and contain no slash');
    }
  }
  if (!CREDENTIAL_KIND_PATTERN.test(input.kind)) {
    throw new TypeError('Credential kind does not match the allowed pattern');
  }
  return `credential/${input.id}/${input.orgId}/${input.kind}`;
}
