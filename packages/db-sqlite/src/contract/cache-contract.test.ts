import { describe, expect, it } from 'vitest';
import type {
  BoundCacheKey,
  Cache,
  CacheEnvelope,
  CacheEventCode,
  EpochReader,
  ScopedCache,
} from '@package-broker/core/platform/cache';
import { createScopedCache } from '@package-broker/core/platform/cache';
import {
  describeCacheContract,
  requireFixtureHooks,
  type CacheContractFixture,
} from './cache-contract.js';

const hex = (version: number): string => version.toString(16).toUpperCase().padStart(32, '0');

function memoryFixture(): CacheContractFixture {
  const store = new Map<string, CacheEnvelope>();
  const events: CacheEventCode[] = [];
  const state = { version: 1 as number | null, failOperation: false, failEpoch: false };
  const id = (key: BoundCacheKey): string => key.digest;
  const raw: Cache = {
    get(_ctx, key) {
      if (state.failOperation) {
        state.failOperation = false;
        return Promise.reject(new Error('store down'));
      }
      const entry = store.get(id(key));
      return Promise.resolve(entry === undefined ? null : { entry, state: 'fresh' as const });
    },
    set(_ctx, key, entry) {
      if (state.failOperation) {
        state.failOperation = false;
        return Promise.reject(new Error('store down'));
      }
      store.set(id(key), entry);
      return Promise.resolve();
    },
    delete(_ctx, key) {
      if (state.failOperation) {
        state.failOperation = false;
        return Promise.reject(new Error('store down'));
      }
      store.delete(id(key));
      return Promise.resolve();
    },
  };
  const epoch: EpochReader = {
    read() {
      if (state.failEpoch) {
        state.failEpoch = false;
        return Promise.reject(new Error('epoch down'));
      }
      return Promise.resolve(state.version === null ? null : hex(state.version));
    },
  };
  const scoped = (deploymentId: string) =>
    createScopedCache(raw, epoch, { deploymentId, onEvent: (code) => events.push(code) });
  return {
    cache: scoped('dep-1'),
    forDeployment: scoped,
    async setEpoch(version) {
      state.version = version;
    },
    async failNextOperation() {
      state.failOperation = true;
    },
    failNextEpochRead() {
      state.failEpoch = true;
    },
    corruptStored() {
      for (const [key, entry] of store.entries()) {
        store.set(key, { ...entry, insertedAt: 'not-a-time' });
      }
    },
    rewriteStored(patch) {
      for (const [key, entry] of store.entries()) store.set(key, { ...entry, ...patch });
    },
    events: () => events,
  };
}

describeCacheContract('in-memory stub', async () => memoryFixture());

describe('cache contract harness', () => {
  it('accepts a complete fixture', () => {
    expect(() => requireFixtureHooks(memoryFixture())).not.toThrow();
  });

  it.each(['get', 'set', 'delete', 'currentVersion'] as const)(
    'fails when the cache lacks %s',
    (method) => {
      const fixture = memoryFixture();
      const broken = { ...fixture.cache } as Record<string, unknown>;
      delete broken[method];
      expect(() =>
        requireFixtureHooks({ ...fixture, cache: broken as unknown as ScopedCache }),
      ).toThrow(method);
    },
  );

  it.each([
    'cache',
    'forDeployment',
    'setEpoch',
    'failNextOperation',
    'failNextEpochRead',
    'corruptStored',
    'rewriteStored',
    'events',
  ] as const)('fails rather than skips when the %s hook is missing', (hook) => {
    const fixture: Record<string, unknown> = { ...memoryFixture() };
    delete fixture[hook];
    expect(() => requireFixtureHooks(fixture as unknown as CacheContractFixture)).toThrow(hook);
  });
});
