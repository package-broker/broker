import { base64urlDecode } from '@package-broker/core/auth/primitives';
import type { Clock } from '@package-broker/core/ids';
import { isValidSubject } from '@package-broker/core/identity/port';

export type CryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

export type JwtFailure =
  | 'malformed'
  | 'unsupported_alg'
  | 'unknown_kid'
  | 'bad_signature'
  | 'wrong_issuer'
  | 'wrong_audience'
  | 'expired'
  | 'not_yet_valid'
  | 'issued_in_future'
  | 'bad_claim'
  | 'jwks_unavailable';

export class JwtError extends Error {
  readonly failure: JwtFailure;

  constructor(failure: JwtFailure) {
    super(failure);
    this.name = 'JwtError';
    this.failure = failure;
  }
}

export interface KeySource {
  getKey(kid: string): Promise<CryptoKey>;
}

export interface VerifiedClaims {
  readonly iss: string;
  readonly sub: string;
  readonly aud: readonly string[];
  readonly exp: number;
  readonly iat: number;
  readonly nbf: number | null;
  readonly authTime: number | null;
  readonly azp?: string;
  readonly nonce?: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface VerifyJwtInput {
  readonly keys: KeySource;
  readonly issuer: string;
  readonly audience: string;
  readonly clock: Clock;
  readonly skewSeconds?: number;
}

const MAX_TOKEN_LENGTH = 16 * 1024;
const DEFAULT_SKEW_SECONDS = 60;
const MAX_DISTANCE_SECONDS = 315_360_000;
const MIN_MODULUS_BITS = 2048;
const KID_PATTERN = /^[\x21-\x7e]{1,256}$/;
const encoder = new TextEncoder();
const utf8 = new TextDecoder('utf-8', { fatal: true });

function decodeJsonObject(segment: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(utf8.decode(base64urlDecode(segment)));
  } catch {
    throw new JwtError('malformed');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new JwtError('malformed');
  }
  if (Object.hasOwn(value, '__proto__')) {
    throw new JwtError('malformed');
  }
  return value as Record<string, unknown>;
}

interface RsaKeyAlgorithm {
  readonly name?: unknown;
  readonly modulusLength?: unknown;
  readonly hash?: { readonly name?: unknown };
}

function isUsableVerificationKey(key: CryptoKey): boolean {
  const algorithm = key.algorithm as RsaKeyAlgorithm;
  return (
    key.type === 'public' &&
    algorithm.name === 'RSASSA-PKCS1-v1_5' &&
    algorithm.hash?.name === 'SHA-256' &&
    typeof algorithm.modulusLength === 'number' &&
    algorithm.modulusLength >= MIN_MODULUS_BITS &&
    key.usages.includes('verify')
  );
}

async function lookupKey(keys: KeySource, kid: string): Promise<CryptoKey> {
  let key: CryptoKey;
  try {
    key = await keys.getKey(kid);
  } catch (error) {
    const failure = error instanceof JwtError ? error.failure : null;
    throw new JwtError(failure === 'unknown_kid' ? failure : 'jwks_unavailable');
  }
  if (!isUsableVerificationKey(key)) {
    throw new JwtError('jwks_unavailable');
  }
  return key;
}

async function signatureMatches(
  key: CryptoKey,
  signature: Uint8Array,
  signingInput: string,
): Promise<boolean> {
  try {
    return await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      signature,
      encoder.encode(signingInput),
    );
  } catch {
    throw new JwtError('jwks_unavailable');
  }
}

function numericClaim(
  payload: Readonly<Record<string, unknown>>,
  name: string,
  now: number,
  required: boolean,
): number | null {
  const value = payload[name];
  if (value === undefined) {
    if (required) {
      throw new JwtError('bad_claim');
    }
    return null;
  }
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    Math.abs(value - now) > MAX_DISTANCE_SECONDS
  ) {
    throw new JwtError('bad_claim');
  }
  return value;
}

function audienceList(value: unknown, audience: string): readonly string[] {
  const list = typeof value === 'string' ? [value] : value;
  if (
    !Array.isArray(list) ||
    list.length === 0 ||
    !list.every((entry): entry is string => typeof entry === 'string') ||
    !list.includes(audience)
  ) {
    throw new JwtError('wrong_audience');
  }
  return Object.freeze([...list]);
}

function validateClaims(
  payload: Readonly<Record<string, unknown>>,
  input: VerifyJwtInput,
  skew: number,
): VerifiedClaims {
  const now = input.clock.now().getTime() / 1000;
  const { iss, sub } = payload;
  if (typeof iss !== 'string' || iss !== input.issuer) {
    throw new JwtError('wrong_issuer');
  }
  const aud = audienceList(payload.aud, input.audience);
  if (!isValidSubject(sub)) {
    throw new JwtError('bad_claim');
  }
  const exp = numericClaim(payload, 'exp', now, true) as number;
  const iat = numericClaim(payload, 'iat', now, true) as number;
  const nbf = numericClaim(payload, 'nbf', now, false);
  const authTime = numericClaim(payload, 'auth_time', now, false);
  if (exp <= now - skew) {
    throw new JwtError('expired');
  }
  if (nbf !== null && nbf > now + skew) {
    throw new JwtError('not_yet_valid');
  }
  if (iat > now + skew || (authTime !== null && authTime > now + skew)) {
    throw new JwtError('issued_in_future');
  }
  const raw: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [name, value] of Object.entries(payload)) {
    raw[name] = value;
  }
  return {
    iss,
    sub,
    aud,
    exp,
    iat,
    nbf,
    authTime,
    ...(typeof payload.azp === 'string' ? { azp: payload.azp } : {}),
    ...(typeof payload.nonce === 'string' ? { nonce: payload.nonce } : {}),
    raw: Object.freeze(raw),
  };
}

export async function verifyJwt(token: string, input: VerifyJwtInput): Promise<VerifiedClaims> {
  if (input.issuer === '' || input.audience === '') {
    throw new RangeError('issuer and audience must be non-empty');
  }
  const skew = input.skewSeconds ?? DEFAULT_SKEW_SECONDS;
  if (!Number.isFinite(skew) || skew < 0) {
    throw new RangeError('skewSeconds must be a non-negative finite number');
  }
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) {
    throw new JwtError('malformed');
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new JwtError('malformed');
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  const header = decodeJsonObject(encodedHeader);
  if (header.alg !== 'RS256') {
    throw new JwtError('unsupported_alg');
  }
  if (header.crit !== undefined) {
    throw new JwtError('malformed');
  }
  if (
    header.typ !== undefined &&
    !(typeof header.typ === 'string' && header.typ.toUpperCase() === 'JWT')
  ) {
    throw new JwtError('malformed');
  }
  if (typeof header.kid !== 'string' || !KID_PATTERN.test(header.kid)) {
    throw new JwtError('malformed');
  }
  const payload = decodeJsonObject(encodedPayload);
  let signature: Uint8Array;
  try {
    signature = base64urlDecode(encodedSignature);
  } catch {
    throw new JwtError('malformed');
  }
  const key = await lookupKey(input.keys, header.kid);
  if (!(await signatureMatches(key, signature, `${encodedHeader}.${encodedPayload}`))) {
    throw new JwtError('bad_signature');
  }
  return validateClaims(payload, input, skew);
}
