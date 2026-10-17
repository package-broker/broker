import { sql, type SqlBool } from 'kysely';
import { type CatalogueWriteGuard } from '@package-broker/core/db/catalogue';
import type { OrgContext, Statement } from '@package-broker/core/db/port';
import { MAX_KEY_LENGTH, type NameEcosystem } from '@package-broker/core/catalogue/names';
import type { JobGuard } from '@package-broker/core/platform/job-repository';
import { assertCheck, compile, db, newOpId } from '../kysely.js';
import {
  registerCatalogueWriteGuard,
  assertCatalogueWriteGuard,
} from '../internal/catalogue-write-guard.js';
import { jobLeaseGuard } from './job-lease-guard.js';
import { rederiveStatements } from './visibility-derive.js';

export const MAX_DESCRIPTION_BYTES = 4096;
export const MAX_SOURCE_ID_LENGTH = 512;

const CONTROL = /\p{Cc}/u;

const ENCODER = new TextEncoder();
const ECOSYSTEMS: ReadonlySet<string> = new Set<NameEcosystem>(['composer', 'npm']);

export interface PackageUpsertInput {
  readonly sourceId: string;
  readonly ecosystem: NameEcosystem;
  readonly key: string;
  readonly description: string | null;
}

export interface PackageUpsertPlan {
  readonly candidateId: string;
  readonly statements: readonly Statement[];
}

export function createCatalogueWriteGuard(ctx: OrgContext, guard: JobGuard): CatalogueWriteGuard {
  return registerCatalogueWriteGuard(ctx, jobLeaseGuard(ctx, guard));
}

function validated(input: PackageUpsertInput): PackageUpsertInput {
  const { sourceId, ecosystem, key, description } = input;
  if (
    typeof sourceId !== 'string' ||
    sourceId.length === 0 ||
    sourceId.length > MAX_SOURCE_ID_LENGTH
  ) {
    throw new RangeError(
      `sourceId must be a non-empty string of at most ${String(MAX_SOURCE_ID_LENGTH)} characters`,
    );
  }
  if (!ECOSYSTEMS.has(ecosystem)) throw new RangeError('unknown ecosystem');
  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    key.length > MAX_KEY_LENGTH ||
    key !== key.toLowerCase() ||
    CONTROL.test(key)
  ) {
    throw new RangeError('key must be a lower-case package key');
  }
  if (description !== null) {
    if (typeof description !== 'string') throw new RangeError('description must be text or null');
    if (ENCODER.encode(description).length > MAX_DESCRIPTION_BYTES) {
      throw new RangeError(`description exceeds ${String(MAX_DESCRIPTION_BYTES)} bytes`);
    }
  }
  return input;
}

const monotonicNow = sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', max(
  unixepoch('now', 'subsec'),
  unixepoch(package.modified_at, 'subsec') + 0.001
), 'unixepoch')`;

/**
 * Creates the package when absent and re-derives project_package for it in the same batch.
 * Re-derivation is scoped to the fresh candidate id, so it acts only when this batch inserted
 * the row; an existing package keeps its flag and memberships.
 */
export function packageUpsertStatements(
  ctx: OrgContext,
  guard: CatalogueWriteGuard,
  input: PackageUpsertInput,
): PackageUpsertPlan {
  assertCatalogueWriteGuard(ctx, guard);
  const { sourceId, ecosystem, key, description } = validated(input);
  const candidateId = newOpId();

  const create = db
    .insertInto('package')
    .columns([
      'id',
      'org_id',
      'source_id',
      'ecosystem',
      'name',
      'description',
      'visible_to_new_projects',
    ])
    .expression(
      db
        .selectFrom('source')
        .select([
          sql<string>`${candidateId}`.as('id'),
          'source.org_id',
          'source.id',
          'source.ecosystem',
          sql<string>`${key}`.as('name'),
          sql<string | null>`${description}`.as('description'),
          'source.default_visible_to_new_projects',
        ])
        .where('source.id', '=', sourceId)
        .where('source.org_id', '=', ctx.orgId)
        .where('source.ecosystem', '=', ecosystem),
    )
    .onConflict((oc) => oc.columns(['org_id', 'ecosystem', 'source_id', 'name']).doNothing());

  const describe = db
    .updateTable('package')
    .set({
      description,
      rev: sql<number>`package.rev + 1`,
      modified_at: monotonicNow,
    })
    .where('package.org_id', '=', ctx.orgId)
    .where('package.ecosystem', '=', ecosystem)
    .where('package.source_id', '=', sourceId)
    .where('package.name', '=', key)
    .where(sql<SqlBool>`package.description is not ${description}`);

  const sourceMatches = assertCheck(
    sql<boolean>`EXISTS (SELECT 1 FROM source
      WHERE source.id = ${sourceId} AND source.org_id = ${ctx.orgId}
        AND source.ecosystem = ${ecosystem})`,
  );

  return {
    candidateId,
    statements: [
      ...guard,
      ...sourceMatches,
      compile(create),
      compile(describe),
      ...rederiveStatements(ctx, { kind: 'package', packageId: candidateId }),
    ],
  };
}
