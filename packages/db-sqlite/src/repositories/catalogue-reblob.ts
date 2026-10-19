import { sql, type SqlBool } from 'kysely';
import type { CatalogueWriteGuard, WriteEffect } from '@package-broker/core/db/catalogue';
import type { OrgContext, Statement, StatementResult } from '@package-broker/core/db/port';
import type { Sha256 } from '@package-broker/core/platform/blob';
import { assertCheck, compile, db, newOpId } from '../kysely.js';
import {
  assertCatalogueWriteGuard,
  monotonicNow,
  blobReferenceFence,
} from '../internal/catalogue-write-guard.js';

export interface BlobReplaceRequest {
  readonly versionId: string;
  readonly expectedRevision: number;
  readonly oldBlobId: string;
  readonly newSha256: Sha256;
  readonly expectedGeneration?: string;
  readonly reason: 'refetch_changed';
}

export interface BlobReplacePlan {
  readonly opId: string;
  readonly statements: readonly Statement[];
  /** Call after successful execution of this plan's complete batch. */
  result(results: readonly StatementResult[]): WriteEffect;
}

const SHA256 = /^[0-9a-f]{64}$/;

export function replaceBlobStatements(
  ctx: OrgContext,
  guard: CatalogueWriteGuard,
  request: BlobReplaceRequest,
): BlobReplacePlan {
  assertCatalogueWriteGuard(ctx, guard);
  const { versionId, expectedRevision, oldBlobId, newSha256, reason } = request;
  if (typeof versionId !== 'string' || versionId.length === 0) {
    throw new RangeError('versionId must be a non-empty string');
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new RangeError('expectedRevision must be a positive integer');
  }
  if (typeof oldBlobId !== 'string' || oldBlobId.length === 0) {
    throw new RangeError('oldBlobId must be a non-empty string');
  }
  if (typeof newSha256 !== 'string' || !SHA256.test(newSha256)) {
    throw new RangeError('newSha256 must be 64 lower-case hexadecimal characters');
  }
  if (reason !== 'refetch_changed') throw new RangeError("reason must be 'refetch_changed'");
  const fence = blobReferenceFence(request.expectedGeneration);
  const opId = newOpId();

  const liveBlob = sql<string>`(SELECT blob.id FROM blob
    WHERE blob.org_id = ${ctx.orgId} AND blob.sha256 = ${newSha256} AND blob.deleted_at IS NULL)`;

  const eligibleBlob = sql<string>`(SELECT blob.id FROM blob
    WHERE blob.org_id = ${ctx.orgId} AND blob.sha256 = ${newSha256} AND blob.deleted_at IS NULL
      AND blob.id <> ${oldBlobId}
      AND ${fence})`;

  const eligible = sql<SqlBool>`version.id = ${versionId} AND version.org_id = ${ctx.orgId}
    AND version.blob_id = ${oldBlobId} AND version.revision = ${expectedRevision}
    AND version.status <> 'tombstoned'
    AND EXISTS (SELECT 1 FROM package
      WHERE package.id = version.package_id AND package.org_id = ${ctx.orgId}
        AND ((package.ecosystem = 'composer' AND COALESCE(version.composer_shasum, '') = '')
          OR (package.ecosystem = 'npm' AND version.npm_integrity IS NULL
            AND COALESCE(json_extract(version.metadata_json, '$.dist.shasum'), '') = '')))
    AND ${eligibleBlob} IS NOT NULL`;

  const precheck = assertCheck(sql<boolean>`EXISTS (SELECT 1 FROM version WHERE ${eligible})`);

  const beforeImage = db
    .insertInto('version_revision')
    .columns([
      'id',
      'org_id',
      'version_id',
      'revision',
      'blob_id',
      'source_ref',
      'metadata_json',
      'reason',
      'op_id',
    ])
    .expression(
      db
        .selectFrom('version')
        .select([
          sql<string>`${newOpId()}`.as('id'),
          'version.org_id',
          'version.id',
          'version.revision',
          'version.blob_id',
          'version.source_ref',
          'version.metadata_json',
          sql<string>`${reason}`.as('reason'),
          sql<string>`${opId}`.as('op_id'),
        ])
        .where(eligible),
    );

  const replace = db
    .updateTable('version')
    .set({
      blob_id: liveBlob,
      revision: sql<number>`version.revision + 1`,
      last_op_id: opId,
    })
    .where('version.id', '=', versionId)
    .where('version.org_id', '=', ctx.orgId)
    .where('version.revision', '=', expectedRevision)
    .where(
      sql<SqlBool>`EXISTS (SELECT 1 FROM version_revision AS before
        WHERE before.version_id = version.id AND before.org_id = ${ctx.orgId}
          AND before.revision = version.revision AND before.op_id = ${opId})`,
    );

  const replaced = assertCheck(
    sql<boolean>`EXISTS (SELECT 1 FROM version
      WHERE version.id = ${versionId} AND version.org_id = ${ctx.orgId}
        AND version.revision = ${expectedRevision} + 1 AND version.last_op_id = ${opId}
        AND version.blob_id = ${liveBlob}
        AND EXISTS (SELECT 1 FROM version_revision AS before
          WHERE before.version_id = version.id AND before.org_id = ${ctx.orgId}
            AND before.revision = ${expectedRevision} AND before.blob_id = ${oldBlobId}
            AND before.op_id = ${opId}))`,
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
          AND version.org_id = ${ctx.orgId} AND version.last_op_id = ${opId})`,
    );

  const statements = [
    ...guard,
    ...precheck,
    compile(beforeImage),
    compile(replace),
    ...replaced,
    compile(advance),
  ];
  return {
    opId,
    statements,
    result(results) {
      if (results.length !== statements.length) {
        throw new TypeError('incomplete blob replace results');
      }
      return { changed: true, statements: statements.length };
    },
  };
}
