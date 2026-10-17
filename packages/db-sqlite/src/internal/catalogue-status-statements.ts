import { sql } from 'kysely';
import type { WriteEffect } from '@package-broker/core/db/catalogue';
import type { OrgContext, Statement, StatementResult } from '@package-broker/core/db/port';
import {
  statusRevisionReason,
  versionTransition,
  type StatusReason,
  type VersionStatus,
} from '@package-broker/core/catalogue/version-rules';
import { compile, db, newOpId } from '../kysely.js';

const STATUSES: readonly VersionStatus[] = [
  'active',
  'removed_upstream',
  'quarantined',
  'tombstoned',
  'yanked',
];
const NOW = sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

export interface StatusTransitionInput {
  readonly versionId: string;
  readonly to: VersionStatus;
  readonly reason: StatusReason;
}

export interface StatusPlan {
  readonly opId: string;
  readonly statements: readonly Statement[];
  /** Call after successful execution of this plan's complete batch. */
  result(results: readonly StatementResult[]): WriteEffect;
}

/**
 * Moves one version to `to` when its current status allows that transition for `reason`, and
 * does nothing otherwise. The revision row copies the version's current metadata, source_ref
 * and blob under the reason code that names the observed from-status; the version's revision
 * then advances and the package clock moves, all keyed on this plan's op id. The caller owns
 * the lease or fence guard and the cache epoch.
 */
export function versionStatusStatements(
  ctx: OrgContext,
  input: StatusTransitionInput,
): StatusPlan & { readonly operation: string } {
  const { versionId, to, reason } = input;
  const from = STATUSES.filter((status) => versionTransition(status, to, reason));
  if (from.length === 0) throw new RangeError(`no status transition into ${to} for ${reason}`);
  const suffix = statusRevisionReason(from[0] as VersionStatus, to, reason).replace(
    /^status:[a-z_]+/,
    '',
  );
  const opId = newOpId();

  const insertRevision = db
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
          sql<string>`'status:' || version.status || ${suffix}`.as('reason'),
          sql<string>`${opId}`.as('op_id'),
        ])
        .where('version.id', '=', versionId)
        .where('version.org_id', '=', ctx.orgId)
        .where('version.status', 'in', from),
    );

  const tombstone = to === 'tombstoned';
  const updateVersion = db
    .updateTable('version')
    .set({
      status: to,
      revision: sql<number>`version.revision + 1`,
      last_op_id: opId,
      updated_at: NOW,
      ...(to === 'active' ? { removed_upstream_at: null } : {}),
      ...(tombstone ? { tombstoned_at: NOW, tombstone_reason: reason } : {}),
    })
    .where('version.id', '=', versionId)
    .where('version.org_id', '=', ctx.orgId)
    .where('version.status', 'in', from)
    .where(
      sql<boolean>`EXISTS (SELECT 1 FROM version_revision
        WHERE version_revision.version_id = version.id AND version_revision.op_id = ${opId})`,
    );

  const advancePackage = db
    .updateTable('package')
    .set({
      rev: sql<number>`package.rev + 1`,
      modified_at: sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', max(
        unixepoch('now', 'subsec'),
        unixepoch(package.modified_at, 'subsec') + 0.001
      ), 'unixepoch')`,
    })
    .where('package.org_id', '=', ctx.orgId)
    .where(
      sql<boolean>`EXISTS (SELECT 1 FROM version
        WHERE version.package_id = package.id AND version.last_op_id = ${opId})`,
    );

  const statements = [compile(insertRevision), compile(updateVersion), compile(advancePackage)];
  return {
    opId,
    operation: `${to}:${reason}`,
    statements,
    result(results) {
      if (results.length !== statements.length) {
        throw new TypeError('incomplete status transition results');
      }
      return { changed: (results[1]?.changes ?? 0) > 0, statements: statements.length };
    },
  };
}

/** A missing epoch row means the organization has not read its cache yet and needs no bump. */
export function conditionalEpochBumpStatement(
  ctx: OrgContext,
  versionId: string,
  opId: string,
): Statement {
  return compile(
    db
      .updateTable('cache_epoch')
      .set({ version: sql<string>`hex(randomblob(16))` })
      .where('cache_epoch.org_id', '=', ctx.orgId)
      .where(
        sql<boolean>`EXISTS (SELECT 1 FROM version
          WHERE version.id = ${versionId} AND version.org_id = ${ctx.orgId}
            AND version.last_op_id = ${opId})`,
      ),
  );
}
