import { sql, type RawBuilder } from 'kysely';
import {
  ABSENCE_MIN_NOT_FOUND,
  ABSENCE_MIN_SPAN_MS,
  CATALOGUE_KEY_LIST_MAX,
  type CatalogueWriteGuard,
  type FinalizeResult,
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
import { assertCheck, compile, db, newOpId } from '../kysely.js';
import { assertCatalogueWriteGuard } from '../internal/catalogue-write-guard.js';

const MAX_KEY_BYTES = 512;
const CANONICAL_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ENCODER = new TextEncoder();

const NOW = sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
const CLOCK = sql`strftime('%Y-%m-%dT%H:%M:%fZ', max(
  unixepoch('now', 'subsec'),
  unixepoch(package.modified_at, 'subsec') + 0.001
), 'unixepoch')`;

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
  ): Promise<FinalizeResult>;
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

const stampNotFuture = (stamp: string) => checkOf(sql<boolean>`${stamp} <= ${NOW}`);

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
          AND package.updated_at >= ${stamp}${keyFilter(sql`package.name`)})`
    : sql<number>`(SELECT count(*) FROM version
        WHERE version.org_id = ${ctx.orgId} AND version.package_id = ${id}
          AND version.updated_at >= ${stamp}${keyFilter(sql`version.version_normalized`)})`;
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

function transitionStatements(
  ctx: OrgContext,
  packageId: string,
  opId: string,
  from: 'active' | 'removed_upstream',
  to: 'active' | 'removed_upstream',
  reason: 'listing_absent' | 'listing_present' | 'upstream_absent',
  predicate: RawBuilder<boolean>,
): { revision: Statement; update: Statement } {
  const revisionReason = statusRevisionReason(from, to, reason);
  const rows = sql`version.package_id = ${packageId} AND version.org_id = ${ctx.orgId}
    AND version.status = ${from} AND ${predicate}`;
  return {
    revision: statementOf(
      sql`INSERT INTO version_revision
          (id, org_id, version_id, revision, blob_id, source_ref, metadata_json, reason, op_id)
        SELECT lower(hex(randomblob(16))), version.org_id, version.id, version.revision,
          version.blob_id, version.source_ref, version.metadata_json, ${revisionReason}, ${opId}
        FROM version WHERE ${rows}`,
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

const clockAdvance = (ctx: OrgContext, packageId: string, opId: string) =>
  statementOf(
    sql`UPDATE package SET rev = rev + 1, modified_at = ${CLOCK}
      WHERE package.id = ${packageId} AND package.org_id = ${ctx.orgId}
        AND (EXISTS (SELECT 1 FROM version
          WHERE version.package_id = package.id AND version.last_op_id = ${opId}))`,
  );

export function createCatalogueReconciler(executor: SqlExecutor): CatalogueReconciler {
  return {
    async openListing(ctx, guard, scope) {
      assertCatalogueWriteGuard(ctx, guard);
      const results = await executor.batch([
        ...guard,
        ...checkOf(scopeExists(ctx, scope)),
        statementOf(sql`SELECT ${NOW} AS stamp`),
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
      const update =
        scope.kind === 'source'
          ? sql`UPDATE package SET updated_at = max(updated_at, ${stamp})
              WHERE org_id = ${ctx.orgId} AND source_id = ${id} AND updated_at < ${stamp}
                AND name IN (SELECT value FROM json_each(${json}))`
          : sql`UPDATE version SET updated_at = max(updated_at, ${stamp})
              WHERE org_id = ${ctx.orgId} AND package_id = ${id} AND updated_at < ${stamp}
                AND version_normalized IN (SELECT value FROM json_each(${json}))`;
      const statements = [...guard, ...checkOf(scopeExists(ctx, scope)), ...stampNotFuture(stamp)];
      const updateIndex = statements.length;
      statements.push(
        statementOf(update),
        ...checkOf(sql<boolean>`${seenRows(ctx, scope, stamp, json)} = ${keys.length}`),
      );
      const results = await executor.batch(statements);
      const changed = results[updateIndex]?.changes ?? 0;
      return { changed: changed > 0, statements: statements.length };
    },

    async finalizeListing(ctx, guard, listing) {
      assertCatalogueWriteGuard(ctx, guard);
      if (!isCompleteListing(listing)) {
        throw new TypeError('finalize needs a complete listing minted by the ingest session');
      }
      const { stamp, count } = listing;
      const scope: ListingScope =
        'sourceId' in listing
          ? { kind: 'source', sourceId: listing.sourceId }
          : { kind: 'package', packageId: listing.packageId };
      const id = scopeId(scope);
      const opId = newOpId();
      const preconditions = [
        ...guard,
        ...checkOf(scopeExists(ctx, scope)),
        ...stampNotFuture(stamp),
        ...checkOf(sql<boolean>`${seenRows(ctx, scope, stamp)} >= ${count}`),
      ];

      if (scope.kind === 'source') {
        const unseen = sql<boolean>`package.updated_at < ${stamp} AND package.status = 'active'`;
        const returned = sql<boolean>`package.updated_at >= ${stamp} AND package.status = 'removed_upstream'`;
        const rows = (predicate: RawBuilder<boolean>) =>
          sql`package.org_id = ${ctx.orgId} AND package.source_id = ${id} AND ${predicate}`;
        const statements = [
          ...preconditions,
          ...conditionalEpochBump(
            ctx,
            sql<boolean>`EXISTS (SELECT 1 FROM source
              WHERE source.id = ${id} AND source.org_id = ${ctx.orgId}
                AND source.removal_policy = 'exclude'
                AND EXISTS (SELECT 1 FROM package
                  WHERE ${rows(sql<boolean>`(${unseen}) OR (${returned})`)}))`,
          ),
        ];
        const removal = statements.length;
        statements.push(
          statementOf(
            sql`UPDATE package SET status = 'removed_upstream', removed_upstream_at = ${NOW},
              rev = rev + 1, modified_at = ${CLOCK} WHERE ${rows(unseen)}`,
          ),
        );
        const restoration = statements.length;
        statements.push(
          statementOf(
            sql`UPDATE package SET status = 'active', removed_upstream_at = NULL,
              rev = rev + 1, modified_at = ${CLOCK} WHERE ${rows(returned)}`,
          ),
        );
        const results = await executor.batch(statements);
        return {
          removed: results[removal]?.changes ?? 0,
          restored: results[restoration]?.changes ?? 0,
          statements: statements.length,
        };
      }

      const unseen = sql<boolean>`version.updated_at < ${stamp}`;
      const returned = sql<boolean>`version.updated_at >= ${stamp}`;
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
        returned,
      );
      const statements = [
        ...preconditions,
        ...conditionalEpochBump(
          ctx,
          sql<boolean>`EXISTS (SELECT 1 FROM package
            JOIN source ON source.id = package.source_id AND source.org_id = package.org_id
            WHERE package.id = ${id} AND package.org_id = ${ctx.orgId}
              AND source.removal_policy = 'exclude'
              AND EXISTS (SELECT 1 FROM version
                WHERE version.package_id = package.id AND version.org_id = package.org_id
                  AND ((version.status = 'active' AND ${unseen})
                    OR (version.status = 'removed_upstream' AND ${returned}))))`,
        ),
      ];
      statements.push(removal.revision);
      const removalIndex = statements.length;
      statements.push(removal.update, revival.revision);
      const revivalIndex = statements.length;
      statements.push(
        revival.update,
        clockAdvance(ctx, id, opId),
        statementOf(
          sql`UPDATE package SET last_synced_at = ${NOW}
            WHERE id = ${id} AND org_id = ${ctx.orgId}`,
        ),
      );
      const results = await executor.batch(statements);
      return {
        removed: results[removalIndex]?.changes ?? 0,
        restored: results[revivalIndex]?.changes ?? 0,
        statements: statements.length,
      };
    },

    async markPackageAbsent(ctx, guard, { packageId }) {
      assertCatalogueWriteGuard(ctx, guard);
      requireId('packageId', packageId);
      const opId = newOpId();
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
        absent,
      );
      const statements = [
        ...guard,
        ...checkOf(scopeExists(ctx, { kind: 'package', packageId })),
        ...conditionalEpochBump(
          ctx,
          sql<boolean>`EXISTS (SELECT 1 FROM package
            JOIN source ON source.id = package.source_id AND source.org_id = package.org_id
            WHERE package.id = ${packageId} AND package.org_id = ${ctx.orgId}
              AND source.removal_policy = 'exclude' AND ${absent}
              AND (package.status = 'active' OR EXISTS (SELECT 1 FROM version
                WHERE version.package_id = package.id AND version.status = 'active')))`,
        ),
        transition.revision,
        transition.update,
      ];
      const flip = statements.length;
      statements.push(
        statementOf(
          sql`UPDATE package SET status = 'removed_upstream',
            removed_upstream_at = coalesce(removed_upstream_at, ${NOW}),
            rev = rev + 1, modified_at = ${CLOCK}
            WHERE package.id = ${packageId} AND package.org_id = ${ctx.orgId}
              AND ${absent}
              AND (package.status = 'active' OR EXISTS (SELECT 1 FROM version
                WHERE version.package_id = package.id AND version.last_op_id = ${opId}))`,
        ),
      );
      const results = await executor.batch(statements);
      return { changed: (results[flip]?.changes ?? 0) > 0, statements: statements.length };
    },
  };
}
