import {
  createScopedCache,
  type CacheEnvelope,
  type CacheEventCode,
  type EpochReader,
} from '@package-broker/core/platform/cache';
import {
  describeCacheContract,
  type CacheContractFixture,
} from '@package-broker/db-sqlite/contract/cache-contract';
import { createCacheApiAdapter, type CacheStorageLike } from './cache-api.js';

interface Stored {
  body: string;
  expires: number;
}

function fixture(): CacheContractFixture {
  const store = new Map<string, Stored>();
  const events: CacheEventCode[] = [];
  let failNext = false;
  let failEpoch = false;
  let epoch: string | null = null;

  const storage: CacheStorageLike = {
    async open() {
      if (failNext) {
        failNext = false;
        throw new Error('cache unavailable');
      }
      return {
        async match(req) {
          const stored = store.get(req.url);
          if (stored === undefined || stored.expires <= Date.now()) return undefined;
          return new Response(stored.body);
        },
        async put(req, res) {
          const maxAge = /max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '');
          store.set(req.url, {
            body: await res.text(),
            expires: Date.now() + Number(maxAge?.[1] ?? 0) * 1000,
          });
        },
        async delete(req) {
          return store.delete(req.url);
        },
      };
    },
  };

  const raw = createCacheApiAdapter(storage);
  const reader: EpochReader = {
    async read() {
      if (failEpoch) {
        failEpoch = false;
        throw new Error('epoch unavailable');
      }
      return epoch;
    },
  };
  const scoped = (deploymentId: string) =>
    createScopedCache(raw, reader, { deploymentId, onEvent: (code) => events.push(code) });

  return {
    cache: scoped('dep-1'),
    forDeployment: scoped,
    setEpoch: (version) => {
      epoch = version === null ? null : String(version);
    },
    failNextOperation: () => {
      failNext = true;
    },
    failNextEpochRead: () => {
      failEpoch = true;
    },
    corruptStored: () => {
      for (const stored of store.values()) stored.body = 'not json';
    },
    rewriteStored: (patch: Partial<CacheEnvelope>) => {
      for (const stored of store.values()) {
        stored.body = JSON.stringify({ ...(JSON.parse(stored.body) as object), ...patch });
      }
    },
    events: () => events,
  };
}

describeCacheContract('cache-api', async () => fixture());
