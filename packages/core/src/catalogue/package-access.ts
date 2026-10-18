import type { ProjectActor } from '../authz/project-actor.js';
import type {
  CatalogueReader,
  DistIdentity,
  DistTagsLookup,
  DistTarget,
  ListedPackage,
  PackageRef,
  PackageResolution,
  PackageVisibility,
  PackageVisibilityPort,
  PageChanged,
  ResolveVersionsQuery,
  VersionLookup,
  VisibleListing,
} from '../db/catalogue.js';
import type { OrgContext } from '../db/port.js';
import { boundEpochReader, catalogueCacheKey } from './cache-keys.js';
import { packageKey, type NameEcosystem } from './names.js';

export const PACKAGES_READ = 'project:packages:read';

export type VersionPageQuery = Omit<ResolveVersionsQuery, keyof PackageRef>;

export type DistRequest =
  | { readonly by: 'version'; readonly versionNormalized: string; readonly expect?: DistIdentity }
  | ({ readonly by: 'id' } & DistIdentity);

export interface PackageAccess extends PackageVisibilityPort {
  versions(
    actor: ProjectActor,
    ecosystem: NameEcosystem,
    rawName: string,
    query: VersionPageQuery,
  ): Promise<PackageResolution | PageChanged | null>;
  version(
    actor: ProjectActor,
    ecosystem: NameEcosystem,
    rawName: string,
    versionNormalized: string,
  ): Promise<VersionLookup | null>;
  tag(
    actor: ProjectActor,
    ecosystem: NameEcosystem,
    rawName: string,
    tag: string,
  ): Promise<VersionLookup | null>;
  distTags(
    actor: ProjectActor,
    ecosystem: NameEcosystem,
    rawName: string,
  ): Promise<DistTagsLookup | null>;
  list(
    actor: ProjectActor,
    ecosystem: NameEcosystem,
    query: { readonly after?: string; readonly limit: number },
  ): Promise<VisibleListing>;
  search(
    actor: ProjectActor,
    ecosystem: NameEcosystem,
    query: { readonly text: string; readonly limit: number },
  ): Promise<readonly ListedPackage[]>;
  dist(
    actor: ProjectActor,
    ecosystem: NameEcosystem,
    rawName: string,
    request: DistRequest,
  ): Promise<DistTarget | null>;
}

const ABSENT: PackageVisibility = Object.freeze({ kind: 'absent' });

function mayRead(actor: ProjectActor): boolean {
  return actor.kind === 'project' && actor.permissions.has(PACKAGES_READ);
}

function parse(ecosystem: NameEcosystem, rawName: string): string | null {
  try {
    return packageKey(rawName, { ecosystem, legacyCase: ecosystem === 'npm' });
  } catch {
    return null;
  }
}

export function createPackageAccess(reader: CatalogueReader): PackageAccess {
  const ctx = (actor: ProjectActor): OrgContext => ({ orgId: actor.orgId });

  async function withRef<T>(
    actor: ProjectActor,
    ecosystem: NameEcosystem,
    rawName: string,
    read: (ctx: OrgContext, ref: PackageRef) => Promise<T | null>,
  ): Promise<T | null> {
    if (!mayRead(actor)) {
      return null;
    }
    const key = parse(ecosystem, rawName);
    if (key === null) {
      return null;
    }
    return read(ctx(actor), { projectId: actor.projectId, ecosystem, key });
  }

  return {
    async resolve(actor, ecosystem, rawName) {
      const outcome = await withRef<PackageVisibility>(
        actor,
        ecosystem,
        rawName,
        async (c, ref) => {
          const first = await reader.resolveVersions(c, { ...ref, limit: 1 });
          if (first !== null) {
            if ('changed' in first) {
              return ABSENT;
            }
            const { pkg } = first;
            return {
              kind: 'visible',
              pkg,
              cacheKey: (docKind) => catalogueCacheKey(pkg, docKind),
              epochReader: boundEpochReader(pkg),
            };
          }
          const sourceIds = await reader.admitProxy(c, ref);
          return sourceIds.length > 0
            ? {
                kind: 'proxy_admissible',
                projectId: ref.projectId,
                ecosystem: ref.ecosystem,
                key: ref.key,
                sourceIds: [...sourceIds],
              }
            : ABSENT;
        },
      );
      return outcome ?? ABSENT;
    },

    versions: (actor, ecosystem, rawName, query) =>
      withRef(actor, ecosystem, rawName, (c, ref) =>
        reader.resolveVersions(c, { ...query, ...ref }),
      ),

    version: (actor, ecosystem, rawName, versionNormalized) =>
      withRef(actor, ecosystem, rawName, (c, ref) =>
        reader.lookupVersion(c, { ...ref, versionNormalized }),
      ),

    tag: (actor, ecosystem, rawName, tag) =>
      withRef(actor, ecosystem, rawName, (c, ref) => reader.lookupTag(c, { ...ref, tag })),

    distTags: (actor, ecosystem, rawName) =>
      withRef(actor, ecosystem, rawName, (c, ref) => reader.distTags(c, ref)),

    async list(actor, ecosystem, query) {
      if (!mayRead(actor)) {
        return { items: [], next: null, openNamespace: false };
      }
      return reader.listVisible(ctx(actor), { projectId: actor.projectId, ecosystem, ...query });
    },

    async search(actor, ecosystem, query) {
      if (!mayRead(actor)) {
        return [];
      }
      return reader.search(ctx(actor), { projectId: actor.projectId, ecosystem, ...query });
    },

    dist: (actor, ecosystem, rawName, request) =>
      withRef(actor, ecosystem, rawName, (c, ref) =>
        reader.resolveDist(
          c,
          request.by === 'version'
            ? {
                ...ref,
                by: 'version',
                versionNormalized: request.versionNormalized,
                ...(request.expect ? { expect: request.expect } : {}),
              }
            : { ...ref, by: 'id', versionId: request.versionId, revision: request.revision },
        ),
      ),
  };
}
