import { DbError } from '@package-broker/core/db/errors';
import type { OrgContext, ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import type { EpochReader } from '@package-broker/core/platform/cache';
import { compile, db } from '../kysely.js';

const VERSION = /^[0-9A-F]{32}$/;

interface VersionRow {
  readonly version: string;
}

/**
 * The epoch read as a statement, so the caller can place it in the same batch as the authorized
 * catalogue read. Read ordering (C2) is the caller's responsibility: the epoch must be read in the
 * same batch as, or strictly before, that catalogue read.
 */
export function epochReadStatement(ctx: OrgContext): ScalarStatement {
  return compile(
    db
      .selectFrom('cache_epoch')
      .select('cache_epoch.version')
      .where('cache_epoch.org_id', '=', ctx.orgId),
  ) as ScalarStatement;
}

export function parseEpochRows(rows: readonly VersionRow[]): string | null {
  const row = rows[0];
  if (row === undefined) return null;
  if (typeof row.version !== 'string' || !VERSION.test(row.version)) {
    throw new DbError('unknown', 'cache_epoch_invalid', { constraint: 'cache_epoch.version' });
  }
  return row.version;
}

export function createCacheEpochRepository(executor: ScalarSqlExecutor): EpochReader {
  return {
    async read(ctx) {
      return parseEpochRows(await executor.all<VersionRow>(epochReadStatement(ctx)));
    },
  };
}
