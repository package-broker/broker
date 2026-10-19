import { sql, type SqlBool } from 'kysely';
import type {
  CatalogueWriteGuard,
  DistIdentity,
  WriteEffect,
} from '@package-broker/core/db/catalogue';
import type { OrgContext, Statement, StatementResult } from '@package-broker/core/db/port';
import type { Sha256 } from '@package-broker/core/platform/blob';
import { assertCheck, compile, db, newOpId } from '../kysely.js';
import {
  assertCatalogueWriteGuard,
  monotonicNow,
  blobReferenceFence,
} from '../internal/catalogue-write-guard.js';

export type DistAttachRequest = DistIdentity & {
  readonly sha256: Sha256;
  readonly expectedGeneration?: string;
};

export interface DistAttachPlan {
  readonly opId: string;
  readonly statements: readonly Statement[];
  /** Call after successful execution of this plan's complete batch. */
  result(results: readonly StatementResult[]): WriteEffect;
}

const SHA256 = /^[0-9a-f]{64}$/;

/** Rewriting last_op_id on an equal-blob replay would also bump the package rev. */
export function distAttachStatements(
  ctx: OrgContext,
  guard: CatalogueWriteGuard,
  request: DistAttachRequest,
): DistAttachPlan {
  assertCatalogueWriteGuard(ctx, guard);
  const { versionId, revision, sha256 } = request;
  if (typeof versionId !== 'string' || versionId.length === 0) {
    throw new RangeError('versionId must be a non-empty string');
  }
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new RangeError('revision must be a positive integer');
  }
  if (typeof sha256 !== 'string' || !SHA256.test(sha256)) {
    throw new RangeError('sha256 must be 64 lower-case hexadecimal characters');
  }
  const fence = blobReferenceFence(request.expectedGeneration);
  const opId = newOpId();

  const liveBlob = sql<string>`(SELECT blob.id FROM blob
    WHERE blob.org_id = ${ctx.orgId} AND blob.sha256 = ${sha256} AND blob.deleted_at IS NULL
      AND ${fence})`;

  const attach = db
    .updateTable('version')
    .set({ blob_id: liveBlob, last_op_id: opId })
    .where('version.id', '=', versionId)
    .where('version.org_id', '=', ctx.orgId)
    .where('version.revision', '=', revision)
    .where('version.status', '<>', 'tombstoned')
    .where(sql<SqlBool>`${liveBlob} IS NOT NULL`)
    .where('version.blob_id', 'is', null);

  const attached = assertCheck(
    sql<boolean>`EXISTS (SELECT 1 FROM version
      WHERE version.id = ${versionId} AND version.org_id = ${ctx.orgId}
        AND version.revision = ${revision} AND version.status <> 'tombstoned'
        AND version.blob_id = ${liveBlob})`,
  );

  const advance = db
    .updateTable('package')
    .set({
      rev: sql<number>`package.rev + 1`,
      modified_at: monotonicNow,
    })
    .where('package.org_id', '=', ctx.orgId)
    .where(
      sql<SqlBool>`EXISTS (SELECT 1 FROM version
        WHERE version.package_id = package.id AND version.id = ${versionId}
          AND version.last_op_id = ${opId})`,
    );

  const statements = [...guard, compile(attach), ...attached, compile(advance)];
  const attachIndex = guard.length;
  return {
    opId,
    statements,
    result(results) {
      if (results.length !== statements.length) {
        throw new TypeError('incomplete dist attach results');
      }
      return {
        changed: (results[attachIndex]?.changes ?? 0) > 0,
        statements: statements.length,
      };
    },
  };
}
