import type { OrgContext } from '@package-broker/core/db/port';
import {
  MAX_ENTRY_BYTES,
  type BoundCacheKey,
  type Cache,
  type CacheEnvelope,
} from '@package-broker/core/platform/cache';
import type { MetricSink } from '@package-broker/core/platform/metrics';

export interface CacheStorageLike {
  open(name: string): Promise<{
    match(req: Request): Promise<Response | null | undefined>;
    put(req: Request, res: Response): Promise<void>;
    delete(req: Request): Promise<boolean>;
  }>;
}

export interface CacheApiAdapterOptions {
  readonly now?: () => Date;
  readonly metrics?: Pick<MetricSink, 'counter'>;
  /**
   * The named Cache API is a no-op on *.workers.dev, so Miniflare alone proves nothing about it.
   * When given, `put` is handed to the platform and `set` resolves without waiting for it.
   */
  readonly waitUntil?: (promise: Promise<unknown>) => void;
}

export const DEFAULT_CACHE_NAMESPACE = 'pb-metadata-v1';

const KEY_ORIGIN = 'https://cache.invalid/pb/v1/';
const DIGEST = /^[0-9a-f]{64}$/;
const ERROR_LABELS = { outcome: 'error', adapter: 'cache-api' } as const;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

function serialize(entry: CacheEnvelope): string {
  return JSON.stringify({
    v: 1,
    freshUntil: entry.freshUntil,
    staleUntil: entry.staleUntil,
    negative: entry.negative,
    insertedAt: entry.insertedAt,
    value: toBase64(entry.value),
  });
}

function parseTime(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

export class CacheCorruptError extends Error {
  override readonly name = 'CacheCorruptError';

  constructor() {
    super('stored cache envelope is corrupt');
  }
}

function deserialize(text: string): CacheEnvelope {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new CacheCorruptError();
  }
  if (
    raw === null ||
    typeof raw !== 'object' ||
    raw.v !== 1 ||
    typeof raw.negative !== 'boolean' ||
    typeof raw.value !== 'string' ||
    typeof raw.insertedAt !== 'string' ||
    parseTime(raw.freshUntil) === null ||
    (raw.staleUntil !== null && parseTime(raw.staleUntil) === null)
  ) {
    throw new CacheCorruptError();
  }
  let value: Uint8Array;
  try {
    value = fromBase64(raw.value);
  } catch {
    throw new CacheCorruptError();
  }
  return {
    value,
    freshUntil: raw.freshUntil as string,
    staleUntil: raw.staleUntil as string | null,
    negative: raw.negative,
    insertedAt: raw.insertedAt,
  };
}

function expiresAtMs(entry: CacheEnvelope): number {
  const fresh = parseTime(entry.freshUntil) ?? 0;
  return Math.max(fresh, parseTime(entry.staleUntil ?? entry.freshUntil) ?? 0);
}

export function createCacheApiAdapter(
  storage: CacheStorageLike,
  namespace: string = DEFAULT_CACHE_NAMESPACE,
  options: CacheApiAdapterOptions = {},
): Cache {
  const now = options.now ?? (() => new Date());

  const failed = (): void => {
    try {
      options.metrics?.counter('pb.cache.operations', { ...ERROR_LABELS });
    } catch {
      return;
    }
  };

  const request = (key: BoundCacheKey): Request => {
    if (typeof key?.digest !== 'string' || !DIGEST.test(key.digest)) {
      throw new TypeError('invalid cache digest');
    }
    return new Request(`${KEY_ORIGIN}${key.digest}`, { method: 'GET' });
  };

  const open = () => storage.open(namespace);

  return {
    async get(_ctx: OrgContext, key) {
      const response = await (await open()).match(request(key));
      if (!response) return null;
      const entry = deserialize(await response.text());
      const at = now().getTime();
      if (expiresAtMs(entry) <= at) return null;
      const fresh = parseTime(entry.freshUntil) ?? 0;
      return { entry, state: fresh > at ? 'fresh' : 'stale' };
    },

    async set(_ctx: OrgContext, key, entry) {
      const req = request(key);
      if (entry.value.byteLength > MAX_ENTRY_BYTES) return;
      const ttl = Math.ceil((expiresAtMs(entry) - now().getTime()) / 1000);
      if (ttl <= 0) {
        try {
          await (await open()).delete(req);
        } catch {
          failed();
        }
        return;
      }
      const response = new Response(serialize(entry), {
        headers: {
          'content-type': 'application/json',
          'cache-control': `public, max-age=${ttl}`,
        },
      });
      const put = async (): Promise<void> => {
        await (await open()).put(req, response);
      };
      if (options.waitUntil) options.waitUntil(put().catch(failed));
      else await put();
    },

    async delete(_ctx: OrgContext, key) {
      await (await open()).delete(request(key));
    },
  };
}
