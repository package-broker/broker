import { assertBatchStatementCount } from '@package-broker/core/db/errors';
import { sql } from 'kysely';
import {
  CATALOGUE_SYNC_VERSIONS_PER_CALL,
  type CatalogueWriteGuard,
  type SyncRefusal,
  type SyncResult,
  type VersionInput,
} from '@package-broker/core/db/catalogue';
import type { OrgContext, Statement, StatementResult } from '@package-broker/core/db/port';
import { MAX_METADATA_BYTES } from '@package-broker/core/catalogue/metadata';
import { validateVersion, type VersionEcosystem } from '@package-broker/core/catalogue/versions';
import { parseHistoryDate } from '@package-broker/core/catalogue/version-rules';
import { assertCheck, compile, db, newOpId } from '../kysely.js';
import { assertCatalogueWriteGuard } from '../internal/catalogue-write-guard.js';

export const MAX_UPDATE_VERSIONS_PER_CALL = CATALOGUE_SYNC_VERSIONS_PER_CALL;
const MAX_BATCH_PARAMETER_BYTES = 4 * 1024 * 1024;
const CONTROL = /\p{Cc}/u;
const ENCODER = new TextEncoder();
const NOW = sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

export interface VersionUpdateRequest {
  readonly packageId: string;
  readonly ecosystem: VersionEcosystem;
  readonly versions: readonly VersionInput[];
}

export interface VersionUpdatePlan {
  readonly opId: string;
  readonly refused: SyncResult['refused'];
  readonly statements: readonly Statement[];
  /** Call after successful execution of this plan's complete batch. */
  result(results: readonly StatementResult[]): SyncResult;
}

function refusalOf(input: VersionInput, ecosystem: VersionEcosystem): SyncRefusal | null {
  try {
    validateVersion({
      ecosystem,
      version: input.version,
      versionNormalized: input.versionNormalized,
    });
    if (input.upstreamReleasedAt !== null) {
      parseHistoryDate({ basis: 'release_date', at: input.upstreamReleasedAt });
    }
  } catch {
    return 'invalid';
  }
  for (const [value, cap] of [
    [input.license, 256],
    [input.sourceRef, 512],
    [input.metadata.deprecatedMessage, 1024],
  ] as const) {
    if (
      value !== null &&
      (typeof value !== 'string' || CONTROL.test(value) || ENCODER.encode(value).length > cap)
    )
      return 'invalid';
  }
  return ENCODER.encode(input.metadata.json).length > MAX_METADATA_BYTES ? 'too_large' : null;
}

/**
 * Revises existing versions of one package. Composer: a change to metadata, source reference,
 * dist type or licence inserts the before-image of the current revision, then updates under a
 * marker that proves that before-image belongs to this operation; a rival before-image for the
 * same revision breaks the unique index and fails the batch. A changed dist, or source reference without a shasum,
 * resets blob_id. npm: a different manifest or integrity is selected as a conflict and never
 * written. Both: deprecation and upstream release date change in place. Absent and tombstoned
 * slots are left alone and counted unchanged; published_at is never written.
 */
export function versionUpdateStatements(
  ctx: OrgContext,
  guard: CatalogueWriteGuard,
  request: VersionUpdateRequest,
): VersionUpdatePlan {
  assertCatalogueWriteGuard(ctx, guard);
  const { packageId, ecosystem, versions } = request;
  if (versions.length === 0 || versions.length > MAX_UPDATE_VERSIONS_PER_CALL) {
    throw new RangeError(
      `a call carries between 1 and ${String(MAX_UPDATE_VERSIONS_PER_CALL)} versions`,
    );
  }
  const opId = newOpId();
  const accepted: VersionInput[] = [];
  const refused: { version: string; reason: SyncRefusal }[] = [];
  const seen = new Set<string>();
  for (const input of versions) {
    const reason = seen.has(input.versionNormalized) ? 'invalid' : refusalOf(input, ecosystem);
    seen.add(input.versionNormalized);
    if (reason === null) accepted.push(input);
    else refused.push({ version: input.version, reason });
  }

  const roles: ('revision' | 'inplace' | 'conflict' | 'other')[] = [];
  const statements: Statement[] = [];
  const updatedInputs = new Map<number, string>();
  const push = (role: (typeof roles)[number], ...built: readonly Statement[]) => {
    for (const statement of built) {
      statements.push(statement);
      roles.push(role);
    }
  };
  const finish = (): VersionUpdatePlan => ({
    opId,
    refused,
    statements,
    result(results) {
      if (results.length !== statements.length)
        throw new TypeError('incomplete version update results');
      const updated = new Set<string>();
      const conflicts: string[] = [];
      results.forEach((result, index) => {
        const role = roles[index];
        if ((role === 'revision' || role === 'inplace') && result.changes > 0) {
          updated.add(updatedInputs.get(index)!);
        }
        if (role === 'conflict') {
          const names = new Set(result.rows.map((r) => r['version_normalized']));
          for (const input of accepted) {
            if (names.has(input.versionNormalized)) conflicts.push(input.version);
          }
        }
      });
      return {
        packageId,
        inserted: 0,
        updated: updated.size,
        unchanged:
          statements.length === 0 ? 0 : accepted.length - new Set([...updated, ...conflicts]).size,
        conflicts,
        refused,
        skippedTags: [],
        statements: statements.length,
      };
    },
  });
  if (accepted.length === 0) return finish();

  push('other', ...guard);
  push(
    'other',
    ...assertCheck(
      sql<boolean>`EXISTS (SELECT 1 FROM package
        WHERE package.id = ${packageId} AND package.org_id = ${ctx.orgId}
          AND package.ecosystem = ${ecosystem})`,
    ),
  );

  // Evaluate pending changes before writing: last_op_id can survive a replay of this plan.
  push(
    'other',
    compile(
      db
        .updateTable('package')
        .set({
          rev: sql<number>`package.rev + 1`,
          modified_at: sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', max(
            unixepoch('now', 'subsec'),
            unixepoch(package.modified_at, 'subsec') + 0.001
          ), 'unixepoch')`,
        })
        .where('package.id', '=', packageId)
        .where('package.org_id', '=', ctx.orgId)
        .where(
          sql<boolean>`EXISTS (SELECT 1 FROM version
            JOIN json_each(${JSON.stringify(
              accepted.map((input) => ({
                version: input.versionNormalized,
                metadata: input.metadata.json,
                sourceRef: input.sourceRef,
                distType: input.distType,
                license: input.license,
                deprecated: input.metadata.deprecatedMessage,
                upstream: input.upstreamReleasedAt,
              })),
            )}) AS incoming
              ON version.version_normalized = json_extract(incoming.value, '$.version')
            WHERE version.package_id = package.id AND version.org_id = ${ctx.orgId}
              AND version.status <> 'tombstoned'
              AND (version.deprecated_message IS NOT json_extract(incoming.value, '$.deprecated')
                OR version.upstream_released_at IS NOT json_extract(incoming.value, '$.upstream')
                OR (${ecosystem} = 'composer' AND (
                  version.metadata_json IS NOT json_extract(incoming.value, '$.metadata')
                  OR version.source_ref IS NOT json_extract(incoming.value, '$.sourceRef')
                  OR version.dist_type IS NOT json_extract(incoming.value, '$.distType')
                  OR version.license IS NOT json_extract(incoming.value, '$.license')))))`,
        ),
    ),
  );

  for (const input of accepted) {
    const slot = sql<boolean>`version.package_id = ${packageId} AND version.org_id = ${ctx.orgId}
      AND version.version_normalized = ${input.versionNormalized}
      AND version.status <> 'tombstoned'`;
    const { metadata } = input;
    const deprecationDiffers = sql<boolean>`(version.deprecated_message IS NOT ${metadata.deprecatedMessage}
      OR version.upstream_released_at IS NOT ${input.upstreamReleasedAt})`;

    if (ecosystem === 'composer') {
      push(
        'other',
        compile(
          db
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
                  sql<string>`'upstream_change'`.as('reason'),
                  sql<string>`${opId}`.as('op_id'),
                ])
                .where(slot)
                .where(
                  sql<boolean>`(version.metadata_json IS NOT ${metadata.json}
                    OR version.source_ref IS NOT ${input.sourceRef}
                    OR version.dist_type IS NOT ${input.distType}
                    OR version.license IS NOT ${input.license})`,
                ),
            ),
        ),
      );
      updatedInputs.set(statements.length, input.version);
      push(
        'revision',
        compile(
          db
            .updateTable('version')
            .set({
              metadata_json: metadata.json,
              source_ref: input.sourceRef,
              license: input.license,
              composer_shasum: metadata.composerShasum,
              deprecated_message: metadata.deprecatedMessage,
              upstream_released_at: input.upstreamReleasedAt,
              blob_id: sql<string | null>`CASE
                WHEN version.dist_type IS NOT ${input.distType}
                  OR version.composer_shasum IS NOT ${metadata.composerShasum}
                  OR json_extract(version.metadata_json, '$.dist') IS NOT json_extract(${metadata.json}, '$.dist')
                  OR (${metadata.composerShasum} IS NULL AND version.source_ref IS NOT ${input.sourceRef})
                THEN NULL ELSE version.blob_id END`,
              dist_type: input.distType,
              revision: sql<number>`version.revision + 1`,
              last_op_id: opId,
              updated_at: NOW,
            })
            .where(slot)
            .where(
              sql<boolean>`EXISTS (SELECT 1 FROM version_revision AS before
                WHERE before.version_id = version.id AND before.org_id = ${ctx.orgId}
                  AND before.revision = version.revision
                  AND before.op_id = ${opId})`,
            ),
        ),
      );
    } else {
      push(
        'conflict',
        compile(
          db
            .selectFrom('version')
            .select('version.version_normalized')
            .where(slot)
            .where(
              sql<boolean>`(version.metadata_json IS NOT ${metadata.json}
                OR version.npm_integrity IS NOT ${metadata.npmIntegrity})`,
            ),
        ),
      );
    }

    const inPlace = db
      .updateTable('version')
      .set({
        deprecated_message: metadata.deprecatedMessage,
        upstream_released_at: input.upstreamReleasedAt,
        last_op_id: opId,
        updated_at: NOW,
      })
      .where(slot)
      .where(deprecationDiffers);
    updatedInputs.set(statements.length, input.version);
    push('inplace', compile(inPlace));
  }

  assertBatchStatementCount(statements.length);
  const bytes = statements
    .flatMap((statement) => statement.params)
    .reduce<number>(
      (total, value) =>
        total +
        (typeof value === 'string'
          ? ENCODER.encode(value).length
          : value instanceof Uint8Array
            ? value.byteLength
            : value === null
              ? 0
              : 8),
      0,
    );
  if (bytes > MAX_BATCH_PARAMETER_BYTES) {
    throw Object.assign(new RangeError('batch parameter payload exceeds 4 MiB'), {
      code: 'batch_too_large' as const,
    });
  }
  return finish();
}
