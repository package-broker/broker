import type { IdempotencyRecord } from '../api/idempotency.js';
import type { AuditEvent } from '../audit/actions.js';
import type { FailureReason, MutationFence } from '../authz/fence.js';
import type { ProjectActor } from '../authz/project-actor.js';
import type { NormalizedMetadata } from '../catalogue/metadata.js';
import type { NameEcosystem } from '../catalogue/names.js';
import type {
  CompleteSourceListing,
  CompleteVersionListing,
  HistoryBasis,
  StatusReason,
  VersionStatus,
} from '../catalogue/version-rules.js';
import type { VersionStability } from '../catalogue/versions.js';
import type { Sha256 } from '../platform/blob.js';
import type { CacheKey, EpochReader } from '../platform/cache.js';
import type { PublishApprovalInsert, PublishReadme } from './publishes.js';
import type { OrgContext, Statement } from './port.js';

declare const CATALOGUE_WRITE_GUARD: unique symbol;

export const CATALOGUE_PAGE_MAX = 200;
export const CATALOGUE_SEARCH_MAX = 50;
export const CATALOGUE_KEY_LIST_MAX = 1000;
export const CATALOGUE_WINNER_KEYS_MAX = 200;
export const CATALOGUE_SYNC_CHUNK_VERSIONS = 50;
export const CATALOGUE_SYNC_VERSIONS_PER_CALL = 50;
/**
 * markPackageAbsent changes nothing unless, checked inside its batch with database time,
 * upstream_state.not_found_count >= ABSENCE_MIN_NOT_FOUND and
 * first_not_found_at <= now - ABSENCE_MIN_SPAN_MS (owner Q9).
 */
export const ABSENCE_MIN_NOT_FOUND = 2;
export const ABSENCE_MIN_SPAN_MS = 3_600_000;

export type CatalogueWriteGuard = readonly Statement[] & { readonly [CATALOGUE_WRITE_GUARD]: true };

/** Db layer only (packages/db-sqlite); the architecture test rejects any other importer. */
export function catalogueWriteGuard(statements: readonly Statement[]): CatalogueWriteGuard {
  return Object.freeze([...statements]) as unknown as CatalogueWriteGuard;
}

export function validateLimit(limit: unknown, max: number): number {
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > max) {
    throw new TypeError(`limit must be an integer from 1 to ${max}`);
  }
  return limit;
}

export type CatalogueSourceType =
  'vcs' | 'composer_repository' | 'npm_registry' | 'packagist_proxy' | 'npmjs_proxy' | 'hosted';

export type DistType = 'zip' | 'tar' | 'tgz';

export type CatalogueDocKind =
  'composer-p2' | 'composer-p2-dev' | 'npm-full' | 'npm-abbreviated' | 'npm-dist-tags';

export interface ProjectScope {
  readonly projectId: string;
}

export interface EcosystemScope extends ProjectScope {
  readonly ecosystem: NameEcosystem;
}

export interface PackageRef extends EcosystemScope {
  readonly key: string;
}

export interface ResolvedPackage extends PackageRef {
  readonly packageId: string;
  readonly sourceId: string;
  readonly rev: number;
  readonly modifiedAt: string;
  readonly createdAt: string;
  readonly listingComplete: boolean;
  readonly cacheEpoch: string | null;
}

export interface PageBinding {
  readonly packageId: string;
  readonly sourceId: string;
  readonly rev: number;
}

export interface VersionCursor {
  readonly publishedAt: string;
  readonly id: string;
}

export interface CatalogueVersion {
  readonly versionId: string;
  readonly revision: number;
  readonly version: string;
  readonly versionNormalized: string;
  readonly stability: VersionStability;
  readonly status: 'active' | 'removed_upstream';
  readonly publishedAt: string;
  readonly upstreamReleasedAt: string | null;
  readonly license: string | null;
  readonly distType: DistType | null;
  readonly composerShasum: string | null;
  readonly npmIntegrity: string | null;
  readonly deprecatedMessage: string | null;
  readonly metadataJson: string;
}

export interface PackageResolution {
  readonly pkg: ResolvedPackage;
  readonly versions: readonly CatalogueVersion[];
  readonly next: VersionCursor | null;
  readonly binding: PageBinding;
}

export interface PageChanged {
  readonly changed: true;
}

export interface ResolveVersionsQuery extends PackageRef {
  readonly stability?: VersionStability;
  readonly publishedAtMost?: string;
  readonly binding?: PageBinding;
  readonly after?: VersionCursor;
  readonly limit: number;
}

export interface VersionLookup {
  readonly pkg: ResolvedPackage;
  readonly version: CatalogueVersion;
}

export interface DistTagsLookup {
  readonly pkg: ResolvedPackage;
  readonly tags: Readonly<Record<string, string>>;
}

export interface FetchDescriptor {
  readonly sourceRef: string | null;
  readonly upstreamDistUrl: string | null;
  readonly distType: DistType | null;
  readonly composerShasum: string | null;
  readonly npmIntegrity: string | null;
  readonly npmShasum: string | null;
}

export interface DistBlob {
  readonly id: string;
  readonly sha256: Sha256;
  readonly sizeBytes: number;
  readonly mediaType: string;
  readonly refetchable: boolean;
}

export interface DistTarget {
  readonly versionId: string;
  readonly revision: number;
  /** False for a historical revision: its bytes are served only from its own live blob, never refilled. */
  readonly current: boolean;
  readonly packageId: string;
  readonly sourceId: string;
  readonly status: 'active' | 'removed_upstream';
  readonly blob: DistBlob | null;
  readonly fetch: FetchDescriptor;
}

export interface DistIdentity {
  readonly versionId: string;
  readonly revision: number;
}

export type ResolveDistQuery = PackageRef &
  (
    | {
        readonly by: 'version';
        readonly versionNormalized: string;
        readonly expect?: DistIdentity;
      }
    | ({ readonly by: 'id' } & DistIdentity)
  );

export interface ListedPackage {
  readonly key: string;
  readonly packageId: string;
  readonly sourceId: string;
  readonly description: string | null;
}

export interface VisibleListing {
  readonly items: readonly ListedPackage[];
  readonly next: string | null;
  readonly openNamespace: boolean;
}

export interface EdgeCursor {
  readonly requirerKey: string;
  readonly versionId: string;
}

export interface EdgeRow {
  readonly requirerKey: string;
  readonly versionId: string;
  readonly version: string;
  /** JSON text of the dependency fields, or null when the version declares none. */
  readonly deps: string | null;
}

export interface EdgePage {
  readonly rows: readonly EdgeRow[];
  readonly next: EdgeCursor | null;
}

export type KeyClass = 'proxy_admissible' | 'attachable' | 'not_available';

export interface KeyClassification {
  readonly key: string;
  readonly class: KeyClass;
}

export interface WinnerClassification {
  readonly key: string;
  readonly winner: { readonly sourceId: string; readonly sourceType: CatalogueSourceType } | null;
}

/** An attached source whose package with the key is visible to the project, in winner order; the first eligible one wins. */
export interface WinnerCandidate {
  readonly sourceId: string;
  readonly sourceType: CatalogueSourceType;
  readonly projectLevel: boolean;
  readonly precedence: number;
  readonly packageId: string;
  readonly eligible: boolean;
}

export interface CatalogueReader {
  resolveVersions(
    ctx: OrgContext,
    query: ResolveVersionsQuery,
  ): Promise<PackageResolution | PageChanged | null>;
  lookupVersion(
    ctx: OrgContext,
    query: PackageRef & { readonly versionNormalized: string },
  ): Promise<VersionLookup | null>;
  lookupTag(
    ctx: OrgContext,
    query: PackageRef & { readonly tag: string },
  ): Promise<VersionLookup | null>;
  distTags(ctx: OrgContext, query: PackageRef): Promise<DistTagsLookup | null>;
  listVisible(
    ctx: OrgContext,
    query: EcosystemScope & { readonly after?: string; readonly limit: number },
  ): Promise<VisibleListing>;
  search(
    ctx: OrgContext,
    query: EcosystemScope & { readonly text: string; readonly limit: number },
  ): Promise<readonly ListedPackage[]>;
  resolveDist(ctx: OrgContext, query: ResolveDistQuery): Promise<DistTarget | null>;
  admitProxy(ctx: OrgContext, query: PackageRef): Promise<readonly string[]>;
  pageEdges(
    ctx: OrgContext,
    query: EcosystemScope & { readonly after?: EdgeCursor; readonly limit: number },
  ): Promise<EdgePage>;
  classify(
    ctx: OrgContext,
    query: EcosystemScope & { readonly keys: readonly string[] },
  ): Promise<readonly KeyClassification[]>;
  classifyWinners(
    ctx: OrgContext,
    query: EcosystemScope & { readonly keys: readonly string[] },
  ): Promise<readonly WinnerClassification[]>;
  previewWinners(ctx: OrgContext, query: PackageRef): Promise<readonly WinnerCandidate[]>;
}

export type PackageVisibility =
  | {
      readonly kind: 'visible';
      readonly pkg: ResolvedPackage;
      readonly cacheKey: (docKind: CatalogueDocKind) => CacheKey;
      readonly epochReader: EpochReader;
    }
  | {
      readonly kind: 'proxy_admissible';
      readonly projectId: string;
      readonly ecosystem: NameEcosystem;
      readonly key: string;
      readonly sourceIds: readonly string[];
    }
  | { readonly kind: 'absent' };

export interface PackageVisibilityPort {
  resolve(
    actor: ProjectActor,
    ecosystem: NameEcosystem,
    rawName: string,
  ): Promise<PackageVisibility>;
}

export interface VersionInput {
  readonly version: string;
  readonly versionNormalized: string;
  readonly license: string | null;
  readonly distType: DistType | null;
  readonly sourceRef: string | null;
  readonly upstreamReleasedAt: string | null;
  readonly metadata: NormalizedMetadata;
  readonly history: {
    readonly basis: HistoryBasis;
    readonly at: string;
    readonly noOtherDate?: boolean;
  };
}

export interface SyncPackageInput {
  readonly sourceId: string;
  readonly ecosystem: NameEcosystem;
  readonly key: string;
  readonly description: string | null;
  readonly versions: readonly VersionInput[];
  readonly tags?: Readonly<Record<string, string>>;
  /** Full snapshot tag names to retain while applying a slice of tags. */
  readonly tagNames?: readonly string[];
}

export type SyncRefusal = 'invalid' | 'too_large' | 'tombstoned';

export interface SyncResult {
  readonly packageId: string;
  readonly inserted: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly conflicts: readonly string[];
  readonly refused: readonly { readonly version: string; readonly reason: SyncRefusal }[];
  readonly skippedTags: readonly string[];
  readonly statements: number;
}

export interface WriteEffect {
  readonly changed: boolean;
  readonly statements: number;
}

export interface MarkListingEffect extends WriteEffect {
  /** Rows that carried another stamp before this call; a replay of the same keys marks none. */
  readonly marked: number;
}

export type ListingScope =
  | { readonly kind: 'source'; readonly sourceId: string }
  | { readonly kind: 'package'; readonly packageId: string };

export interface FinalizeEvidence {
  readonly attemptedCandidates: number;
  readonly successfulCandidates: number;
  readonly definitiveAbsent: number;
}

export interface FinalizeResult {
  readonly removed: number;
  readonly restored: number;
  readonly statements: number;
  readonly leaseHeldBack: number;
}

export type CatalogueWriteMethod =
  | 'publishVersion'
  | 'syncPackage'
  | 'attachDist'
  | 'openListing'
  | 'markListing'
  | 'finalizeListing'
  | 'quarantine'
  | 'markPackageAbsent';

export interface PublishVersionInput {
  readonly sourceId: string;
  readonly key: string;
  readonly description: string | null;
  readonly versionId: string;
  readonly version: VersionInput;
  readonly blob: DistBlob;
  readonly integrity: string;
  readonly distTags: Readonly<Record<string, string>>;
  readonly readme: PublishReadme | null;
  readonly approval: PublishApprovalInsert | null;
  readonly scanJobStatements: readonly Statement[];
  readonly requirePublishApproval: boolean;
  readonly routeProjectId: string;
  readonly tokenId: string;
  readonly now: string;
  readonly event: AuditEvent;
}

export interface PublishVersionResult {
  readonly packageId: string;
  readonly versionId: string;
  readonly rev: number;
  readonly approvalId: string | null;
  readonly held: { readonly approval: boolean; readonly scan: boolean };
}

export interface CatalogueWriter {
  publishVersion(
    ctx: OrgContext,
    guard: CatalogueWriteGuard,
    input: PublishVersionInput,
  ): Promise<PublishVersionResult>;
  /** Worst-case statements per call; for syncPackage, a call with CATALOGUE_SYNC_VERSIONS_PER_CALL versions. */
  readonly statementBudget: Readonly<Record<CatalogueWriteMethod, number>>;
  /** Worst-case executed statements, including guards repeated after batch splits. */
  syncPackageCost(shape: {
    readonly versions: number;
    readonly tags: number;
    readonly guardStatements: number;
  }): number;
  /** Bound parameter bytes one syncPackage version group may carry. */
  readonly syncPayloadLimit: number;
  /**
   * Upper bound of the bound parameter bytes one version adds to a syncPackage call; above
   * `syncPayloadLimit` the version cannot be written in any call.
   */
  syncPayloadBytes(
    ctx: OrgContext,
    guard: CatalogueWriteGuard,
    input: Pick<SyncPackageInput, 'sourceId' | 'ecosystem' | 'key'> & {
      readonly version: VersionInput;
    },
  ): number;
  syncPackage(
    ctx: OrgContext,
    guard: CatalogueWriteGuard,
    input: SyncPackageInput,
  ): Promise<SyncResult>;
  attachDist(
    ctx: OrgContext,
    guard: CatalogueWriteGuard,
    input: DistIdentity & { readonly sha256: Sha256 },
  ): Promise<WriteEffect>;
  openListing(
    ctx: OrgContext,
    guard: CatalogueWriteGuard,
    scope: ListingScope,
  ): Promise<{ readonly stamp: string }>;
  /** Mark only keys successfully processed in this run; refused stored keys remain unmarked. */
  markListing(
    ctx: OrgContext,
    guard: CatalogueWriteGuard,
    input: {
      readonly scope: ListingScope;
      readonly stamp: string;
      readonly present: readonly string[];
    },
  ): Promise<MarkListingEffect>;
  /** Count upstream keys minus this run's refusals; use the current open's stamp. Empty documents use markPackageAbsent. */
  finalizeListing(
    ctx: OrgContext,
    guard: CatalogueWriteGuard,
    listing: CompleteSourceListing | CompleteVersionListing,
    evidence: FinalizeEvidence,
  ): Promise<FinalizeResult>;
  quarantine(
    ctx: OrgContext,
    guard: CatalogueWriteGuard,
    input: {
      readonly versionId: string;
      readonly reason: Extract<StatusReason, 'digest_mismatch' | 'manifest_conflict'>;
    },
  ): Promise<WriteEffect>;
  markPackageAbsent(
    ctx: OrgContext,
    guard: CatalogueWriteGuard,
    input: { readonly packageId: string },
  ): Promise<WriteEffect>;
}

export type VisibilityWriteResult =
  | { readonly ok: true; readonly opId: string }
  | {
      readonly ok: false;
      readonly reason:
        | FailureReason
        | 'indeterminate'
        | 'not_found'
        | 'invalid_pattern'
        | 'too_many_patterns'
        | 'not_attached'
        | 'not_eligible';
    };

export interface VisibilityAudit {
  readonly audit: AuditEvent;
  readonly idempotency?: IdempotencyRecord;
}

export type PackageManageScope =
  { readonly kind: 'organization' } | { readonly kind: 'project'; readonly projectId: string };

interface PackageManageWrite {
  readonly packageId: string;
  readonly expectedStatus: VersionStatus;
  readonly manage: PackageManageScope;
  readonly audit: AuditEvent;
  readonly idempotency?: IdempotencyRecord;
}

/** Every method checks the fence actor's authority inside its own batch. */
export interface VisibilityStore {
  attachSource(
    ctx: OrgContext,
    fence: MutationFence,
    input: VisibilityAudit & {
      readonly projectId: string;
      readonly sourceId: string;
      readonly precedence?: number;
    },
  ): Promise<VisibilityWriteResult>;
  detachSource(
    ctx: OrgContext,
    fence: MutationFence,
    input: VisibilityAudit & { readonly projectId: string; readonly sourceId: string },
  ): Promise<VisibilityWriteResult>;
  setPrecedence(
    ctx: OrgContext,
    fence: MutationFence,
    input: VisibilityAudit & {
      readonly projectId: string;
      readonly sourceId: string;
      readonly precedence: number;
    },
  ): Promise<VisibilityWriteResult>;
  setOrder(
    ctx: OrgContext,
    fence: MutationFence,
    input: {
      readonly projectId: string;
      readonly sourceIds: readonly string[];
      readonly audit: AuditEvent;
      readonly idempotency?: IdempotencyRecord;
    },
  ): Promise<VisibilityWriteResult>;
  setPackageFlag(
    ctx: OrgContext,
    fence: MutationFence,
    input: { readonly packageId: string; readonly visibleToNewProjects: boolean },
  ): Promise<VisibilityWriteResult>;
  addPattern(
    ctx: OrgContext,
    fence: MutationFence,
    input: VisibilityAudit & {
      readonly projectId: string;
      readonly sourceId: string;
      readonly pattern: string;
      readonly effect: 'include' | 'exclude';
    },
  ): Promise<VisibilityWriteResult>;
  removePattern(
    ctx: OrgContext,
    fence: MutationFence,
    input: VisibilityAudit & {
      readonly projectId: string;
      readonly sourceId: string;
      readonly pattern: string;
    },
  ): Promise<VisibilityWriteResult>;
  addExplicit(
    ctx: OrgContext,
    fence: MutationFence,
    input: { readonly projectId: string; readonly packageId: string },
  ): Promise<VisibilityWriteResult>;
  removeExplicit(
    ctx: OrgContext,
    fence: MutationFence,
    input: { readonly projectId: string; readonly packageId: string },
  ): Promise<VisibilityWriteResult>;
  quarantineVersion(
    ctx: OrgContext,
    fence: MutationFence,
    input: PackageManageWrite & {
      readonly versionId: string;
      readonly reason: Extract<StatusReason, 'admin_quarantine'>;
    },
  ): Promise<VisibilityWriteResult>;
  releaseQuarantine(
    ctx: OrgContext,
    fence: MutationFence,
    input: PackageManageWrite & { readonly versionId: string },
  ): Promise<VisibilityWriteResult>;
  tombstoneVersion(
    ctx: OrgContext,
    fence: MutationFence,
    input: PackageManageWrite & {
      readonly versionId: string;
      readonly reason: Extract<StatusReason, 'admin_tombstone'>;
    },
  ): Promise<VisibilityWriteResult>;
}
