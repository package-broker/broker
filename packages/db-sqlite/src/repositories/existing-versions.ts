import type {
  ExistingVersion,
  ExistingVersionsQuery,
  ExistingVersionsReader,
} from '@package-broker/core/db/existing-versions';
import type {
  OrgContext,
  ScalarSqlExecutor,
  ScalarStatement,
  SqlValue,
  Statement,
} from '@package-broker/core/db/port';
import type { Compilable } from 'kysely';
import { compile, db } from '../kysely.js';

export const EXISTING_VERSIONS_KEY_ROWS = 1000;
export const EXISTING_VERSIONS_METADATA_ROWS = 200;
export const EXISTING_VERSIONS_METADATA_BYTES = 4 * 1024 * 1024;

export type {
  ExistingVersion,
  ExistingVersionsPage,
  ExistingVersionsQuery,
  ExistingVersionsReader,
} from '@package-broker/core/db/existing-versions';

interface Row {
  readonly version_normalized: string;
  readonly id: string;
  readonly revision: number;
  readonly status: string;
  readonly npm_integrity: string | null;
  readonly composer_shasum: string | null;
  readonly metadata_json?: string;
}

function validate(query: ExistingVersionsQuery): number {
  if (
    typeof query?.packageId !== 'string' ||
    query.packageId === '' ||
    (query.after !== null && (typeof query.after !== 'string' || query.after === '')) ||
    typeof query.withMetadata !== 'boolean' ||
    !Number.isSafeInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > EXISTING_VERSIONS_KEY_ROWS
  ) {
    throw new TypeError('invalid existing versions query');
  }
  return query.withMetadata ? Math.min(query.limit, EXISTING_VERSIONS_METADATA_ROWS) : query.limit;
}

function toVersion(row: Row): ExistingVersion {
  const base = {
    versionNormalized: row.version_normalized,
    id: row.id,
    revision: row.revision,
    status: row.status,
    npmIntegrity: row.npm_integrity,
    composerShasum: row.composer_shasum,
  };
  return row.metadata_json === undefined ? base : { ...base, metadataJson: row.metadata_json };
}

const KEY_COLUMNS = `version_normalized, id, revision, status, npm_integrity, composer_shasum`;

/**
 * The byte budget is enforced inside SQLite: rows past the budget come back with a NULL
 * metadata_json (the probe row beyond `limit` always does), so oversized values never reach the
 * caller. The first row is always kept so a single oversized version still makes progress.
 */
function sizedStatement(ctx: OrgContext, query: ExistingVersionsQuery, limit: number): Statement {
  const cursor = query.after === null ? '' : 'AND version_normalized > ?';
  const params: SqlValue[] = [limit, EXISTING_VERSIONS_METADATA_BYTES, ctx.orgId, query.packageId];
  if (query.after !== null) params.push(query.after);
  params.push(limit + 1);
  return {
    sql: `SELECT ${KEY_COLUMNS},
  CASE WHEN rn <= ? AND (rn = 1 OR cumulative <= ?) THEN metadata_json END AS metadata_json
FROM (
  SELECT ${KEY_COLUMNS}, metadata_json,
    row_number() OVER (ORDER BY version_normalized) AS rn,
    sum(length(CAST(metadata_json AS BLOB))) OVER (ORDER BY version_normalized) AS cumulative
  FROM (
    SELECT ${KEY_COLUMNS}, metadata_json FROM version
    WHERE org_id = ? AND package_id = ? ${cursor}
    ORDER BY version_normalized LIMIT ?
  )
)
ORDER BY version_normalized`,
    params,
  };
}

export function createExistingVersionsReader(executor: ScalarSqlExecutor): ExistingVersionsReader {
  return {
    async existingVersions(ctx, query) {
      const limit = validate(query);
      const keys = db
        .selectFrom('version')
        .select([
          'version_normalized',
          'id',
          'revision',
          'status',
          'npm_integrity',
          'composer_shasum',
        ])
        .where('org_id', '=', ctx.orgId)
        .where('package_id', '=', query.packageId)
        .$if(query.after !== null, (qb) =>
          qb.where('version_normalized', '>', query.after as string),
        )
        .orderBy('version_normalized')
        .limit(limit + 1);
      const statement = query.withMetadata
        ? sizedStatement(ctx, query, limit)
        : compile(keys as Compilable);

      const fetched = await executor.all<Row>(statement as ScalarStatement);
      let kept = fetched.slice(0, limit);
      let more = fetched.length > limit;
      if (query.withMetadata) {
        const fitting = kept.filter((row) => row.metadata_json != null);
        more = more || fitting.length < kept.length;
        kept = fitting;
      }
      const last = kept.at(-1);
      return {
        rows: kept.map(toVersion),
        next: more && last !== undefined ? last.version_normalized : null,
      };
    },
  };
}
