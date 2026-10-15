import { UnknownKeyVersionError } from './keyring.js';
import type { CryptoKey, Keyring } from './keyring.js';

const HASH_BYTES = 32;
const HEX_HASH = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();
const DUMMY_SIGNATURE = new Uint8Array(HASH_BYTES);
let dummyKey: Promise<CryptoKey> | undefined;

function fallbackKey(): Promise<CryptoKey> {
  if (dummyKey === undefined) {
    const pending = crypto.subtle.importKey(
      'raw',
      new Uint8Array(HASH_BYTES),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    dummyKey = pending;
    pending.catch(() => {
      if (dummyKey === pending) dummyKey = undefined;
    });
  }
  return dummyKey;
}

function decodeHash(text: unknown): Uint8Array | undefined {
  if (typeof text !== 'string' || !HEX_HASH.test(text)) return undefined;
  const bytes = new Uint8Array(HASH_BYTES);
  for (let index = 0; index < HASH_BYTES; index += 1) {
    bytes[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function pepperKey(keyring: Keyring, version: number): Promise<CryptoKey | undefined> {
  try {
    return await keyring.hmacKey('token-pepper', version);
  } catch (error) {
    if (error instanceof UnknownKeyVersionError) return undefined;
    throw error;
  }
}

export async function hashToken(
  keyring: Keyring,
  version: number,
  canonicalToken: string,
): Promise<string> {
  const key = await keyring.hmacKey('token-pepper', version);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(canonicalToken)));
  let hex = '';
  for (const byte of mac) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

// Callers must run parseToken first; this only compares a hash.
export async function verifyToken(
  keyring: Keyring,
  version: number,
  canonicalToken: string,
  storedHash: string,
): Promise<boolean> {
  const key = await pepperKey(keyring, version);
  const signature = decodeHash(storedHash);
  const data = encoder.encode(String(canonicalToken));
  const accepted = await crypto.subtle.verify(
    'HMAC',
    key ?? (await fallbackKey()),
    signature ?? DUMMY_SIGNATURE,
    data,
  );
  return accepted && key !== undefined && signature !== undefined;
}

export async function dummyVerify(canonicalToken: string): Promise<false> {
  await crypto.subtle.verify(
    'HMAC',
    await fallbackKey(),
    DUMMY_SIGNATURE,
    encoder.encode(String(canonicalToken)),
  );
  return false;
}
