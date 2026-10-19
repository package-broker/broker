import { sql, type RawBuilder } from 'kysely';
import { ACCESS_MUTATION_GUARD_CONSTRAINT, DbError } from '@package-broker/core/db/errors';
import type { FinalizeEvidence, ListingScope } from '@package-broker/core/db/catalogue';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import {
  completeSourceListing,
  completeVersionListing,
} from '@package-broker/core/catalogue/version-rules';
import { MassAbsenceError } from '@package-broker/core/ingest/absence-guard';
import {
  assertFinalizeAllowed,
  FinalizeEvidenceError,
  type FinalizeGuardOptions,
} from '@package-broker/core/ingest/finalize-guard';
import type { IngestSessionHandle } from '@package-broker/core/ingest/session';
import { assertCheck, compile, db } from '../kysely.js';
import { parsePendingValidators, type UpstreamForm } from '@package-broker/core/ingest/validators';
import { NOW } from '../internal/lease-time.js';
import { finalizeListingStatements, removedBlobs } from './catalogue-reconcile.js';
import { createIngestSessionWriteGuard, ingestSessionGuard } from './ingest-session.js';
import { createUpstreamStateRepository, type PublishedValidators } from './upstream-state.js';

export type IngestFinalizeRefusal =
  | 'mass_absence'
  | 'no_success'
  | 'candidate_count_mismatch'
  | 'incomplete'
  | 'count_mismatch'
  | 'session_unavailable'
  | 'no_stamp'
  | 'no_package'
  | 'superseded';

export type IngestFinalizeResult =
  | {
      readonly status: 'complete';
      readonly empty: boolean;
      readonly validatorsPublished: number;
    }
  | { readonly status: 'refused'; readonly reason: IngestFinalizeRefusal };

export interface IngestFinalizeInput extends FinalizeEvidence {
  readonly expectedCount: number;
  readonly upstreamComplete: boolean;
  readonly validatorTtlSeconds: number;
}

export interface IngestFinalizer {
  finalize(
    ctx: OrgContext,
    session: IngestSessionHandle,
    input: IngestFinalizeInput,
  ): Promise<IngestFinalizeResult>;
}

interface SessionRow {
  scope: 'source' | 'package';
  source_id: string;
  package_key: string | null;
  stamp: string | null;
  pending_validators: string | null;
}

function markedRows(ctx: OrgContext, scope: ListingScope, stamp: string): RawBuilder<number> {
  return scope.kind === 'source'
    ? sql<number>`(SELECT count(*) FROM package
        WHERE package.org_id = ${ctx.orgId} AND package.source_id = ${scope.sourceId}
          AND package.listing_seen_stamp = ${stamp})`
    : sql<number>`(SELECT count(*) FROM version
        WHERE version.org_id = ${ctx.orgId} AND version.package_id = ${scope.packageId}
          AND version.listing_seen_stamp = ${stamp})`;
}

function completeSession(ctx: OrgContext, session: IngestSessionHandle): Statement[] {
  const complete = compile({
    compile: () =>
      sql`UPDATE ingest_session SET state = 'complete', updated_at = ${NOW}
        WHERE id = ${session.id} AND org_id = ${ctx.orgId} AND owner = ${session.owner}
          AND fence = ${session.fence} AND state = 'running'`.compile(db),
  });
  return [
    complete,
    ...assertCheck(
      sql<boolean>`EXISTS (SELECT 1 FROM ingest_session
        WHERE id = ${session.id} AND org_id = ${ctx.orgId} AND state = 'complete')`,
    ),
  ];
}

export function createIngestFinalizer(
  executor: SqlExecutor,
  options: FinalizeGuardOptions = {},
): IngestFinalizer {
  const upstream = createUpstreamStateRepository(executor);

  return {
    async finalize(ctx, session, input) {
      const { expectedCount, upstreamComplete, validatorTtlSeconds } = input;
      if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) {
        throw new RangeError('expectedCount must be a non-negative integer');
      }
      if (
        !Number.isInteger(validatorTtlSeconds) ||
        validatorTtlSeconds < 0 ||
        validatorTtlSeconds > 366 * 24 * 60 * 60
      ) {
        throw new RangeError(
          'validatorTtlSeconds must be an integer between 0 and 31622400 seconds',
        );
      }
      if (upstreamComplete !== true) return { status: 'refused', reason: 'incomplete' };

      const [row] = await executor.all<SessionRow>(
        compile(
          db
            .selectFrom('ingest_session')
            .select(['scope', 'source_id', 'package_key', 'stamp', 'pending_validators'])
            .where('id', '=', session.id)
            .where('org_id', '=', ctx.orgId)
            .where('owner', '=', session.owner)
            .where('fence', '=', session.fence)
            .where('state', '=', 'running')
            .where(sql<boolean>`lease_until > ${NOW}`),
        ),
      );
      if (row === undefined) return { status: 'refused', reason: 'session_unavailable' };
      if (row.stamp === null) return { status: 'refused', reason: 'no_stamp' };
      const { stamp } = row;

      let scope: ListingScope;
      if (row.scope === 'source') {
        if (row.pending_validators !== null) {
          throw new TypeError('source sessions cannot publish package validators');
        }
        scope = { kind: 'source', sourceId: row.source_id };
      } else {
        const [found] = await executor.all<{ id: string }>(
          compile(
            db
              .selectFrom('package')
              .select('id')
              .where('org_id', '=', ctx.orgId)
              .where('source_id', '=', row.source_id)
              .where('name', '=', row.package_key ?? ''),
          ),
        );
        if (found === undefined) return { status: 'refused', reason: 'no_package' };
        scope = { kind: 'package', packageId: found.id };
      }

      const validators =
        scope.kind === 'package'
          ? (Object.entries(parsePendingValidators(JSON.parse(row.pending_validators ?? '{}'))) as [
              UpstreamForm,
              PublishedValidators,
            ][])
          : [];
      const [counted] = await executor.all<{ n: number }>(
        compile(db.selectNoFrom(markedRows(ctx, scope, stamp).as('n'))),
      );
      if (counted?.n !== expectedCount) return { status: 'refused', reason: 'count_mismatch' };

      try {
        assertFinalizeAllowed(expectedCount, input, options);
      } catch (error) {
        if (error instanceof MassAbsenceError) return { status: 'refused', reason: 'mass_absence' };
        if (error instanceof FinalizeEvidenceError)
          return { status: 'refused', reason: error.reason };
        throw error;
      }

      const statements: Statement[] = [...ingestSessionGuard(ctx, session)];
      if (expectedCount >= 1) {
        const guard = createIngestSessionWriteGuard(ctx, session);
        const listing =
          scope.kind === 'source'
            ? completeSourceListing({ sourceId: scope.sourceId, stamp, count: expectedCount })
            : completeVersionListing({ packageId: scope.packageId, stamp, count: expectedCount });
        statements.push(
          ...finalizeListingStatements(ctx, guard, listing, input, options).statements,
        );
      } else {
        const openStamp =
          scope.kind === 'source'
            ? sql<boolean>`EXISTS (SELECT 1 FROM source WHERE org_id = ${ctx.orgId} AND id = ${scope.sourceId} AND listing_open_stamp = ${stamp})`
            : sql<boolean>`EXISTS (SELECT 1 FROM package WHERE org_id = ${ctx.orgId} AND id = ${scope.packageId} AND listing_open_stamp = ${stamp})`;
        statements.push(
          ...assertCheck(openStamp),
          ...assertCheck(sql<boolean>`${markedRows(ctx, scope, stamp)} = 0`),
        );
      }
      const validatorIndices: number[] = [];
      if (scope.kind === 'package') {
        for (const [form, published] of validators) {
          validatorIndices.push(statements.length);
          statements.push(
            ...upstream.publishStatements(
              ctx,
              scope.packageId,
              form,
              published,
              validatorTtlSeconds,
            ),
          );
        }
      }
      statements.push(removedBlobs(ctx, scope), ...completeSession(ctx, session));

      let validatorsPublished: number;
      try {
        const results = await executor.batch(statements);
        validatorsPublished = validatorIndices.reduce(
          (count, index) => count + (results[index]?.changes ?? 0),
          0,
        );
      } catch (error) {
        if (error instanceof DbError && error.constraint === ACCESS_MUTATION_GUARD_CONSTRAINT) {
          return { status: 'refused', reason: 'superseded' };
        }
        throw error;
      }
      return {
        status: 'complete',
        empty: expectedCount === 0,
        validatorsPublished,
      };
    },
  };
}
