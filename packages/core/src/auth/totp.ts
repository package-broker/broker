import { constantTimeEqual } from './primitives.js';

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;

const SECRET_BYTES = 20;
const ISSUER = 'Package Broker';
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const BASE32_PATTERN = /^[A-Z2-7]*$/;
const CODE_PATTERN = /^[0-9]{6}$/;
const DUMMY_SECRET = new Uint8Array(SECRET_BYTES);
const UNMATCHABLE_CODE = '------';
const WINDOW_OFFSETS = [-1, 0, 1] as const;
const encoder = new TextEncoder();
const strictDecoder = new TextDecoder('utf-8', { fatal: true });

export type TotpVerification =
  { readonly ok: true; readonly step: number } | { readonly ok: false };

function assertSecretLength(secret: Uint8Array): void {
  if (secret.length !== SECRET_BYTES) {
    throw new TypeError('TOTP secret must be 20 bytes');
  }
}

export function generateTotpSecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
}

export function base32Encode(bytes: Uint8Array): string {
  let output = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(text: string): Uint8Array {
  if (text.length === 0 || !BASE32_PATTERN.test(text)) {
    throw new TypeError('invalid base32');
  }
  const bytes = new Uint8Array(Math.floor((text.length * 5) / 8));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of text) {
    buffer = (buffer << 5) | BASE32_ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes[index] = (buffer >>> (bits - 8)) & 255;
      index += 1;
      bits -= 8;
    }
    buffer &= (1 << bits) - 1;
  }
  if (base32Encode(bytes) !== text) {
    throw new TypeError('non-canonical base32');
  }
  return bytes;
}

export async function totpCode(secret: Uint8Array, step: number): Promise<string> {
  assertSecretLength(secret);
  if (!Number.isSafeInteger(step) || step < 0) {
    throw new RangeError('step must be a non-negative safe integer');
  }
  const counter = new Uint8Array(8);
  new DataView(counter.buffer).setBigUint64(0, BigInt(step));
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-1' }, false, [
    'sign',
  ]);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter));
  const offset = (mac[mac.length - 1] as number) & 0x0f;
  const binary =
    (((mac[offset] as number) & 0x7f) << 24) |
    ((mac[offset + 1] as number) << 16) |
    ((mac[offset + 2] as number) << 8) |
    (mac[offset + 3] as number);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

export async function verifyTotp(
  secret: Uint8Array,
  code: string,
  nowMs: number,
  lastStep: number | null | undefined,
): Promise<TotpVerification> {
  const secretValid = secret.length === SECRET_BYTES;
  const key = secretValid ? secret : DUMMY_SECRET;
  const stored = lastStep ?? null;
  const presented = CODE_PATTERN.test(code) ? code : UNMATCHABLE_CODE;
  const rawStep = Math.floor(nowMs / (TOTP_PERIOD_SECONDS * 1000));
  const clockStep = Number.isSafeInteger(rawStep + 1) ? rawStep : -1;
  let matched = -1;
  for (const offset of WINDOW_OFFSETS) {
    const step = clockStep + offset;
    const usable = clockStep >= 0 && step >= 0 && secretValid && (stored === null || step > stored);
    const expected = await totpCode(key, Math.max(step, 0));
    if (constantTimeEqual(presented, expected) && usable) {
      matched = Math.max(matched, step);
    }
  }
  return matched >= 0 ? { ok: true, step: matched } : { ok: false };
}

export function provisioningUri(secret: Uint8Array, email: string): string {
  assertSecretLength(secret);
  if (email.length === 0 || email.includes(':')) {
    throw new TypeError('e-mail must be non-empty and must not contain a colon');
  }
  const issuer = encodeURIComponent(ISSUER);
  return (
    `otpauth://totp/${issuer}:${encodeURIComponent(email)}` +
    `?secret=${base32Encode(secret)}&issuer=${issuer}&algorithm=SHA1` +
    `&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`
  );
}

export function encodeTotpEnvelope(userId: string, secret: Uint8Array): Uint8Array {
  assertSecretLength(secret);
  return encoder.encode(JSON.stringify({ u: userId, s: base32Encode(secret) }));
}

export function decodeTotpEnvelope(bytes: Uint8Array, expectedUserId: string): Uint8Array {
  let parsed: unknown;
  try {
    parsed = JSON.parse(strictDecoder.decode(bytes));
  } catch {
    throw new TypeError('invalid TOTP envelope');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('invalid TOTP envelope');
  }
  const keys = Object.keys(parsed).sort();
  const { u, s } = parsed as Record<string, unknown>;
  if (keys.length !== 2 || keys[0] !== 's' || keys[1] !== 'u') {
    throw new TypeError('invalid TOTP envelope');
  }
  if (typeof u !== 'string' || typeof s !== 'string') {
    throw new TypeError('invalid TOTP envelope');
  }
  if (!constantTimeEqual(u, expectedUserId)) {
    throw new TypeError('TOTP envelope belongs to another user');
  }
  const secret = base32Decode(s);
  if (secret.length !== SECRET_BYTES) {
    throw new TypeError('invalid TOTP secret length');
  }
  return secret;
}
