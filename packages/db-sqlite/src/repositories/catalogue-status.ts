import { sql, type SqlBool } from 'kysely';
import {
  fenceGuard,
  runFenced,
  type FailureProbes,
  type FailureReason,
  type MutationFence,
} from '@package-broker/core/authz/fence';
import type { CatalogueWriteGuard } from '@package-broker/core/db/catalogue';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import type { StatusReason } from '@package-broker/core/catalogue/version-rules';
import { assertCheck, compile, db, type Guard, type ProtectedHolderProvider } from '../kysely.js';
import { assertCatalogueWriteGuard } from '../internal/catalogue-write-guard.js';
import {
  conditionalEpochBumpStatement,
  versionStatusStatements,
  type StatusPlan,
} from '../internal/catalogue-status-statements.js';
import { actorHolds } from './actor-authority.js';
import { blobLeaseNotLive } from './blob-lease-guard.js';

const WRITER_REASONS: ReadonlySet<StatusReason> = new Set<StatusReason>([
  'digest_mismatch',
  'manifest_conflict',
]);

/** Add the guard length to obtain the complete quarantine statement budget. */
export const QUARANTINE_STATEMENTS = 4;

/**
 * The job-guarded integrity quarantine. The epoch is bumped only when this batch quarantined
 * the version, so a refused transition leaves every row, including cache_epoch, untouched.
 */
export function quarantineStatements(
  ctx: OrgContext,
  guard: CatalogueWriteGuard,
  input: { readonly versionId: string; readonly reason: 'digest_mismatch' | 'manifest_conflict' },
): StatusPlan {
  assertCatalogueWriteGuard(ctx, guard);
  if (!WRITER_REASONS.has(input.reason)) {
    throw new RangeError('a job may quarantine only for digest_mismatch or manifest_conflict');
  }
  const plan = versionStatusStatements(ctx, {
    versionId: input.versionId,
    to: 'quarantined',
    reason: input.reason,
  });
  const statements = [
    ...guard,
    ...plan.statements,
    conditionalEpochBumpStatement(ctx, input.versionId, plan.opId),
  ];
  const offset = guard.length;
  return {
    opId: plan.opId,
    statements,
    result(results) {
      if (results.length !== statements.length) {
        throw new TypeError('incomplete quarantine results');
      }
      const effect = plan.result(results.slice(offset, offset + plan.statements.length));
      return { changed: effect.changed, statements: statements.length };
    },
  };
}

export type ReleaseResult =
  | { readonly ok: true; readonly opId: string }
  | {
      readonly ok: false;
      readonly reason: FailureReason | 'indeterminate' | 'not_found' | 'blob_busy' | 'publish_gate';
    };

export interface CatalogueStatusRepository {
  /**
   * Moves a quarantined version back to active. Refusals are decided in the order authority,
   * existence in the actor's organization, transition validity, blob purge lease; the first
   * three are indistinguishable from a leased blob for a caller that fails them. A widening
   * transition: the cache epoch is not bumped.
   */
  releaseQuarantine(
    ctx: OrgContext,
    fence: MutationFence,
    input: { readonly versionId: string },
  ): Promise<ReleaseResult>;
}

export interface CatalogueStatusOptions {
  readonly providerAnchors: readonly ProtectedHolderProvider[];
}

function leaseNotLive(ctx: OrgContext, alias: string): Guard {
  const lease = blobLeaseNotLive(ctx, alias);
  const parts = lease.sql.split('?');
  if (parts.length !== lease.params.length + 1) {
    throw new TypeError('invalid blob lease guard parameter count');
  }
  const pieces = parts.flatMap((part, index) => {
    const param = lease.params[index];
    return index < lease.params.length ? [sql.raw(part), sql`${param}`] : [sql.raw(part)];
  });
  return sql<SqlBool>`${sql.join(pieces, sql``)}`;
}

function releasable(ctx: OrgContext, versionId: string): Guard {
  return sql<SqlBool>`exists (select 1 from version as target_version
    where target_version.id = ${versionId} and target_version.org_id = ${ctx.orgId}
      and target_version.status = 'quarantined'
      and not exists (select 1 from publish_approval pa where pa.org_id = ${ctx.orgId} and pa.version_id = target_version.id)
      and ${leaseNotLive(ctx, 'target_version')})`;
}

function probe(condition: Guard): Statement {
  return compile(db.selectNoFrom(sql<number>`(${condition}) is not 1`.as('failed')));
}

export function createCatalogueStatusRepository(
  executor: SqlExecutor,
  options: CatalogueStatusOptions,
): CatalogueStatusRepository {
  async function refusal(ctx: OrgContext, versionId: string): Promise<ReleaseResult> {
    const [row] = await executor.all<{ status: string; publish_gate: number }>(
      compile(
        db
          .selectFrom('version as target_version')
          .select([
            'target_version.status as status',
            sql<number>`exists (select 1 from publish_approval pa where pa.org_id = ${ctx.orgId} and pa.version_id = target_version.id)`.as(
              'publish_gate',
            ),
          ])
          .where('target_version.id', '=', versionId)
          .where('target_version.org_id', '=', ctx.orgId),
      ),
    );
    if (row === undefined) return { ok: false, reason: 'not_found' };
    if (row.publish_gate === 1) return { ok: false, reason: 'publish_gate' };
    if (row.status !== 'quarantined') return { ok: false, reason: 'conflict' };
    return { ok: false, reason: 'blob_busy' };
  }

  return {
    async releaseQuarantine(ctx, fence, input) {
      const authority = actorHolds(ctx, fence, {
        permission: 'org:sources:write',
        projectId: null,
        providerAnchors: options.providerAnchors,
      });
      const ready = releasable(ctx, input.versionId);
      const plan = versionStatusStatements(ctx, {
        versionId: input.versionId,
        to: 'active',
        reason: 'admin_release',
      });
      const guard = fenceGuard(assertCheck(sql<SqlBool>`(${authority} and ${ready})`));
      const probes: FailureProbes = {
        authority: probe(authority),
        conflict: probe(ready),
      };
      const outcome = await runFenced(executor, fence, guard, plan.statements, probes);
      if (outcome.ok) return { ok: true, opId: plan.opId };
      if (outcome.reason !== 'conflict' && outcome.reason !== 'unclassified') {
        return { ok: false, reason: outcome.reason };
      }
      return refusal(ctx, input.versionId);
    },
  };
}
