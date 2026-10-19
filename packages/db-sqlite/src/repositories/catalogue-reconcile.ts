import { sql, type RawBuilder } from 'kysely';
import {
  ABSENCE_MIN_NOT_FOUND,
  ABSENCE_MIN_SPAN_MS,
  CATALOGUE_KEY_LIST_MAX,
  type CatalogueWriteGuard,
  type FinalizeResult,
  type FinalizeEvidence,
  type ListingScope,
  type WriteEffect,
} from '@package-broker/core/db/catalogue';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import {
  isCompleteListing,
  statusRevisionReason,
  type CompleteSourceListing,
  type CompleteVersionListing,
} from '@package-broker/core/catalogue/version-rules';
import {
  assertFinalizeAllowed,
  type FinalizeGuardOptions,
} from '@package-broker/core/ingest/finalize-guard';
import { assertCheck, compile, db, newOpId } from '../kysely.js';
import { blobLeaseNotLive, leaseLive } from './blob-lease-guard.js';
import { assertCatalogueWriteGuard } from '../internal/catalogue-write-guard.js';

const MAX_KEY_BYTES = 512;
const CANONICAL_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ENCODER = new TextEncoder();

const NOW = sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
const CLOCK = sql`strftime('%Y-%m-%dT%H:%M:%fZ', max(
  unixepoch('now', 'subsec'),
  unixepoch(package.modified_at, 'subsec') + 0.001
), 'unixepoch')`;

export interface ReconcileFinalizeResult extends FinalizeResult {
  readonly leaseHeldBack: number;
}

export interface CatalogueReconciler {
  openListing(
    ctx: OrgContext,
    guard: CatalogueWriteGuard,
    scope: ListingScope,
  ): Promise<{ readonly stamp: string }>;
  /**
   * Mark only keys processed successfully in this run, and count only those keys
   * in the complete listing. Every key must have a row; a missing row rejects
   * the entire chunk without changing any markers.
   */
  markListing(
    ctx: OrgContext,
    guard: CatalogueWriteGuard,
    input: {
      readonly scope: ListingScope;
      readonly stamp: string;
      readonly present: readonly string[];
    },
  ): Promise<WriteEffect>;
  finalizeListing(
    ctx: OrgContext,
    guard: CatalogueWriteGuard,
    listing: CompleteSourceListing | CompleteVersionListing,
    evidence: FinalizeEvidence,
  ): Promise<ReconcileFinalizeResult>;
  markPackageAbsent(
    ctx: OrgContext,
    guard: CatalogueWriteGuard,
    input: { readonly packageId: string },
  ): Promise<WriteEffect>;
}

function statementOf(fragment: RawBuilder<unknown>): Statement {
  return compile({ compile: () => fragment.compile(db) });
}

function checkOf(condition: RawBuilder<boolean>): readonly Statement[] {
  return assertCheck(condition);
}

function leaseNotLive(ctx: OrgContext, versionAlias: string): RawBuilder<boolean> {
  const { sql: text, params } = blobLeaseNotLive(ctx, versionAlias);
  const parts = text.split('?');
  if (parts.length !== params.length + 1)
    throw new TypeError('blob lease guard placeholder mismatch');
  return sql<boolean>`${sql.join(
    parts.flatMap((part, i) =>
      i < params.length ? [sql.raw(part), sql.val(params[i])] : [sql.raw(part)],
    ),
    sql``,
  )}`;
}

function requireStamp(stamp: string): void {
  if (typeof stamp !== 'string' || !CANONICAL_STAMP.test(stamp)) {
    throw new TypeError('listing stamp must be canonical YYYY-MM-DDTHH:MM:SS.sssZ');
  }
}

function requireId(field: string, value: string): void {
  if (typeof value !== 'string' || value === '' || ENCODER.encode(value).length > MAX_KEY_BYTES) {
    throw new RangeError(`${field} must be a non-empty string`);
  }
}

function scopeId(scope: ListingScope): string {
  const id = scope.kind === 'source' ? scope.sourceId : scope.packageId;
  requireId(`${scope.kind} scope id`, id);
  return id;
}

function scopeExists(ctx: OrgContext, scope: ListingScope): RawBuilder<boolean> {
  const id = scopeId(scope);
  return scope.kind === 'source'
    ? sql<boolean>`EXISTS (SELECT 1 FROM source WHERE source.id = ${id} AND source.org_id = ${ctx.orgId})`
    : sql<boolean>`EXISTS (SELECT 1 FROM package WHERE package.id = ${id} AND package.org_id = ${ctx.orgId})`;
}

function openMatches(ctx: OrgContext, scope: ListingScope, stamp: string): RawBuilder<boolean> {
  const table = scope.kind === 'source' ? sql`source` : sql`package`;
  return sql<boolean>`EXISTS (SELECT 1 FROM ${table}
    WHERE id = ${scopeId(scope)} AND org_id = ${ctx.orgId} AND listing_open_stamp = ${stamp})`;
}

function sweepBoundary(ctx: OrgContext, scope: ListingScope): RawBuilder<string> {
  const table = scope.kind === 'source' ? sql`source` : sql`package`;
  return sql<string>`(SELECT listing_opened_at FROM ${table}
    WHERE id = ${scopeId(scope)} AND org_id = ${ctx.orgId})`;
}

function presentKeys(present: readonly string[]): string[] {
  if (!Array.isArray(present) || present.length === 0 || present.length > CATALOGUE_KEY_LIST_MAX) {
    throw new RangeError(`a chunk carries between 1 and ${String(CATALOGUE_KEY_LIST_MAX)} keys`);
  }
  for (const key of present) {
    if (typeof key !== 'string' || key === '' || ENCODER.encode(key).length > MAX_KEY_BYTES) {
      throw new RangeError('a listing key must be a non-empty string of at most 512 bytes');
    }
  }
  return [...new Set(present)];
}

function seenRows(
  ctx: OrgContext,
  scope: ListingScope,
  stamp: string,
  keys?: string,
): RawBuilder<number> {
  const id = scopeId(scope);
  const keyFilter = (column: RawBuilder<unknown>) =>
    keys === undefined ? sql`` : sql` AND ${column} IN (SELECT value FROM json_each(${keys}))`;
  return scope.kind === 'source'
    ? sql<number>`(SELECT count(*) FROM package
        WHERE package.org_id = ${ctx.orgId} AND package.source_id = ${id}
          ${keyFilter(sql`package.name`)}
          AND package.listing_seen_stamp = ${stamp})`
    : sql<number>`(SELECT count(*) FROM version
        WHERE version.org_id = ${ctx.orgId} AND version.package_id = ${id}
          ${keyFilter(sql`version.version_normalized`)}
          AND version.listing_seen_stamp = ${stamp})`;
}

function conditionalEpochBump(ctx: OrgContext, condition: RawBuilder<boolean>): Statement[] {
  return [
    statementOf(
      sql`UPDATE cache_epoch SET version = hex(randomblob(16))
        WHERE org_id = ${ctx.orgId} AND ${condition}`,
    ),
    ...checkOf(sql<boolean>`NOT (changes() <> 1 AND ${condition})`),
  ];
}

export function removedBlobs(
  ctx: OrgContext,
  scope: ListingScope | { readonly opId: string },
): Statement {
  const inScope =
    'opId' in scope
      ? sql`version.last_op_id = ${scope.opId}`
      : scope.kind === 'source'
        ? sql`version.package_id IN (SELECT package.id FROM package
          WHERE package.org_id = ${ctx.orgId} AND package.source_id = ${scope.sourceId})`
        : sql`version.package_id = ${scope.packageId}`;
  return compile({
    compile: () =>
      sql`UPDATE blob SET refetchable = 0
        WHERE blob.org_id = ${ctx.orgId} AND blob.refetchable = 1
          AND blob.deleted_at IS NULL AND blob.purge_after IS NULL
          AND NOT ${leaseLive('blob.purge_lease_until')}
          AND blob.id IN (SELECT version.blob_id FROM version
            WHERE version.org_id = ${ctx.orgId} AND version.status = 'removed_upstream'
              AND version.blob_id IS NOT NULL AND ${inScope})`.compile(db),
  });
}

function transitionStatements(
  ctx: OrgContext,
  packageId: string | undefined,
  opId: string,
  from: 'active' | 'removed_upstream',
  to: 'active' | 'removed_upstream',
  reason: 'listing_absent' | 'listing_present' | 'upstream_absent',
  predicate: RawBuilder<boolean>,
): { revision: Statement; update: Statement } {
  const revisionReason = statusRevisionReason(from, to, reason);
  const packageFilter =
    packageId === undefined ? sql`1 = 1` : sql`version.package_id = ${packageId}`;
  const rows = sql`${packageFilter} AND version.org_id = ${ctx.orgId}
    AND version.status = ${from} AND ${predicate}`;
  const revisionRows =
    to === 'active'
      ? sql`${packageFilter} AND version.org_id = ${ctx.orgId}
          AND version.last_op_id = ${opId} AND version.status = 'active'`
      : rows;
  return {
    revision: statementOf(
      sql`INSERT INTO version_revision
          (id, org_id, version_id, revision, blob_id, source_ref, metadata_json, reason, op_id)
        SELECT lower(hex(randomblob(16))), version.org_id, version.id,
          ${to === 'active' ? sql`version.revision - 1` : sql`version.revision`},
          version.blob_id, version.source_ref, version.metadata_json, ${revisionReason}, ${opId}
        FROM version WHERE ${revisionRows}`,
    ),
    update: statementOf(
      to === 'active'
        ? sql`UPDATE version SET status = 'active', removed_upstream_at = NULL,
            revision = revision + 1, last_op_id = ${opId} WHERE ${rows}`
        : sql`UPDATE version SET status = 'removed_upstream', removed_upstream_at = ${NOW},
            revision = revision + 1, last_op_id = ${opId} WHERE ${rows}`,
    ),
  };
}

export interface FinalizeStatements {
  readonly statements: readonly Statement[];
  readonly removalIndex: number;
  readonly restorationIndex: number;
}

export function finalizeListingStatements(
  ctx: OrgContext,
  guard: CatalogueWriteGuard,
  listing: CompleteSourceListing | CompleteVersionListing,
  evidence: FinalizeEvidence,
  options: FinalizeGuardOptions = {},
): FinalizeStatements {
  assertCatalogueWriteGuard(ctx, guard);
  if (!isCompleteListing(listing)) {
    throw new TypeError('finalize needs a complete listing minted by the ingest session');
  }
  const { stamp, count } = listing;
  assertFinalizeAllowed(count, evidence, options);
  const scope: ListingScope =
    'sourceId' in listing
      ? { kind: 'source', sourceId: listing.sourceId }
      : { kind: 'package', packageId: listing.packageId };
  const id = scopeId(scope);
  const opId = newOpId();
  const boundary = sweepBoundary(ctx, scope);
  const preconditions = [
    ...guard,
    ...checkOf(scopeExists(ctx, scope)),
    ...checkOf(openMatches(ctx, scope, stamp)),
    ...checkOf(sql<boolean>`${seenRows(ctx, scope, stamp)} = ${count}`),
  ];

  if (scope.kind === 'source') {
    const unseen = sql<boolean>`package.updated_at < ${boundary}
      AND (package.status = 'active' OR package.removal_cause IS NOT 'source_listing'
        OR EXISTS (SELECT 1 FROM version WHERE version.package_id = package.id
          AND version.org_id = ${ctx.orgId} AND version.status = 'active'))`;
    const returned = sql<boolean>`package.updated_at >= ${boundary} AND package.status = 'removed_upstream'`;
    const rows = (predicate: RawBuilder<boolean>) =>
      sql`package.org_id = ${ctx.orgId} AND package.source_id = ${id} AND ${predicate}`;
    const statements = [...preconditions];
    const removal = statements.length;
    statements.push(
      statementOf(
        sql`UPDATE package SET status = 'removed_upstream', removed_upstream_at = coalesce(removed_upstream_at, ${NOW}),
          removal_cause = 'source_listing', last_op_id = ${opId},
          rev = rev + 1, modified_at = ${CLOCK} WHERE ${rows(unseen)}`,
      ),
    );
    const restoration = statements.length;
    statements.push(
      statementOf(
        sql`UPDATE package SET status = 'active', removed_upstream_at = NULL,
          removal_cause = NULL, last_op_id = ${opId},
          rev = rev + 1, modified_at = ${CLOCK} WHERE ${rows(returned)}`,
      ),
    );
    const cascade = transitionStatements(
      ctx,
      undefined,
      opId,
      'active',
      'removed_upstream',
      'listing_absent',
      sql<boolean>`EXISTS (SELECT 1 FROM package
        WHERE package.id = version.package_id AND package.org_id = ${ctx.orgId}
          AND package.source_id = ${id} AND package.last_op_id = ${opId}
          AND package.status = 'removed_upstream')`,
    );
    statements.push(
      cascade.revision,
      cascade.update,
      removedBlobs(ctx, { opId }),
      ...conditionalEpochBump(
        ctx,
        sql<boolean>`EXISTS (SELECT 1 FROM package
        JOIN source ON source.id = package.source_id AND source.org_id = package.org_id
        WHERE package.org_id = ${ctx.orgId} AND package.source_id = ${id}
          AND package.last_op_id = ${opId} AND source.removal_policy = 'exclude')`,
      ),
    );
    return { statements, removalIndex: removal, restorationIndex: restoration };
  }

  const unseen = sql<boolean>`version.updated_at < ${boundary}`;
  const returned = sql<boolean>`version.updated_at >= ${boundary}`;
  const revivable = sql<boolean>`${returned} AND ${leaseNotLive(ctx, 'version')}`;
  const packageRevival = sql<boolean>`package.status = 'removed_upstream'
    AND package.removal_cause = 'document_absent'`;
  const removal = transitionStatements(
    ctx,
    id,
    opId,
    'active',
    'removed_upstream',
    'listing_absent',
    unseen,
  );
  const revival = transitionStatements(
    ctx,
    id,
    opId,
    'removed_upstream',
    'active',
    'listing_present',
    revivable,
  );
  const statements = [...preconditions];
  statements.push(removal.revision);
  const removalIndex = statements.length;
  statements.push(removal.update, removedBlobs(ctx, { opId }));
  const revivalIndex = statements.length;
  statements.push(
    revival.update,
    revival.revision,
    ...conditionalEpochBump(
      ctx,
      sql<boolean>`EXISTS (SELECT 1 FROM package
        JOIN source ON source.id = package.source_id AND source.org_id = package.org_id
        WHERE package.id = ${id} AND package.org_id = ${ctx.orgId}
          AND source.removal_policy = 'exclude'
          AND ((${packageRevival}) OR EXISTS (SELECT 1 FROM version
            WHERE version.package_id = package.id AND version.org_id = package.org_id
              AND version.last_op_id = ${opId})))`,
    ),
    statementOf(sql`UPDATE package SET status = 'active', removed_upstream_at = NULL,
      removal_cause = NULL, last_op_id = ${opId}
      WHERE package.id = ${id} AND package.org_id = ${ctx.orgId} AND ${packageRevival}`),
    statementOf(sql`UPDATE package SET rev = rev + 1, modified_at = ${CLOCK}
      WHERE package.id = ${id} AND package.org_id = ${ctx.orgId}
        AND (package.last_op_id = ${opId} OR EXISTS (SELECT 1 FROM version
          WHERE version.package_id = package.id AND version.org_id = ${ctx.orgId}
            AND version.last_op_id = ${opId}))`),
    statementOf(
      sql`UPDATE package SET last_synced_at = ${NOW}
        WHERE id = ${id} AND org_id = ${ctx.orgId}`,
    ),
  );
  return { statements, removalIndex, restorationIndex: revivalIndex };
}

export function createCatalogueReconciler(
  executor: SqlExecutor,
  options: FinalizeGuardOptions = {},
): CatalogueReconciler {
  return {
    async openListing(ctx, guard, scope) {
      assertCatalogueWriteGuard(ctx, guard);
      const table = scope.kind === 'source' ? sql`source` : sql`package`;
      const results = await executor.batch([
        ...guard,
        ...checkOf(scopeExists(ctx, scope)),
        // The canonical stamp is a monotonic identity; only opened_at is a sweep clock.
        statementOf(sql`UPDATE ${table} SET listing_opened_at = ${NOW}, listing_open_stamp =
          strftime('%Y-%m-%dT%H:%M:%fZ', max(unixepoch('now', 'subsec'),
            coalesce(unixepoch(listing_open_stamp, 'subsec') + 0.001, 0)), 'unixepoch')
          WHERE id = ${scopeId(scope)} AND org_id = ${ctx.orgId}
          RETURNING listing_open_stamp AS stamp`),
      ]);
      const stamp = results[results.length - 1]?.rows[0]?.['stamp'];
      if (typeof stamp !== 'string') throw new TypeError('the database returned no listing stamp');
      return { stamp };
    },

    async markListing(ctx, guard, { scope, stamp, present }) {
      assertCatalogueWriteGuard(ctx, guard);
      requireStamp(stamp);
      const keys = presentKeys(present);
      const json = JSON.stringify(keys);
      const id = scopeId(scope);
      const boundary = sweepBoundary(ctx, scope);
      const update =
        scope.kind === 'source'
          ? sql`UPDATE package SET updated_at = max(updated_at, ${boundary}), listing_seen_stamp = ${stamp}
              WHERE org_id = ${ctx.orgId} AND source_id = ${id} AND listing_seen_stamp IS NOT ${stamp}
                AND name IN (SELECT value FROM json_each(${json}))`
          : sql`UPDATE version SET updated_at = max(updated_at, ${boundary}), listing_seen_stamp = ${stamp}
              WHERE org_id = ${ctx.orgId} AND package_id = ${id} AND listing_seen_stamp IS NOT ${stamp}
                AND version_normalized IN (SELECT value FROM json_each(${json}))`;
      const statements = [
        ...guard,
        ...checkOf(scopeExists(ctx, scope)),
        ...checkOf(openMatches(ctx, scope, stamp)),
      ];
      const updateIndex = statements.length;
      statements.push(
        statementOf(update),
        ...checkOf(sql<boolean>`${seenRows(ctx, scope, stamp, json)} = ${keys.length}`),
      );
      const results = await executor.batch(statements);
      const changed = results[updateIndex]?.changes ?? 0;
      return { changed: changed > 0, statements: statements.length };
    },

    async finalizeListing(ctx, guard, listing, evidence) {
      const { statements, removalIndex, restorationIndex } = finalizeListingStatements(
        ctx,
        guard,
        listing,
        evidence,
        options,
      );
      const results = await executor.batch(statements);
      let leaseHeldBack = 0;
      if ('packageId' in listing) {
        const [held] = await executor.all<{ held: number }>(
          statementOf(
            sql`SELECT count(*) AS held FROM version
              WHERE version.package_id = ${listing.packageId} AND version.org_id = ${ctx.orgId}
                AND version.status = 'removed_upstream'
                AND version.updated_at >= ${sweepBoundary(ctx, { kind: 'package', packageId: listing.packageId })}`,
          ),
        );
        leaseHeldBack = Number(held?.held ?? 0);
      }
      return {
        removed: results[removalIndex]?.changes ?? 0,
        restored: results[restorationIndex]?.changes ?? 0,
        statements: statements.length,
        leaseHeldBack,
      };
    },

    async markPackageAbsent(ctx, guard, { packageId }) {
      assertCatalogueWriteGuard(ctx, guard);
      requireId('packageId', packageId);
      const opId = newOpId();
      const decisionId = newOpId();
      const sinceSeconds = Math.ceil(ABSENCE_MIN_SPAN_MS / 1000);
      const absent = sql<boolean>`(EXISTS (SELECT 1 FROM upstream_state
          WHERE upstream_state.package_id = ${packageId} AND upstream_state.org_id = ${ctx.orgId})
        AND NOT EXISTS (SELECT 1 FROM upstream_state
          WHERE upstream_state.package_id = ${packageId} AND upstream_state.org_id = ${ctx.orgId}
            AND (upstream_state.not_found_count < ${ABSENCE_MIN_NOT_FOUND}
              OR upstream_state.first_not_found_at IS NULL
              OR upstream_state.first_not_found_at >
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ${`-${String(sinceSeconds)} seconds`}))))`;
      const transition = transitionStatements(
        ctx,
        packageId,
        opId,
        'active',
        'removed_upstream',
        'upstream_absent',
        sql<boolean>`EXISTS (SELECT 1 FROM package WHERE package.id = ${packageId}
          AND package.org_id = ${ctx.orgId} AND package.last_op_id = ${opId})`,
      );
      const statements = [...guard, ...checkOf(scopeExists(ctx, { kind: 'package', packageId }))];
      statements.push(
        statementOf(sql`UPDATE package SET last_op_id = ${decisionId},
          listing_open_stamp = strftime('%Y-%m-%dT%H:%M:%fZ', listing_open_stamp, '+0.001 seconds')
          WHERE package.id = ${packageId} AND package.org_id = ${ctx.orgId} AND ${absent}`),
      );
      const flip = statements.length;
      statements.push(
        statementOf(
          sql`UPDATE package SET status = 'removed_upstream',
            removed_upstream_at = coalesce(removed_upstream_at, ${NOW}),
            removal_cause = CASE WHEN status = 'active' THEN 'document_absent' ELSE removal_cause END,
            last_op_id = ${opId},
            rev = rev + 1, modified_at = ${CLOCK}
            WHERE package.id = ${packageId} AND package.org_id = ${ctx.orgId}
              AND package.last_op_id = ${decisionId}
              AND (package.status = 'active' OR EXISTS (SELECT 1 FROM version
                WHERE version.package_id = package.id AND version.org_id = ${ctx.orgId}
                  AND version.status = 'active'))`,
        ),
      );
      statements.push(
        transition.revision,
        transition.update,
        removedBlobs(ctx, { opId }),
        ...conditionalEpochBump(
          ctx,
          sql<boolean>`EXISTS (SELECT 1 FROM package
          JOIN source ON source.id = package.source_id AND source.org_id = package.org_id
          WHERE package.id = ${packageId} AND package.org_id = ${ctx.orgId}
            AND package.last_op_id = ${opId} AND source.removal_policy = 'exclude')`,
        ),
      );
      const results = await executor.batch(statements);
      return { changed: (results[flip]?.changes ?? 0) > 0, statements: statements.length };
    },
  };
}
