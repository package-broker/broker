import type { IdentityContext } from '@package-broker/core/identity/port';
import { fetchBounded } from './http.js';
import { type CryptoKey, JwtError, type KeySource } from './jwt.js';

export interface JwksCacheInput {
  readonly url: string;
  readonly ctx: IdentityContext;
  readonly ttlMs?: number;
  readonly graceMs?: number;
  readonly timeoutMs?: number;
}

const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_GRACE_MS = 60 * 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const REFRESH_INTERVAL_MS = 60_000;
const MAX_JWKS_BYTES = 64 * 1024;
const MAX_JWKS_KEYS = 20;
const KID_PATTERN = /^[\x21-\x7e]{1,256}$/;
const MIN_MODULUS_BITS = 2048;
const MAX_MODULUS_BITS = 8192;
const PUBLIC_EXPONENT = [1, 0, 1];
const IMPORT_ALGORITHM = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;

function positiveMs(value: number | undefined, fallback: number, name: string): number {
  const ms = value ?? fallback;
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return ms;
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function parseJwksUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RangeError('url must be absolute');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new RangeError('url must use https');
  }
  return url.href;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAcceptableKey(key: CryptoKey): boolean {
  const algorithm = key.algorithm as {
    readonly modulusLength?: unknown;
    readonly publicExponent?: unknown;
  };
  const { modulusLength, publicExponent } = algorithm;
  return (
    typeof modulusLength === 'number' &&
    modulusLength >= MIN_MODULUS_BITS &&
    modulusLength <= MAX_MODULUS_BITS &&
    publicExponent instanceof Uint8Array &&
    publicExponent.length === PUBLIC_EXPONENT.length &&
    PUBLIC_EXPONENT.every((byte, index) => publicExponent[index] === byte)
  );
}

interface ImportedKey {
  readonly kid: string;
  readonly key: CryptoKey;
  readonly material: string;
}

async function importEntry(entry: unknown): Promise<ImportedKey | null> {
  if (
    !isRecord(entry) ||
    entry.kty !== 'RSA' ||
    (entry.use !== undefined && entry.use !== 'sig') ||
    (entry.alg !== undefined && entry.alg !== 'RS256') ||
    typeof entry.kid !== 'string' ||
    !KID_PATTERN.test(entry.kid) ||
    typeof entry.n !== 'string' ||
    typeof entry.e !== 'string'
  ) {
    return null;
  }
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: entry.n, e: entry.e },
      IMPORT_ALGORITHM,
      false,
      ['verify'],
    );
    return isAcceptableKey(key) ? { kid: entry.kid, key, material: `${entry.n}.${entry.e}` } : null;
  } catch {
    return null;
  }
}

async function parseJwks(json: unknown): Promise<ReadonlyMap<string, CryptoKey> | null> {
  if (!isRecord(json) || !Array.isArray(json.keys) || json.keys.length > MAX_JWKS_KEYS) {
    return null;
  }
  const imported = await Promise.all(json.keys.map(importEntry));
  const seen = new Map<string, ImportedKey>();
  const ambiguous = new Set<string>();
  for (const item of imported) {
    if (item === null) {
      continue;
    }
    const earlier = seen.get(item.kid);
    if (earlier === undefined) {
      seen.set(item.kid, item);
    } else if (earlier.material !== item.material) {
      ambiguous.add(item.kid);
    }
  }
  const keys = new Map<string, CryptoKey>();
  for (const [kid, item] of seen) {
    if (!ambiguous.has(kid)) {
      keys.set(kid, item.key);
    }
  }
  return keys;
}

export function createJwksCache(input: JwksCacheInput): KeySource {
  const url = parseJwksUrl(input.url);
  const ttlMs = positiveMs(input.ttlMs, DEFAULT_TTL_MS, 'ttlMs');
  const graceMs = positiveMs(input.graceMs, DEFAULT_GRACE_MS, 'graceMs');
  const timeoutMs = positiveMs(input.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs');
  const { ctx } = input;

  let keys: ReadonlyMap<string, CryptoKey> | null = null;
  let loadedAt = 0;
  let lastAttempt: { readonly at: number; readonly ok: boolean } | null = null;
  let inflight: Promise<void> | null = null;
  let started = 0;
  let applied = 0;

  const now = (): number => ctx.clock.now().getTime();

  async function download(): Promise<ReadonlyMap<string, CryptoKey> | null> {
    try {
      const { json } = await fetchBounded(
        ctx,
        new Request(url, { method: 'GET', headers: { accept: 'application/json' } }),
        { maxBytes: MAX_JWKS_BYTES, timeoutMs },
      );
      return await parseJwks(json);
    } catch {
      return null;
    }
  }

  async function fetchKeys(): Promise<void> {
    started += 1;
    const sequence = started;
    const parsed = await download();
    if (sequence <= applied) {
      return;
    }
    applied = sequence;
    const finishedAt = now();
    lastAttempt = { at: finishedAt, ok: parsed !== null };
    if (parsed !== null) {
      keys = parsed;
      loadedAt = finishedAt;
    }
  }

  function begin(): Promise<void> {
    const run: Promise<void> = fetchKeys().finally(() => {
      if (inflight === run) {
        inflight = null;
      }
    });
    inflight = run;
    return run;
  }

  function settlesWithinDeadline(work: Promise<void>): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      const settled = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      work.then(settled, settled);
    });
  }

  async function refresh(): Promise<void> {
    const shared = inflight ?? begin();
    if (await settlesWithinDeadline(shared)) {
      return;
    }
    if (inflight === shared) {
      begin();
    }
    const replacement = inflight;
    if (replacement !== null) {
      await settlesWithinDeadline(replacement);
    }
  }

  function age(): number {
    return now() - loadedAt;
  }

  function isFresh(): boolean {
    return keys !== null && age() >= 0 && age() < ttlMs;
  }

  function isServable(): boolean {
    return keys !== null && age() >= 0 && age() < ttlMs + graceMs;
  }

  function attemptedWithin(requireFailure: boolean): boolean {
    if (lastAttempt === null || (requireFailure && lastAttempt.ok)) {
      return false;
    }
    const elapsed = now() - lastAttempt.at;
    return elapsed >= 0 && elapsed < REFRESH_INTERVAL_MS;
  }

  function lookup(kid: string): CryptoKey {
    if (!isServable()) {
      throw new JwtError('jwks_unavailable');
    }
    const key = keys?.get(kid);
    if (key === undefined) {
      throw new JwtError(lastAttempt?.ok === false ? 'jwks_unavailable' : 'unknown_kid');
    }
    return key;
  }

  return {
    async getKey(kid: string): Promise<CryptoKey> {
      if (typeof kid !== 'string' || !KID_PATTERN.test(kid)) {
        throw new JwtError('unknown_kid');
      }
      if (!isFresh()) {
        if (inflight !== null || !attemptedWithin(true)) {
          await refresh();
        }
        return lookup(kid);
      }
      const known = keys?.get(kid);
      if (known !== undefined) {
        return known;
      }
      if (inflight !== null || !attemptedWithin(false)) {
        await refresh();
      }
      return lookup(kid);
    },
  };
}
