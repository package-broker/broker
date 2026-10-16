import type { OrgContext } from '@package-broker/core/db/port';
import {
  createScopedCache,
  type BoundCacheKey,
  type Cache,
  type CacheEnvelope,
  type CacheEventCode,
  type EpochReader,
} from '@package-broker/core/platform/cache';
import {
  describeCacheContract,
  type CacheContractFixture,
} from '@package-broker/db-sqlite/contract/cache-contract';
import { createLruCache } from './lru.js';

interface Written {
  readonly ctx: OrgContext;
  readonly key: BoundCacheKey;
  envelope: CacheEnvelope;
}

function fixture(): CacheContractFixture {
  const inner = createLruCache();
  const written = new Map<string, Written>();
  const events: CacheEventCode[] = [];
  let failNext = false;
  let corrupt = false;
  let failEpoch = false;
  let epoch: string | null = null;

  const guard = (): void => {
    if (failNext) {
      failNext = false;
      throw new Error('cache unavailable');
    }
  };

  const raw: Cache = {
    async get(ctx, key) {
      guard();
      const found = await inner.get(ctx, key);
      if (found === null || !corrupt) return found;
      return { ...found, entry: { ...found.entry, freshUntil: 'not a date' } };
    },
    async set(ctx, key, entry) {
      guard();
      written.set(`${ctx.orgId}:${key.digest}`, { ctx, key, envelope: entry });
      await inner.set(ctx, key, entry);
    },
    async delete(ctx, key) {
      guard();
      written.delete(`${ctx.orgId}:${key.digest}`);
      await inner.delete(ctx, key);
    },
  };

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
      corrupt = true;
    },
    rewriteStored: async (patch) => {
      for (const entry of written.values()) {
        entry.envelope = { ...entry.envelope, ...patch };
        await inner.set(entry.ctx, entry.key, entry.envelope);
      }
    },
    events: () => events,
  };
}

describeCacheContract('lru', async () => fixture());
