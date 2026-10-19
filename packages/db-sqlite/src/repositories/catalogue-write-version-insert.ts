import { sql } from 'kysely';
import {
  CATALOGUE_SYNC_VERSIONS_PER_CALL,
  type CatalogueWriteGuard,
  type VersionInput,
  type SyncRefusal,
  type SyncResult,
} from '@package-broker/core/db/catalogue';
import type { OrgContext, Statement, StatementResult } from '@package-broker/core/db/port';
import { MAX_METADATA_BYTES } from '@package-broker/core/catalogue/metadata';
import { validateVersion, type VersionEcosystem } from '@package-broker/core/catalogue/versions';
import { parseHistoryDate } from '@package-broker/core/catalogue/version-rules';
import { assertCheck, compile, db, newOpId } from '../kysely.js';
import { assertCatalogueWriteGuard, monotonicNow } from '../internal/catalogue-write-guard.js';

export const MAX_VERSIONS_PER_CALL = CATALOGUE_SYNC_VERSIONS_PER_CALL;
const MAX_BATCH_PARAMETER_BYTES = 4 * 1024 * 1024;

const CONTROL = /\p{Cc}/u;
const ENCODER = new TextEncoder();
const NOW = sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

export interface VersionInsertRequest {
  readonly packageId: string;
  readonly ecosystem: VersionEcosystem;
  readonly versions: readonly VersionInput[];
}

export interface VersionInsertPlan {
  readonly opId: string;
  readonly refused: SyncResult['refused'];
  readonly statements: readonly Statement[];
  /** Call after successful execution of this plan's complete batch. */
  result(results: readonly StatementResult[]): SyncResult;
}

interface Accepted {
  readonly input: VersionInput;
  readonly stability: string;
}

function refusalOf(input: VersionInput, ecosystem: VersionEcosystem): SyncRefusal | Accepted {
  let stability: string;
  try {
    stability = validateVersion({
      ecosystem,
      version: input.version,
      versionNormalized: input.versionNormalized,
    }).stability;
  } catch {
    return 'invalid';
  }
  try {
    parseHistoryDate(input.history);
    if (input.upstreamReleasedAt !== null) {
      parseHistoryDate({ basis: 'release_date', at: input.upstreamReleasedAt });
    }
  } catch {
    return 'invalid';
  }
  for (const [value, cap] of [
    [input.license, 256],
    [input.sourceRef, 512],
  ] as const) {
    if (
      value !== null &&
      (typeof value !== 'string' || CONTROL.test(value) || ENCODER.encode(value).length > cap)
    )
      return 'invalid';
  }
  if (ENCODER.encode(input.metadata.json).length > MAX_METADATA_BYTES) return 'too_large';
  return { input, stability };
}

/**
 * Inserts new versions for one package. published_at and its basis are chosen in SQL by the
 * package's phase and are never updated: while package.last_synced_at is NULL the supplied
 * upstream date and basis apply, afterwards database time and 'broker'. An existing slot
 * (including a tombstoned one) is left untouched, and the package clock advances only when
 * this batch inserted a row.
 */
export function versionInsertStatements(
  ctx: OrgContext,
  guard: CatalogueWriteGuard,
  request: VersionInsertRequest,
): VersionInsertPlan {
  assertCatalogueWriteGuard(ctx, guard);
  const { packageId, ecosystem, versions } = request;
  if (versions.length === 0 || versions.length > MAX_VERSIONS_PER_CALL) {
    throw new RangeError(`a call carries between 1 and ${String(MAX_VERSIONS_PER_CALL)} versions`);
  }
  const opId = newOpId();
  const accepted: Accepted[] = [];
  const refused: { version: string; reason: SyncRefusal }[] = [];
  const seen = new Set<string>();
  for (const input of versions) {
    const verdict = seen.has(input.versionNormalized) ? 'invalid' : refusalOf(input, ecosystem);
    seen.add(input.versionNormalized);
    if (typeof verdict === 'string') {
      refused.push({ version: input.version, reason: verdict });
    } else {
      accepted.push(verdict);
    }
  }
  const plan = (statements: readonly Statement[], insertOffset = 0): VersionInsertPlan => ({
    opId,
    refused,
    statements,
    result(results) {
      if (results.length !== statements.length)
        throw new TypeError('incomplete version insert results');
      const inserted = results
        .slice(insertOffset, insertOffset + accepted.length)
        .reduce((sum, result) => sum + result.changes, 0);
      return {
        packageId,
        inserted,
        updated: 0,
        unchanged: statements.length === 0 ? 0 : accepted.length - inserted,
        conflicts: [],
        refused,
        skippedTags: [],
        statements: statements.length,
      };
    },
  });
  if (accepted.length === 0) return plan([]);

  const latestHistory = accepted.reduce(
    (max, { input }) => (input.history.at > max ? input.history.at : max),
    '',
  );
  const packageMatches = assertCheck(
    sql<boolean>`EXISTS (SELECT 1 FROM package
      WHERE package.id = ${packageId} AND package.org_id = ${ctx.orgId}
        AND package.ecosystem = ${ecosystem})`,
  );
  const historyNotFuture = assertCheck(
    sql<boolean>`NOT EXISTS (SELECT 1 FROM package
      WHERE package.id = ${packageId} AND package.last_synced_at IS NULL
        AND ${latestHistory} > ${NOW})`,
  );

  const inserts = accepted.map(({ input, stability }) =>
    compile(
      db
        .insertInto('version')
        .columns([
          'id',
          'org_id',
          'package_id',
          'version',
          'version_normalized',
          'stability',
          'published_at',
          'published_at_basis',
          'upstream_released_at',
          'license',
          'dist_type',
          'composer_shasum',
          'npm_integrity',
          'source_ref',
          'metadata_json',
          'deprecated_message',
          'last_op_id',
        ])
        .expression(
          db
            .selectFrom('package')
            .select([
              sql<string>`${newOpId()}`.as('id'),
              'package.org_id',
              'package.id',
              sql<string>`${input.version}`.as('version'),
              sql<string>`${input.versionNormalized}`.as('version_normalized'),
              sql<string>`${stability}`.as('stability'),
              sql<string>`CASE WHEN package.last_synced_at IS NULL THEN ${input.history.at} ELSE ${NOW} END`.as(
                'published_at',
              ),
              sql<string>`CASE WHEN package.last_synced_at IS NULL THEN ${input.history.basis} ELSE 'broker' END`.as(
                'published_at_basis',
              ),
              sql<string | null>`${input.upstreamReleasedAt}`.as('upstream_released_at'),
              sql<string | null>`${input.license}`.as('license'),
              sql<string | null>`${input.distType}`.as('dist_type'),
              sql<string | null>`${input.metadata.composerShasum}`.as('composer_shasum'),
              sql<string | null>`${input.metadata.npmIntegrity}`.as('npm_integrity'),
              sql<string | null>`${input.sourceRef}`.as('source_ref'),
              sql<string>`${input.metadata.json}`.as('metadata_json'),
              sql<string | null>`${input.metadata.deprecatedMessage}`.as('deprecated_message'),
              sql<string>`${opId}`.as('last_op_id'),
            ])
            .where('package.id', '=', packageId)
            .where('package.org_id', '=', ctx.orgId),
        )
        .onConflict((oc) => oc.columns(['package_id', 'version_normalized']).doNothing()),
    ),
  );

  const advance = db
    .updateTable('package')
    .set({
      rev: sql<number>`package.rev + 1`,
      modified_at: monotonicNow,
    })
    .where('package.id', '=', packageId)
    .where('package.org_id', '=', ctx.orgId)
    .where(
      sql<boolean>`EXISTS (SELECT 1 FROM version
        WHERE version.package_id = package.id AND version.last_op_id = ${opId})`,
    );

  const statements = [
    ...guard,
    ...packageMatches,
    ...historyNotFuture,
    ...inserts,
    compile(advance),
  ];
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
  return plan(statements, guard.length + packageMatches.length + historyNotFuture.length);
}
