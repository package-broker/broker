import type { CatalogueDocKind, ResolvedPackage } from '../db/catalogue.js';
import {
  createScopedCache,
  type Cache,
  type CacheKey,
  type EpochReader,
  type ScopedCache,
  type ScopedCacheOptions,
} from '../platform/cache.js';
import type { NameEcosystem } from './names.js';

export function catalogueCacheKey(pkg: ResolvedPackage, docKind: CatalogueDocKind): CacheKey {
  return {
    projectId: pkg.projectId,
    sourceId: pkg.sourceId,
    kind: 'metadata',
    resource: `${pkg.ecosystem}/${docKind}/${encodeURIComponent(pkg.packageId)}:${pkg.rev}`,
  };
}

export function catalogueNegativeKey(
  projectId: string,
  sourceId: string,
  ecosystem: NameEcosystem,
  key: string,
): CacheKey {
  return {
    projectId,
    sourceId,
    kind: 'negative',
    resource: `${ecosystem}/${encodeURIComponent(key)}`,
  };
}

// Only for request snapshot key binding; never use this reader to validate a fill.
export function boundEpochReader(pkg: ResolvedPackage): EpochReader {
  return { read: () => Promise.resolve(pkg.cacheEpoch) };
}

/**
 * Request-scoped reads use the resolved epoch; fills validate it against the primary database.
 * Pass pkg.cacheEpoch as expectedVersion when filling.
 */
export function createCatalogueCache(
  raw: Cache,
  pkg: ResolvedPackage,
  liveEpoch: EpochReader,
  options: ScopedCacheOptions,
): ScopedCache {
  const snapshot = createScopedCache(raw, boundEpochReader(pkg), options);
  const live = createScopedCache(raw, liveEpoch, options);
  return { ...snapshot, set: live.set };
}
