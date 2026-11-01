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
  readonly visibleToNewProjects?: boolean;
  readonly newProjectAccessMode?: 'none' | 'request';
  readonly revision?: number;
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
  readonly integrity: string | null;
  readonly distTags: readonly string[];
  readonly publishedBy: {
    readonly kind: 'user' | 'service' | 'system';
    readonly displayName: string;
  } | null;
  readonly approvedBy: { readonly displayName: string; readonly decidedAt: string } | null;
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
  readonly hostedNpm?: true;
  readonly revision?: number;
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

export interface PackageAccessInput {
  readonly packageId: string;
  readonly visibleToNewProjects: boolean;
  readonly newProjectAccessMode: 'none' | 'request';
  readonly revision: number;
  readonly audit: import('../audit/actions.js').AuditEvent;
  readonly idempotency?: import('../api/idempotency.js').IdempotencyRecord;
}

export interface PackageDetailRepository {
  detail(
    ctx: OrgContext,
    query: { readonly packageId: string; readonly projectId: string | null },
  ): Promise<PackageListItem | null>;
  packageName(ctx: OrgContext, packageId: string): Promise<string | null>;
  readme(
    ctx: OrgContext,
    query: {
      readonly packageId: string;
      readonly projectId: string;
      readonly version?: string;
    },
  ): Promise<{ filename: string; body: string } | null>;
  setAccess(
    ctx: OrgContext,
    fence: import('../authz/fence.js').MutationFence,
    input: PackageAccessInput,
  ): Promise<
    { ok: true } | { ok: false; error: 'not_found' | 'forbidden' | 'conflict' | 'unavailable' }
  >;
}
