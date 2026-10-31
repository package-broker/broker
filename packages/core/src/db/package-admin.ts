import type { NameEcosystem } from '../catalogue/names.js';
import type { VersionStatus } from '../catalogue/version-rules.js';
import type { VersionStability } from '../catalogue/versions.js';
import type { CatalogueSourceType } from './catalogue.js';
import type { OrgContext } from './port.js';

export type PackageListStatus = 'active' | 'quarantined' | 'tombstoned' | 'removed_upstream';

export interface PackageListItem {
  readonly id: string;
  readonly ecosystem: NameEcosystem;
  readonly name: string;
  readonly latestVersion: string | null;
  readonly status: PackageListStatus;
  readonly source: {
    readonly id: string;
    readonly name: string;
    readonly type: CatalogueSourceType;
    readonly projectId: string | null;
  };
  readonly versionCount: number;
  readonly lastSyncedAt: string | null;
}

export interface VersionListItem {
  readonly id: string;
  readonly version: string;
  readonly stability: VersionStability;
  readonly status: VersionStatus;
  readonly publishedAt: string;
  readonly removedUpstreamAt: string | null;
  readonly tombstonedAt: string | null;
  readonly revision: number;
}

export interface ManagedVersion {
  readonly publishGate?: boolean;
  readonly packageId: string;
  readonly versionId: string;
  readonly ecosystem: NameEcosystem;
  readonly packageName: string;
  readonly version: string;
  readonly status: VersionStatus;
  readonly sourceId: string;
  readonly sourceProjectId: string | null;
}

export interface PackageListQuery {
  readonly ecosystem?: NameEcosystem;
  readonly status?: PackageListStatus;
  readonly sourceId?: string;
  readonly q?: string;
  readonly after?: string;
  readonly limit: number;
}

export interface PackageAdminReader {
  listProject(
    ctx: OrgContext,
    projectId: string,
    query: PackageListQuery,
  ): Promise<{ readonly items: readonly PackageListItem[]; readonly next: string | null }>;
  listOrganization(
    ctx: OrgContext,
    query: PackageListQuery & { readonly projectId?: string },
  ): Promise<{ readonly items: readonly PackageListItem[]; readonly next: string | null }>;
  listVersions(
    ctx: OrgContext,
    query: {
      readonly packageId: string;
      readonly projectId: string | null;
      readonly after?: string;
      readonly limit: number;
    },
  ): Promise<{ readonly items: readonly VersionListItem[]; readonly next: string | null } | null>;
  findManagedVersion(
    ctx: OrgContext,
    query: {
      readonly packageId: string;
      readonly versionId: string;
      readonly projectId: string | null;
    },
  ): Promise<ManagedVersion | null>;
}
