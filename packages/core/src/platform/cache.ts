import type { OrgContext } from '../db/port.js';

export interface CacheKey {
  readonly projectId: string;
  readonly sourceId: string;
  readonly kind: 'metadata' | 'negative';
  readonly resource: string;
}

/**
 * The key a raw Cache adapter receives. `digest` is the final 64-hex value: adapters use it as-is
 * (Worker path `/pb/v1/<digest>`) and never re-derive it.
 */
export interface BoundCacheKey {
  readonly projectId: string;
  readonly sourceId: string;
  readonly kind: 'metadata' | 'negative';
  readonly digest: string;
}

export interface CacheEntry {
  readonly value: Uint8Array;
  readonly freshUntil: string;
  readonly staleUntil: string | null;
  readonly negative: boolean;
}

/** What a raw adapter persists: the entry plus the insertion time stamped by the scoped cache. */
export interface CacheEnvelope extends CacheEntry {
  readonly insertedAt: string;
}

export interface Cache {
  get(
    ctx: OrgContext,
    key: BoundCacheKey,
  ): Promise<{ entry: CacheEnvelope; state: 'fresh' | 'stale' } | null>;
  set(ctx: OrgContext, key: BoundCacheKey, entry: CacheEnvelope): Promise<void>;
  delete(ctx: OrgContext, key: BoundCacheKey): Promise<void>;
}

/** Reads the authoritative cache epoch from the database; resolves null when the row is missing. */
export interface EpochReader {
  read(ctx: OrgContext): Promise<string | null>;
}

export const MAX_ENTRY_BYTES = 1024 * 1024;
export const METADATA_FRESH_SECONDS = 300;
export const METADATA_STALE_SECONDS = 3600;
export const NEGATIVE_FRESH_SECONDS = 30;

export type CacheEventCode =
  | 'cache_hit'
  | 'cache_miss'
  | 'cache_stale'
  | 'invalid_key'
  | 'epoch_error'
  | 'epoch_missing'
  | 'cache_error'
  | 'corrupt_entry'
  | 'fill_discarded'
  | 'fill_refused';

export type UpstreamOutcome =
  | { readonly kind: 'transient' }
  | { readonly kind: 'status'; readonly status: number }
  | { readonly kind: 'policy_removed' };

export interface FillOrigin {
  readonly status: number;
  readonly authenticated: boolean;
  readonly authorized: boolean;
}

export type SetResult = 'stored' | 'discarded' | 'bypassed' | 'refused' | 'error';

export interface ScopedCacheHit {
  readonly entry: CacheEnvelope;
  readonly state: 'fresh' | 'stale';
}

export interface ScopedCache {
  /**
   * Ordering contract (C2): the epoch must be read in the same D1 batch as, or strictly before, the
   * authorized catalogue read, from the primary. Take `version` from `get` (it is returned on a
   * miss too) or from `currentVersion`, run the catalogue read, and pass the same value as
   * `expectedVersion` to `set`.
   */
  get(
    ctx: OrgContext,
    key: CacheKey,
    options?: { readonly upstream?: UpstreamOutcome },
  ): Promise<{ readonly hit: ScopedCacheHit | null; readonly version: string | null }>;
  set(
    ctx: OrgContext,
    key: CacheKey,
    entry: CacheEntry,
    options: { readonly expectedVersion: string; readonly origin: FillOrigin },
  ): Promise<SetResult>;
  delete(ctx: OrgContext, key: CacheKey): Promise<void>;
  currentVersion(ctx: OrgContext): Promise<string | null>;
}

export interface ScopedCacheOptions {
  readonly deploymentId: string;
  readonly now?: () => Date;
  readonly onEvent?: (code: CacheEventCode) => void;
}

const KEY_FIELDS = ['projectId', 'sourceId', 'kind', 'resource'];
const FORBIDDEN_IN_KEY = /^[a-z][a-z0-9+.-]*:\/\/|[?#@]/i;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function assertKey(key: CacheKey): void {
  if (typeof key !== 'object' || key === null) throw new TypeError('invalid cache key');
  const own = Object.keys(key);
  if (own.length !== KEY_FIELDS.length || !KEY_FIELDS.every((f) => own.includes(f))) {
    throw new TypeError('invalid cache key');
  }
  if (key.kind !== 'metadata' && key.kind !== 'negative') throw new TypeError('invalid cache key');
  for (const field of [key.projectId, key.sourceId, key.resource]) {
    if (typeof field !== 'string' || field === '' || FORBIDDEN_IN_KEY.test(field)) {
      throw new TypeError('invalid cache key');
    }
  }
}

async function digestHex(
  scope: { deploymentId: string; orgId: string; epoch: string },
  key: CacheKey,
): Promise<string> {
  assertKey(key);
  for (const field of [scope.deploymentId, scope.orgId, scope.epoch]) {
    if (typeof field !== 'string' || field === '') throw new TypeError('invalid cache scope');
  }
  const tuple = JSON.stringify([
    'pb-cache',
    1,
    scope.deploymentId,
    scope.orgId,
    key.projectId,
    key.sourceId,
    key.kind,
    key.resource,
    scope.epoch,
  ]);
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(tuple)));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function defaultEntry(kind: CacheKey['kind'], value: Uint8Array, now: Date): CacheEntry {
  const at = now.getTime();
  if (kind === 'negative') {
    return {
      value,
      freshUntil: new Date(at + NEGATIVE_FRESH_SECONDS * 1000).toISOString(),
      staleUntil: null,
      negative: true,
    };
  }
  return {
    value,
    freshUntil: new Date(at + METADATA_FRESH_SECONDS * 1000).toISOString(),
    staleUntil: new Date(at + METADATA_STALE_SECONDS * 1000).toISOString(),
    negative: false,
  };
}

function parseTime(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

const MAX_CLOCK_SKEW_MS = 60_000;
const MAX_JSON_DEPTH = 64;

function validEntry(entry: unknown, key: CacheKey): entry is CacheEntry {
  if (typeof entry !== 'object' || entry === null) return false;
  const e = entry as Record<string, unknown>;
  if (!(e.value instanceof Uint8Array) || typeof e.negative !== 'boolean') return false;
  if (e.negative !== (key.kind === 'negative')) return false;
  if (parseTime(e.freshUntil) === null) return false;
  return e.staleUntil === null || parseTime(e.staleUntil) !== null;
}

function validEnvelope(entry: unknown, key: CacheKey, nowMs: number): entry is CacheEnvelope {
  if (!validEntry(entry, key)) return false;
  const inserted = parseTime((entry as { insertedAt?: unknown }).insertedAt);
  return inserted !== null && inserted <= nowMs + MAX_CLOCK_SKEW_MS;
}

function lifetimesAllowed(entry: CacheEntry, nowMs: number): boolean {
  const fresh = parseTime(entry.freshUntil);
  if (fresh === null) return false;
  if (entry.negative) {
    return entry.staleUntil === null && fresh <= nowMs + NEGATIVE_FRESH_SECONDS * 1000;
  }
  const stale = entry.staleUntil === null ? null : parseTime(entry.staleUntil);
  return (
    fresh <= nowMs + METADATA_FRESH_SECONDS * 1000 &&
    (stale === null || stale <= nowMs + METADATA_STALE_SECONDS * 1000)
  );
}

const AUTHORITY = /\/\/([^\s/"'?#@]+)@/g;
const TOKEN_USERNAME = /^[A-Za-z0-9_-]{20,}$/;
const QUERY_PARAM = /[?&;]([A-Za-z0-9_-]+)=([^&#\s"']*)/g;
const CREDENTIAL_PARAMS = new Set([
  'token',
  'access_token',
  'access-token',
  'private_token',
  'api_key',
  'apikey',
  'client_secret',
  'password',
  'sig',
  'signature',
  'jwt',
  'x-amz-signature',
  'x-amz-credential',
  'x-amz-security-token',
  'x-goog-signature',
  'x-goog-credential',
]);
const MIN_PARAM_VALUE = 8;
const TOKEN_PREFIX =
  /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{16,}|(?:AKIA|ASIA)[A-Z0-9]{16})/;
const AUTH_SCHEME = /\b(bearer|basic|token)\s+([A-Za-z0-9._~+/=-]{16,})/gi;

function decodeEscapes(text: string): string {
  return text
    .replace(/\\\//g, '/')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

function tokenShapedUserinfo(userinfo: string): boolean {
  const colon = userinfo.indexOf(':');
  if (colon >= 0) return colon < userinfo.length - 1;
  return TOKEN_PREFIX.test(userinfo) || TOKEN_USERNAME.test(userinfo);
}

function basicCredential(run: string): boolean {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(run)) return false;
  try {
    const decoded = atob(run);
    const colon = decoded.indexOf(':');
    return colon > 0 && colon < decoded.length - 1;
  } catch {
    return false;
  }
}

function credentialShaped(run: string): boolean {
  if (/[.,;:!?]$/.test(run)) return false;
  return /[0-9]/.test(run) || (/[a-z]/.test(run) && /[A-Z]/.test(run));
}

function stringCarriesCredential(text: string): boolean {
  for (const m of text.matchAll(AUTHORITY)) {
    if (tokenShapedUserinfo(m[1] ?? '')) return true;
  }
  const params = new Map<string, string>();
  for (const m of text.matchAll(QUERY_PARAM)) {
    const name = (m[1] ?? '').toLowerCase();
    const value = m[2] ?? '';
    params.set(name, value);
    if (CREDENTIAL_PARAMS.has(name) && value.length >= MIN_PARAM_VALUE) return true;
  }
  if (params.has('awsaccesskeyid') && params.has('signature')) return true;
  if (TOKEN_PREFIX.test(text)) return true;
  for (const m of text.matchAll(AUTH_SCHEME)) {
    const scheme = (m[1] ?? '').toLowerCase();
    const run = m[2] ?? '';
    if (scheme === 'basic' ? basicCredential(run) : credentialShaped(run)) return true;
  }
  return false;
}

function carriesCredential(value: Uint8Array): boolean {
  let text: string;
  try {
    text = decoder.decode(value);
  } catch {
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return stringCarriesCredential(decodeEscapes(text));
  }
  const stack: { node: unknown; depth: number }[] = [{ node: parsed, depth: 0 }];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const { node, depth } = item;
    if (typeof node === 'string') {
      if (stringCarriesCredential(node)) return true;
    } else if (typeof node === 'object' && node !== null) {
      if (depth >= MAX_JSON_DEPTH) return true;
      for (const [k, v] of Array.isArray(node) ? [] : Object.entries(node)) {
        if (stringCarriesCredential(k)) return true;
        stack.push({ node: v, depth: depth + 1 });
      }
      if (Array.isArray(node)) for (const v of node) stack.push({ node: v, depth: depth + 1 });
    }
  }
  return false;
}

function fillAllowed(entry: CacheEntry, origin: FillOrigin | undefined): boolean {
  if (origin === undefined || !origin.authenticated || !origin.authorized) return false;
  if (entry.negative) return origin.status === 404;
  return (origin.status >= 200 && origin.status < 300) || origin.status === 304;
}

export function createScopedCache(
  raw: Cache,
  epoch: EpochReader,
  options: ScopedCacheOptions,
): ScopedCache {
  const deploymentId = options?.deploymentId;
  if (typeof deploymentId !== 'string' || deploymentId === '') {
    throw new TypeError('deploymentId is required');
  }
  const now = options.now ?? (() => new Date());
  const emit = (code: CacheEventCode): void => {
    try {
      options.onEvent?.(code);
    } catch {
      return;
    }
  };

  async function version(ctx: OrgContext): Promise<string | null> {
    let value: string | null;
    try {
      value = await epoch.read(ctx);
    } catch {
      emit('epoch_error');
      return null;
    }
    if (typeof value !== 'string' || value === '') {
      emit('epoch_missing');
      return null;
    }
    return value;
  }

  async function bind(ctx: OrgContext, key: CacheKey, v: string): Promise<BoundCacheKey> {
    const digest = await digestHex({ deploymentId, orgId: ctx.orgId, epoch: v }, key);
    return { projectId: key.projectId, sourceId: key.sourceId, kind: key.kind, digest };
  }

  return {
    currentVersion: version,

    async get(ctx, key, getOptions) {
      try {
        assertKey(key);
      } catch {
        emit('invalid_key');
        return { hit: null, version: null };
      }
      const v = await version(ctx);
      if (v === null) return { hit: null, version: null };
      let found: Awaited<ReturnType<Cache['get']>>;
      try {
        found = await raw.get(ctx, await bind(ctx, key, v));
      } catch {
        emit('cache_error');
        return { hit: null, version: v };
      }
      if (found === null) {
        emit('cache_miss');
        return { hit: null, version: v };
      }
      const at = now().getTime();
      const entry: unknown = found.entry;
      if (!validEnvelope(entry, key, at)) {
        emit('corrupt_entry');
        return { hit: null, version: v };
      }
      const inserted = parseTime(entry.insertedAt) ?? 0;
      const freshCap = (entry.negative ? NEGATIVE_FRESH_SECONDS : METADATA_FRESH_SECONDS) * 1000;
      const fresh = Math.min(parseTime(entry.freshUntil) ?? 0, inserted + freshCap);
      if (fresh > at) {
        emit('cache_hit');
        return { hit: { entry, state: 'fresh' }, version: v };
      }
      const stale = Math.min(
        entry.staleUntil === null ? 0 : (parseTime(entry.staleUntil) ?? 0),
        inserted + METADATA_STALE_SECONDS * 1000,
      );
      if (!entry.negative && stale > at && getOptions?.upstream?.kind === 'transient') {
        emit('cache_stale');
        return { hit: { entry, state: 'stale' }, version: v };
      }
      emit('cache_miss');
      return { hit: null, version: v };
    },

    async set(ctx, key, entry, setOptions) {
      try {
        assertKey(key);
      } catch {
        emit('invalid_key');
        return 'refused';
      }
      const at = now();
      const acceptable =
        validEntry(entry, key) &&
        entry.value.byteLength <= MAX_ENTRY_BYTES &&
        lifetimesAllowed(entry, at.getTime()) &&
        fillAllowed(entry, setOptions?.origin) &&
        !carriesCredential(entry.value);
      if (!acceptable) {
        emit('fill_refused');
        return 'refused';
      }

      const v = await version(ctx);
      if (v === null) return 'bypassed';
      if (v !== setOptions.expectedVersion) {
        emit('fill_discarded');
        return 'discarded';
      }
      try {
        const envelope: CacheEnvelope = { ...entry, insertedAt: at.toISOString() };
        await raw.set(ctx, await bind(ctx, key, v), envelope);
      } catch {
        emit('cache_error');
        return 'error';
      }
      return 'stored';
    },

    async delete(ctx, key) {
      try {
        assertKey(key);
      } catch {
        emit('invalid_key');
        return;
      }
      const v = await version(ctx);
      if (v === null) return;
      try {
        await raw.delete(ctx, await bind(ctx, key, v));
      } catch {
        emit('cache_error');
      }
    },
  };
}
