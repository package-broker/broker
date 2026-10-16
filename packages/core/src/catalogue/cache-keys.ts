import type { CatalogueDocKind, ResolvedPackage } from '../db/catalogue.js';
import type { CacheKey, EpochReader } from '../platform/cache.js';
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

// Per-request snapshot: a ScopedCache built from this reader must not outlive the request.
export function boundEpochReader(pkg: ResolvedPackage): EpochReader {
  return { read: () => Promise.resolve(pkg.cacheEpoch) };
}
