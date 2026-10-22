import type { IdempotencyRecord } from '../api/idempotency.js';
import type { AuditEvent } from '../audit/actions.js';
import type { MutationFence } from '../authz/fence.js';
import type { JobGuard } from '../platform/job-repository.js';
import type { OrgContext, Statement } from './port.js';

interface ProtectedHolderProvider {
  readonly provider: string;
  readonly anchor: string;
  readonly emailAuthoritative: boolean;
  /**
   * Required and non-empty when `emailAuthoritative`: an identity's e-mail counts for e-mail
   * grants only when its domain equals one of these lowercase domains.
   */
  readonly emailAuthoritativeDomains?: readonly string[];
}

export type SourceErrorCode =
  | 'network'
  | 'timeout'
  | 'http_error'
  | 'unauthorized'
  | 'rate_limited'
  | 'not_found'
  | 'invalid_response'
  | 'mass_absence'
  | 'too_large'
  | 'policy_denied'
  | 'credential_unavailable'
  | 'internal';
export type SourceEcosystem = 'composer' | 'npm';
export type SourceType =
  'vcs' | 'composer_repository' | 'npm_registry' | 'packagist_proxy' | 'npmjs_proxy' | 'hosted';
export type SourceStatus = 'active' | 'degraded' | 'failing' | 'paused';
export type RemovalPolicy = 'flag' | 'exclude';

export interface RemovalRefusal {
  readonly at: string;
  readonly absent: number;
  readonly listed: number;
  readonly successful: number;
}

export interface SourceRecord {
  readonly id: string;
  readonly projectId: string | null;
  readonly name: string;
  readonly ecosystem: SourceEcosystem;
  readonly type: SourceType;
  readonly url: string | null;
  readonly credentialId: string | null;
  readonly configJson: string;
  readonly userAgent: string | null;
  readonly defaultVisibleToNewProjects: boolean;
  readonly removalPolicy: RemovalPolicy;
  readonly retentionDaysOverride: number | null;
  readonly status: SourceStatus;
  readonly pollIntervalSeconds: number;
  readonly nextPollAt: string | null;
  readonly lastPolledAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastError: string | null;
  readonly consecutiveFailures: number;
  readonly rootHash: string | null;
  readonly listingHash: string | null;
  readonly pollEtag: string | null;
  readonly pollLastModified: string | null;
  readonly removalRefusal: RemovalRefusal | null;
  readonly removalAccepted: boolean;
}

export interface NewSource {
  readonly id: string;
  /** Null for an organization-level source. */
  readonly projectId: string | null;
  readonly name: string;
  readonly ecosystem: SourceEcosystem;
  readonly type: SourceType;
  readonly url: string | null;
  readonly configJson: string;
  readonly userAgent?: string | null;
  readonly pollIntervalSeconds?: number;
  readonly removalPolicy?: RemovalPolicy;
  readonly retentionDaysOverride?: number | null;
  readonly defaultVisibleToNewProjects?: boolean;
  /**
   * `statement` is the insert from `CredentialStore.prepare` and `projectId` the owner of the row it
   * inserts; without a statement the credential must already exist.
   */
  readonly credential:
    | { readonly id: string }
    | {
        readonly id: string;
        readonly projectId: string | null;
        readonly statement: Statement;
      }
    | null;
  readonly providerAnchors: readonly ProtectedHolderProvider[];
}

export interface SourceChanges {
  readonly url?: string | null;
  readonly configJson?: string;
  readonly credentialId?: string | null;
  readonly userAgent?: string | null;
  readonly pollIntervalSeconds?: number;
  readonly removalPolicy?: RemovalPolicy;
  readonly retentionDaysOverride?: number | null;
  readonly defaultVisibleToNewProjects?: boolean;
}

export interface SourceTarget {
  readonly id: string;
  readonly providerAnchors: readonly ProtectedHolderProvider[];
}

export interface SourceListQuery {
  readonly projectId: string | null;
  readonly after: string | null;
  readonly limit: number;
}

export interface SourceUpdate extends SourceTarget {
  readonly changes: SourceChanges;
  /** Inserted atomically with the update; its id must match changes.credentialId. */
  readonly preparedCredential?: { readonly id: string; readonly statement: Statement };
}

interface PollValidators {
  readonly rootHash?: string | null;
  readonly listingHash?: string | null;
  readonly pollEtag?: string | null;
  readonly pollLastModified?: string | null;
}

export type PollOutcome =
  | ({ readonly id: string; readonly outcome: 'success' } & PollValidators)
  | {
      readonly id: string;
      readonly outcome: 'failure';
      readonly error: SourceErrorCode;
    };

/**
 * `indeterminate` on any fenced write: the response was lost and the write may have committed;
 * re-read. `conflict` also covers a failure that could not be classified.
 */
export interface SourceRepository {
  acceptRemoval(
    ctx: OrgContext,
    fence: MutationFence,
    input: SourceTarget & { readonly refusal: RemovalRefusal; readonly audit: AuditEvent },
  ): Promise<'accepted' | 'not_found' | 'forbidden' | 'conflict' | 'indeterminate'>;

  /** Project-owned or attached organization source of an active project, within this organization. */
  getVisible(
    ctx: OrgContext,
    input: { readonly projectId: string; readonly sourceId: string },
  ): Promise<SourceRecord | null>;
  /** Organization sources, or project-owned and attached organization sources of an active project.
   * Returns up to limit + 1 rows in id order; limit is an integer from 1 to 100.
   */
  list(ctx: OrgContext, input: SourceListQuery): Promise<SourceRecord[]>;
  pause(
    ctx: OrgContext,
    fence: MutationFence,
    input: SourceTarget & { readonly audit: AuditEvent; readonly idempotency?: IdempotencyRecord },
  ): Promise<'paused' | 'not_found' | 'forbidden' | 'conflict' | 'indeterminate'>;
  /**
   * Non-proxy sources are created paused, proxies active; nothing is attached to a project.
   * `credential_scope_mismatch`: the credential does not belong to the source's owner. `forbidden`:
   * no `org:sources:write` (organization source) or `project:sources:write` on an active owner
   * project. `duplicate`: the id or the name within its owner exists.
   */
  create(
    ctx: OrgContext,
    fence: MutationFence,
    input: NewSource,
  ): Promise<
    | 'created'
    | 'duplicate'
    | 'forbidden'
    | 'credential_scope_mismatch'
    | 'conflict'
    | 'indeterminate'
  >;
  update(
    ctx: OrgContext,
    fence: MutationFence,
    input: SourceUpdate,
  ): Promise<
    | 'updated'
    | 'paused_for_reactivation'
    | 'not_found'
    | 'forbidden'
    | 'credential_scope_mismatch'
    | 'conflict'
    | 'indeterminate'
  >;
  /**
   * Proxies only. A non-proxy source answers `activation_requires_registered_names` and nothing is
   * written: its activation belongs to the registered-name enable path.
   */
  resume(
    ctx: OrgContext,
    fence: MutationFence,
    input: SourceTarget,
  ): Promise<
    | 'resumed'
    | 'activation_requires_registered_names'
    | 'not_found'
    | 'forbidden'
    | 'conflict'
    | 'indeterminate'
  >;
  /** `has_packages` while a package references the source, `has_history` while webhook deliveries do. */
  delete(
    ctx: OrgContext,
    fence: MutationFence,
    input: SourceTarget,
  ): Promise<
    | 'deleted'
    | 'has_packages'
    | 'has_history'
    | 'not_found'
    | 'forbidden'
    | 'conflict'
    | 'indeterminate'
  >;
  hasAttachedProxy(
    ctx: OrgContext,
    projectId: string,
    ecosystem: SourceEcosystem,
  ): Promise<boolean>;
  get(ctx: OrgContext, id: string): Promise<SourceRecord | null>;
  /** VCS sources across all projects; exact provider, case-insensitive repository, lowest id first. */
  findByRepository(
    ctx: OrgContext,
    input: { provider: string; repository: string },
  ): Promise<SourceRecord | null>;
  /** Non-paused sources with `next_poll_at` reached on database time, oldest first. `limit` is an integer from 1 to 50. */
  listDue(ctx: OrgContext, limit: number): Promise<SourceRecord[]>;
  /**
   * Moves `next_poll_at` of a non-paused source to database time plus its poll interval, only while
   * it still equals `expectedNextPollAt`, so a finished sync that already wrote the real value wins.
   */
  deferPoll(ctx: OrgContext, id: string, expectedNextPollAt: string): Promise<boolean>;
  /** `stale` when the job guard no longer holds; nothing is written then. */
  pollState(
    ctx: OrgContext,
    guard: JobGuard,
    input: PollOutcome,
  ): Promise<'written' | 'stale' | 'not_found'>;
}

export interface NewRegisteredName {
  readonly audit: AuditEvent;
  readonly idempotency?: IdempotencyRecord;
  readonly id: string;
  readonly sourceId: string;
  readonly pattern: string;
  readonly providerAnchors: readonly ProtectedHolderProvider[];
}

export interface RegisteredNameTarget {
  readonly audit: AuditEvent;
  readonly idempotency?: IdempotencyRecord;
  readonly id: string;
  readonly providerAnchors: readonly ProtectedHolderProvider[];
}

export interface RegisteredNameRecord {
  readonly id: string;
  readonly sourceId: string;
  readonly ecosystem: SourceEcosystem;
  readonly pattern: string;
}

export interface RegisteredNameListQuery {
  readonly sourceId: string;
  readonly after?: string;
  readonly limit: number;
}

export interface RegisteredNamePage {
  readonly items: readonly RegisteredNameRecord[];
  readonly next: string | null;
}

/**
 * Every registered-name write needs `org:sources:write`, also for project-level sources, and
 * `forbidden` is answered before existence is revealed. `pattern_taken`: another source of the
 * organization holds the pattern; the answer names neither that source nor its project.
 * `indeterminate`: the response was lost and the write may have committed; re-read.
 */
export interface RegisteredNameRepository {
  /** Id-ordered page within the organization and source; limit is an integer from 1 to 100. */
  list(ctx: OrgContext, input: RegisteredNameListQuery): Promise<RegisteredNamePage>;
  owner(
    ctx: OrgContext,
    id: string,
  ): Promise<{ readonly sourceId: string; readonly projectId: string | null } | null>;
  add(
    ctx: OrgContext,
    fence: MutationFence,
    input: NewRegisteredName,
  ): Promise<
    | 'added'
    | 'invalid_pattern'
    | 'proxy_source'
    | 'pattern_taken'
    | 'duplicate'
    | 'not_found'
    | 'forbidden'
    | 'conflict'
    | 'indeterminate'
  >;
  /** An active non-proxy source left without coverage is paused in the same batch. */
  remove(
    ctx: OrgContext,
    fence: MutationFence,
    input: RegisteredNameTarget & { readonly pauseAudit: AuditEvent },
  ): Promise<
    'removed' | 'removed_and_paused' | 'not_found' | 'forbidden' | 'conflict' | 'indeterminate'
  >;
  /**
   * The only path that activates a paused non-proxy source. Authority is the source owner's:
   * `org:sources:write` for an organization source, `project:sources:write` for a project source.
   * `already_enabled`: the source is not paused; nothing is written.
   */
  enable(
    ctx: OrgContext,
    fence: MutationFence,
    input: RegisteredNameTarget,
  ): Promise<
    | 'enabled'
    | 'already_enabled'
    | 'activation_requires_registered_names'
    | 'not_found'
    | 'forbidden'
    | 'conflict'
    | 'indeterminate'
  >;
}
