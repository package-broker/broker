import type { CatalogueWriteGuard } from '@package-broker/core/db/catalogue';
import type { OrgContext } from '@package-broker/core/db/port';
import type { StatusReason } from '@package-broker/core/catalogue/version-rules';
import { assertCatalogueWriteGuard } from '../internal/catalogue-write-guard.js';
import {
  conditionalEpochBumpStatement,
  versionStatusStatements,
  type StatusPlan,
} from '../internal/catalogue-status-statements.js';

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
