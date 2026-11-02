import type {
  CatalogueReader,
  CatalogueVersion,
  DistTarget,
  ListedPackage,
  PackageResolution,
  ResolvedPackage,
} from '../db/catalogue.js';

export interface CatalogueEntry {
  pkg: ResolvedPackage;
  versions: CatalogueVersion[];
  tags: Record<string, string>;
  /** The listed identity when it differs from the resolved winner. */
  listedAs?: { packageId: string; sourceId: string };
  description?: string | null;
}

export function catalogueVersion(
  n: number,
  overrides: Partial<CatalogueVersion> = {},
): CatalogueVersion {
  const day = String(1 + (n % 28)).padStart(2, '0');
  const month = String(1 + Math.floor(n / 28)).padStart(2, '0');
  return {
    versionId: `V${String(n).padStart(4, '0')}`,
    revision: 1,
    version: `1.0.${String(n)}`,
    versionNormalized: `1.0.${String(n)}`,
    stability: 'stable',
    status: 'active',
    publishedAt: `2025-${month}-${day}T00:00:00.000Z`,
    upstreamReleasedAt: null,
    license: null,
    distType: 'tgz',
    composerShasum: null,
    npmIntegrity: null,
    deprecatedMessage: null,
    metadataJson: '{}',
    publishedAtBasis: 'release_date',
    createdAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function catalogueEntry(
  count: number,
  key = 'left-pad',
  ecosystem: 'npm' | 'composer' = 'npm',
): CatalogueEntry {
  return {
    pkg: {
      projectId: 'P',
      ecosystem,
      key,
      packageId: key === 'left-pad' ? 'K' : `K-${key}`,
      sourceId: 'S',
      rev: 1,
      modifiedAt: '2025-12-01T00:00:00.000Z',
      createdAt: '2025-01-01T00:00:00.000Z',
      listingComplete: true,
      cacheEpoch: 'e1',
    },
    versions: Array.from({ length: count }, (_, n) => catalogueVersion(n)),
    tags: {},
  };
}

type Lookups = Pick<
  CatalogueReader,
  'resolveVersions' | 'lookupVersion' | 'lookupTag' | 'distTags'
>;

/** An in-memory catalogue with the reader's paging, binding and lookup semantics. */
export function memoryCatalogue(
  entries: CatalogueEntry[],
  options: { openNamespace?: boolean; admissible?: readonly string[] } = {},
) {
  const calls: string[] = [];
  const find = (projectId: string, key: string) =>
    entries.find((entry) => entry.pkg.projectId === projectId && entry.pkg.key === key);
  const sorted = (entry: CatalogueEntry) =>
    [...entry.versions].sort((a, b) =>
      a.publishedAt === b.publishedAt
        ? a.versionId.localeCompare(b.versionId)
        : a.publishedAt.localeCompare(b.publishedAt),
    );
  const reader: Lookups = {
    async resolveVersions(_ctx, query) {
      calls.push(`versions:${query.after?.id ?? 'start'}`);
      const entry = find(query.projectId, query.key);
      const { pkg } = entry ?? {};
      if (
        query.binding !== undefined &&
        (pkg === undefined ||
          pkg.packageId !== query.binding.packageId ||
          pkg.sourceId !== query.binding.sourceId ||
          pkg.rev !== query.binding.rev)
      ) {
        return { changed: true };
      }
      if (entry === undefined || pkg === undefined) return null;
      const after = query.after;
      const rest = sorted(entry).filter(
        (v) =>
          after === undefined ||
          v.publishedAt > after.publishedAt ||
          (v.publishedAt === after.publishedAt && v.versionId > after.id),
      );
      const versions = rest.slice(0, query.limit);
      const last = versions.at(-1);
      const page: PackageResolution = {
        pkg,
        versions,
        next:
          rest.length > versions.length && last
            ? { publishedAt: last.publishedAt, id: last.versionId }
            : null,
        binding: { packageId: pkg.packageId, sourceId: pkg.sourceId, rev: pkg.rev },
      };
      return page;
    },
    async lookupVersion(_ctx, query) {
      calls.push(`version:${query.versionNormalized}`);
      const entry = find(query.projectId, query.key);
      const version = entry?.versions.find((v) => v.versionNormalized === query.versionNormalized);
      return entry && version ? { pkg: entry.pkg, version } : null;
    },
    async lookupTag(_ctx, query) {
      calls.push(`tag:${query.tag}`);
      const entry = find(query.projectId, query.key);
      const id = entry?.tags[query.tag];
      const version = entry?.versions.find((v) => v.versionId === id);
      return entry && version ? { pkg: entry.pkg, version } : null;
    },
    async distTags(_ctx, query) {
      calls.push('dist-tags');
      const entry = find(query.projectId, query.key);
      if (entry === undefined) return null;
      const tags = Object.create(null) as Record<string, string>;
      for (const [tag, id] of Object.entries(entry.tags)) {
        const version = entry.versions.find((v) => v.versionId === id);
        if (version) tags[tag] = version.version;
      }
      return { pkg: entry.pkg, tags };
    },
  };
  const unused = async (): Promise<never> => {
    throw new Error('not used by the policy facade tests');
  };
  const listed = (entry: CatalogueEntry): ListedPackage => ({
    key: entry.pkg.key,
    packageId: entry.listedAs?.packageId ?? entry.pkg.packageId,
    sourceId: entry.listedAs?.sourceId ?? entry.pkg.sourceId,
    description: entry.description ?? null,
  });
  const inProject = (projectId: string, ecosystem: string) =>
    entries
      .filter((entry) => entry.pkg.projectId === projectId && entry.pkg.ecosystem === ecosystem)
      .sort((a, b) => a.pkg.key.localeCompare(b.pkg.key));
  const full: CatalogueReader = {
    ...reader,
    async listVisible(_ctx, query) {
      calls.push(`list:${query.after ?? 'start'}`);
      const rest = inProject(query.projectId, query.ecosystem).filter(
        (entry) => query.after === undefined || entry.pkg.key > query.after,
      );
      const page = rest.slice(0, query.limit);
      return {
        items: page.map(listed),
        next: rest.length > page.length ? page.at(-1)!.pkg.key : null,
        openNamespace: options.openNamespace ?? false,
      };
    },
    async search(_ctx, query) {
      calls.push(`search:${query.text}`);
      return inProject(query.projectId, query.ecosystem)
        .filter((entry) => entry.pkg.key.includes(query.text))
        .slice(0, query.limit)
        .map(listed);
    },
    async resolveDist(_ctx, query) {
      calls.push(
        `dist:${query.by === 'id' ? `${query.versionId}.${String(query.revision)}` : query.versionNormalized}`,
      );
      const entry = find(query.projectId, query.key);
      const version = entry?.versions.find((v) =>
        query.by === 'id'
          ? v.versionId === query.versionId && v.revision === query.revision
          : v.versionNormalized === query.versionNormalized,
      );
      if (entry === undefined || version === undefined) return null;
      const target: DistTarget = {
        versionId: version.versionId,
        revision: version.revision,
        current: true,
        packageId: entry.pkg.packageId,
        sourceId: entry.pkg.sourceId,
        status: 'active',
        blob: null,
        fetch: {
          sourceRef: null,
          upstreamDistUrl: null,
          distType: version.distType,
          composerShasum: null,
          npmIntegrity: null,
          npmShasum: null,
        },
        facts: {
          version: version.version,
          versionNormalized: version.versionNormalized,
          publishedAt: version.publishedAt,
          publishedAtBasis: version.publishedAtBasis ?? 'release_date',
          createdAt: version.createdAt ?? version.publishedAt,
        },
      };
      return target;
    },
    admitProxy: async (_ctx, ref) => ((options.admissible ?? []).includes(ref.key) ? ['S'] : []),
    pageEdges: unused,
    classify: unused,
    classifyWinners: unused,
    previewWinners: unused,
  };
  return { reader: full, calls };
}
