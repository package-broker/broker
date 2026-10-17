import { LOGIN_COOKIE, readCookie, serializeCookie, clearCookie } from './cookies.js';
import { base64urlDecode, base64urlEncode, constantTimeEqual } from './primitives.js';
import { SecretDecryptError } from '../secrets/cipher.js';
import type { SecretCipher } from '../secrets/cipher.js';

export const LOGIN_STATE_MAX_AGE_SECONDS = 600;

export type LoginStateData = Readonly<Record<string, string>>;

export interface LoginState {
  readonly provider: string;
  readonly purpose: 'login' | 'reauth';
  readonly returnTo: string;
  readonly issuedAt: number;
  readonly sessionId: string | null;
  readonly data: LoginStateData;
}

const ENVELOPE_VERSION = 'v1';
const MAX_SET_COOKIE_BYTES = 4000;
const MAX_AGE_MS = LOGIN_STATE_MAX_AGE_SECONDS * 1000;
const MAX_FUTURE_SKEW_MS = 60_000;
const MAX_RETURN_TO_LENGTH = 512;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_VERSION_PATTERN = /^[1-9][0-9]{0,8}$/;
const PROVIDER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const RETURN_TO_PATTERN = /^\/(?![/\\])[\x21-\x7E]*$/;
const PATH_END = /[?#]/;
const DOT_SEGMENT = /^(?:\.|%2e)(?:\.|%2e)?$/i;
const COOKIE_FLAGS = { httpOnly: true, sameSite: 'Lax' } as const;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function hasDotSegment(returnTo: string): boolean {
  const end = returnTo.search(PATH_END);
  const path = end === -1 ? returnTo : returnTo.slice(0, end);
  return path.split('/').some((segment) => DOT_SEGMENT.test(segment));
}

export function safeReturnTo(raw: string | null): string {
  if (
    typeof raw !== 'string' ||
    raw.length > MAX_RETURN_TO_LENGTH ||
    !RETURN_TO_PATTERN.test(raw) ||
    raw.includes('\\') ||
    raw.includes('//') ||
    hasDotSegment(raw)
  ) {
    return '/';
  }
  return raw;
}

function aadFor(provider: string, keyVersion: number): string {
  return `login-state/${provider}/${String(keyVersion)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseData(value: unknown): LoginStateData | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  for (const [, entry] of entries) {
    if (typeof entry !== 'string') return null;
  }
  return Object.fromEntries(entries as [string, string][]);
}

function parseState(value: unknown): LoginState | null {
  if (!isRecord(value)) return null;
  const { provider, purpose, returnTo, issuedAt, sessionId } = value;
  const data = parseData(value['data']);
  if (
    typeof provider !== 'string' ||
    !PROVIDER_PATTERN.test(provider) ||
    (purpose !== 'login' && purpose !== 'reauth') ||
    typeof returnTo !== 'string' ||
    safeReturnTo(returnTo) !== returnTo ||
    typeof issuedAt !== 'number' ||
    !Number.isSafeInteger(issuedAt) ||
    (sessionId !== null && (typeof sessionId !== 'string' || sessionId.length === 0)) ||
    data === null ||
    (purpose === 'reauth' && sessionId === null)
  ) {
    return null;
  }
  return { provider, purpose, returnTo, issuedAt, sessionId, data };
}

export async function sealLoginState(cipher: SecretCipher, state: LoginState): Promise<string> {
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(JSON.stringify(state)) as unknown;
  } catch {
    throw new TypeError('login state is not valid');
  }
  const checked = parseState(snapshot);
  if (checked === null) {
    throw new TypeError('login state is not valid');
  }
  const keyVersion = cipher.currentVersion;
  const plaintext = encoder.encode(JSON.stringify(checked));
  const box = await cipher.seal(plaintext, aadFor(checked.provider, keyVersion));
  if (box.keyVersion !== keyVersion) {
    throw new Error('cipher sealed under a different key version than its current version');
  }
  const joined = new Uint8Array(box.nonce.length + box.ciphertext.length);
  joined.set(box.nonce, 0);
  joined.set(box.ciphertext, box.nonce.length);
  const value = `${ENVELOPE_VERSION}.${String(box.keyVersion)}.${base64urlEncode(joined)}`;
  if (value.length > MAX_SET_COOKIE_BYTES) {
    throw new RangeError('login state cookie exceeds 4000 bytes');
  }
  const setCookie = serializeCookie(LOGIN_COOKIE, value, {
    ...COOKIE_FLAGS,
    maxAgeSeconds: LOGIN_STATE_MAX_AGE_SECONDS,
  });
  if (encoder.encode(setCookie).length > MAX_SET_COOKIE_BYTES) {
    throw new RangeError('login state cookie exceeds 4000 bytes');
  }
  return setCookie;
}

interface Envelope {
  readonly keyVersion: number;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
}

function parseEnvelope(value: string): Envelope | null {
  const parts = value.split('.');
  const [tag, version, body] = parts;
  if (
    parts.length !== 3 ||
    tag !== ENVELOPE_VERSION ||
    version === undefined ||
    body === undefined ||
    !KEY_VERSION_PATTERN.test(version)
  ) {
    return null;
  }
  let bytes: Uint8Array;
  try {
    bytes = base64urlDecode(body);
  } catch {
    return null;
  }
  if (bytes.length < NONCE_BYTES + TAG_BYTES) return null;
  return {
    keyVersion: Number(version),
    nonce: bytes.slice(0, NONCE_BYTES),
    ciphertext: bytes.slice(NONCE_BYTES),
  };
}

export async function openLoginState(
  cipher: SecretCipher,
  request: Request,
  expected: { readonly provider: string; readonly sessionId: string | null },
  nowMs: number,
): Promise<LoginState | null> {
  if (!Number.isSafeInteger(nowMs) || !PROVIDER_PATTERN.test(expected.provider)) return null;
  const value = readCookie(request, LOGIN_COOKIE);
  if (value === null) return null;
  const envelope = parseEnvelope(value);
  if (envelope === null) return null;
  let plaintext: Uint8Array;
  try {
    plaintext = await cipher.open(envelope, aadFor(expected.provider, envelope.keyVersion));
  } catch (error) {
    if (error instanceof SecretDecryptError) return null;
    throw error;
  }
  let state: LoginState | null;
  try {
    state = parseState(JSON.parse(decoder.decode(plaintext)) as unknown);
  } catch {
    return null;
  }
  if (state === null || state.provider !== expected.provider) return null;
  if (state.issuedAt < nowMs - MAX_AGE_MS || state.issuedAt > nowMs + MAX_FUTURE_SKEW_MS) {
    return null;
  }
  if (state.purpose === 'reauth') {
    if (
      typeof expected.sessionId !== 'string' ||
      expected.sessionId.length === 0 ||
      state.sessionId === null ||
      !constantTimeEqual(state.sessionId, expected.sessionId)
    ) {
      return null;
    }
  }
  return state;
}

export function clearLoginState(): string {
  return clearCookie(LOGIN_COOKIE, COOKIE_FLAGS);
}
