import { SecretsConfigError } from '../secrets/master-key.js';
import type { CryptoKey, Keyring } from '../secrets/keyring.js';
import { base64urlDecode, base64urlEncode, constantTimeEqual } from './primitives.js';

export const PBKDF2_MAX_ITERATIONS = 100_000;
export const PASSWORD_ITERATIONS = 100_000;
export const PASSWORD_HASH_PATTERN: RegExp =
  /^pbkdf2-sha256\$i=([1-9][0-9]{3,5})\$v=([1-9][0-9]{0,5})\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/;

export type PasswordProblem = 'too_short' | 'too_long' | 'equals_email' | 'not_well_formed';

const MIN_LENGTH = 12;
const MAX_LENGTH = 128;
const MAX_VERIFY_UNITS = 1_024;
const LONE_SURROGATE = /\p{Surrogate}/u;
const SALT_BYTES = 16;
const HASH_BITS = 256;
const DUMMY_SALT = new Uint8Array(SALT_BYTES);
const encoder = new TextEncoder();

export function passwordProblems(password: string, email: string): PasswordProblem[] {
  const normalized = password.normalize('NFC');
  const length = Array.from(normalized).length;
  const problems: PasswordProblem[] = [];
  if (length < MIN_LENGTH) problems.push('too_short');
  if (length > MAX_LENGTH) problems.push('too_long');
  if (normalized.toLowerCase() === email.normalize('NFC').toLowerCase()) {
    problems.push('equals_email');
  }
  if (LONE_SURROGATE.test(password)) problems.push('not_well_formed');
  return problems;
}

async function derive(
  pepper: CryptoKey,
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const input = await crypto.subtle.sign('HMAC', pepper, encoder.encode(password.normalize('NFC')));
  const base = await crypto.subtle.importKey('raw', input, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt.slice(), iterations },
    base,
    HASH_BITS,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string, keyring: Keyring): Promise<string> {
  if (!acceptable(password)) throw new TypeError('password cannot be hashed');
  const version = keyring.currentVersion;
  const pepper = await keyring.hmacKey('password-pepper', version);
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  const hash = await derive(pepper, password, salt, PASSWORD_ITERATIONS);
  return `pbkdf2-sha256$i=${PASSWORD_ITERATIONS}$v=${version}$${base64urlEncode(salt)}$${base64urlEncode(hash)}`;
}

function acceptable(password: string): boolean {
  return password.length <= MAX_VERIFY_UNITS && !LONE_SURROGATE.test(password);
}

export async function verifyDummy(password: string, keyring: Keyring): Promise<false> {
  const pepper = await keyring.hmacKey('password-pepper', keyring.currentVersion);
  await derive(pepper, acceptable(password) ? password : '', DUMMY_SALT, PASSWORD_ITERATIONS);
  return false;
}

interface Parsed {
  readonly version: number;
  readonly salt: Uint8Array;
  readonly hash: Uint8Array;
}

function parse(encoded: string): Parsed | undefined {
  const match = PASSWORD_HASH_PATTERN.exec(encoded);
  if (match === null) return undefined;
  if (Number(match[1]) !== PASSWORD_ITERATIONS) return undefined;
  try {
    return {
      version: Number(match[2]),
      salt: base64urlDecode(match[3] as string),
      hash: base64urlDecode(match[4] as string),
    };
  } catch {
    return undefined;
  }
}

export async function verifyPassword(
  encoded: string,
  password: string,
  keyring: Keyring,
): Promise<{ readonly ok: boolean; readonly needsRehash: boolean }> {
  const refused = { ok: false, needsRehash: false } as const;
  const parsed = acceptable(password) ? parse(encoded) : undefined;
  if (parsed === undefined || !keyring.versions.includes(parsed.version)) {
    await verifyDummy(password, keyring);
    return refused;
  }
  const pepper = await keyring.hmacKey('password-pepper', parsed.version);
  const derived = await derive(pepper, password, parsed.salt, PASSWORD_ITERATIONS);
  if (!constantTimeEqual(derived, parsed.hash)) return refused;
  return { ok: true, needsRehash: parsed.version < keyring.currentVersion };
}

export async function selfTestPasswordHashing(keyring: Keyring): Promise<void> {
  try {
    const pepper = await keyring.hmacKey('password-pepper', keyring.currentVersion);
    await derive(pepper, 'self-test', DUMMY_SALT, PASSWORD_ITERATIONS);
  } catch {
    throw new SecretsConfigError('malformed', 'PASSWORD_ITERATIONS');
  }
}
