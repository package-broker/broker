import type { PublishReadme } from '@package-broker/core/db/publishes';
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
  readonly npmIntegrity?: string;
  readonly readme?: PublishReadme | null;
  readonly readmeTruncated?: boolean;
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
  const { npmIntegrity, readme } = request;
  if (npmIntegrity !== undefined && !/^sha512-[A-Za-z0-9+/]{86}==$/.test(npmIntegrity)) {
    throw new RangeError('invalid_npm_integrity');
  }
  if (
    readme != null &&
    (npmIntegrity === undefined ||
      new TextEncoder().encode(readme.filename).length > 4096 ||
      readme.filename.length === 0 ||
      /[\\/\p{Cc}]/u.test(readme.filename) ||
      new TextEncoder().encode(readme.body).length > 524288 ||
      [...readme.body].some((char) => /\p{Cc}/u.test(char) && !['\t', '\n', '\r'].includes(char)))
  ) {
    throw new RangeError('invalid_readme');
  }
  const fence = blobReferenceFence(request.expectedGeneration);
  const opId = newOpId();

  const liveBlob = sql<string>`(SELECT blob.id FROM blob
    WHERE blob.org_id = ${ctx.orgId} AND blob.sha256 = ${sha256} AND blob.deleted_at IS NULL
      AND ${fence})`;

  const attach = db
    .updateTable('version')
    .set({
      blob_id: liveBlob,
      last_op_id: opId,
      ...(request.readmeTruncated === undefined
        ? {}
        : {
            metadata_json: sql<string>`json_set(metadata_json, '$.readmeTruncated', json(${request.readmeTruncated ? 'true' : 'false'}))`,
          }),
      ...(npmIntegrity === undefined ? {} : { npm_integrity: npmIntegrity }),
    })
    .where('version.id', '=', versionId)
    .where('version.org_id', '=', ctx.orgId)
    .where('version.revision', '=', revision)
    .where('version.status', '<>', 'tombstoned')
    .where(sql<SqlBool>`${liveBlob} IS NOT NULL`)
    .where('version.blob_id', 'is', null)
    .$if(npmIntegrity !== undefined, (q) =>
      q.where(sql<SqlBool>`EXISTS (
      SELECT 1 FROM package p JOIN source s ON s.id=p.source_id AND s.org_id=p.org_id
      WHERE p.id=version.package_id AND p.org_id=${ctx.orgId} AND p.ecosystem='npm' AND s.type='vcs')`),
    );

  const attached = assertCheck(
    sql<boolean>`EXISTS (SELECT 1 FROM version
      WHERE version.id = ${versionId} AND version.org_id = ${ctx.orgId}
        AND version.revision = ${revision} AND version.status <> 'tombstoned'
        AND version.blob_id = ${liveBlob}
        AND (${npmIntegrity === undefined ? 1 : 0} = 1 OR version.npm_integrity = ${npmIntegrity ?? null}))`,
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

  const readmeStatements =
    readme == null
      ? []
      : [
          compile(
            db
              .insertInto('version_readme')
              .columns(['version_id', 'org_id', 'filename', 'body'])
              .expression(
                sql`SELECT ${versionId}, ${ctx.orgId}, ${readme.filename}, ${readme.body}
        WHERE EXISTS (SELECT 1 FROM version WHERE id=${versionId} AND org_id=${ctx.orgId} AND last_op_id=${opId})`,
              )
              .onConflict((conflict) => conflict.column('version_id').doNothing()),
          ),
        ];
  const statements = [
    ...guard,
    compile(attach),
    ...attached,
    ...readmeStatements,
    compile(advance),
  ];
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
