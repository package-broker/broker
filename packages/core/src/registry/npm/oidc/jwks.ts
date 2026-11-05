import type { PolicyFetch } from '../../../sources/policy-fetch.js';
import { base64url, decodeJson, OidcError, record } from './input.js';

export const OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const UNKNOWN_KID_TTL = 60_000;
const TTL = 600_000;
const MAX_BYTES = 65536;
const TIMEOUT = 5000;
const ALGORITHM = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;
type PublicKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
interface Cache {
  readonly keys: ReadonlyMap<string, PublicKey>;
  readonly loadedAt: number;
}
const cache = new Map<string, Cache>();
const unknownKidRefreshAt = new Map<string, number>();
const pending = new Map<string, Promise<Cache>>();
export function clearJwksCache(): void {
  cache.clear();
  pending.clear();
  unknownKidRefreshAt.clear();
}

async function download(policyFetch: PolicyFetch, now: number): Promise<Cache> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = async (): Promise<Cache> => {
    const response = await policyFetch({
      url: `${OIDC_ISSUER}/.well-known/jwks`,
      method: 'GET',
      headers: { accept: 'application/json' },
      purpose: 'api',
      destinations: [OIDC_ISSUER],
      redirects: 'error',
      maxBytes: MAX_BYTES,
      timeoutMs: TIMEOUT,
      signal: controller.signal,
    });
    if (controller.signal.aborted || response.status !== 200 || !response.body)
      throw new OidcError('jwks_unavailable');
    reader = response.body.getReader();
    const bytes = new Uint8Array(MAX_BYTES);
    let size = 0;
    let ended = false;
    for (let count = 0; count < 1024; count++) {
      const chunk = await reader.read();
      if (chunk.done) {
        ended = true;
        break;
      }
      bytes.set(chunk.value, size);
      size += chunk.value.byteLength;
    }
    if (!ended) throw new OidcError('jwks_unavailable');
    const json = decodeJson(bytes.subarray(0, size));
    if (!record(json) || !Array.isArray(json.keys) || json.keys.length < 1 || json.keys.length > 20)
      throw new OidcError('jwks_unavailable');
    const keys = new Map<string, PublicKey>();
    for (const key of json.keys) {
      if (
        !record(key) ||
        key.kty !== 'RSA' ||
        key.alg !== 'RS256' ||
        key.use !== 'sig' ||
        typeof key.kid !== 'string' ||
        !/^[\x21-\x7e]{1,256}$/.test(key.kid) ||
        typeof key.n !== 'string' ||
        typeof key.e !== 'string' ||
        keys.has(key.kid) ||
        ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'].some((field) => Object.hasOwn(key, field))
      )
        throw new OidcError('jwks_unavailable');
      const n = base64url(key.n, 1024);
      if (n.length < 256 || n[0]! < 128 || key.e !== 'AQAB')
        throw new OidcError('jwks_unavailable');
      keys.set(
        key.kid,
        await crypto.subtle.importKey('jwk', { kty: 'RSA', n: key.n, e: key.e }, ALGORITHM, false, [
          'verify',
        ]),
      );
    }
    return { keys, loadedAt: now };
  };
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new OidcError('jwks_unavailable'));
      }, TIMEOUT);
    });
    return await Promise.race([work(), timeout]);
  } catch {
    throw new OidcError('jwks_unavailable');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
    void reader?.cancel().catch(() => undefined);
  }
}

async function refresh(policyFetch: PolicyFetch, now: number): Promise<Cache> {
  const existing = pending.get(OIDC_ISSUER);
  if (existing) return existing;
  const request = download(policyFetch, now)
    .then((result) => {
      cache.set(OIDC_ISSUER, result);
      return result;
    })
    .finally(() => {
      pending.delete(OIDC_ISSUER);
    });
  pending.set(OIDC_ISSUER, request);
  return request;
}

export async function oidcKey(
  kid: string,
  policyFetch: PolicyFetch,
  now: number,
): Promise<PublicKey | undefined> {
  let entry = cache.get(OIDC_ISSUER);
  if (!entry || now < entry.loadedAt || now - entry.loadedAt >= TTL)
    entry = await refresh(policyFetch, now);
  else if (!entry.keys.has(kid)) {
    const missedAt = unknownKidRefreshAt.get(OIDC_ISSUER);
    if (missedAt !== undefined && now >= missedAt && now - missedAt < UNKNOWN_KID_TTL)
      return undefined;
    entry = await refresh(policyFetch, now);
  }
  if (!entry.keys.has(kid)) unknownKidRefreshAt.set(OIDC_ISSUER, now);
  return entry.keys.get(kid);
}
