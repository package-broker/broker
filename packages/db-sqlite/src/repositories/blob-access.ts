import { sql, type SqlBool } from 'kysely';
import type { OrgContext, ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import { compile, db } from '../kysely.js';

export const MAX_TOUCH_IDS = 200;

const FORMAT = '%Y-%m-%dT%H:%M:%fZ';
const NOW = sql<string>`strftime(${sql.lit(FORMAT)}, 'now')`;
const DAY_AGO = sql<string>`strftime(${sql.lit(FORMAT)}, 'now', '-1 day')`;

export interface BlobAccessRepository {
  touch(ctx: OrgContext, blobIds: readonly string[]): Promise<number>;
}

export function createBlobAccessRepository(executor: ScalarSqlExecutor): BlobAccessRepository {
  return {
    async touch(ctx, blobIds) {
      if (!Array.isArray(blobIds)) throw new TypeError('blob ids must be an array');
      if (blobIds.length > MAX_TOUCH_IDS) throw new RangeError('blob access batch is too large');
      if (blobIds.some((id) => typeof id !== 'string' || id === '')) {
        throw new TypeError('blob id must be a non-empty string');
      }
      const ids = [...new Set(blobIds)];
      if (ids.length === 0) return 0;
      const query = db
        .updateTable('blob')
        .set({ last_accessed_at: NOW })
        .where('org_id', '=', ctx.orgId)
        .where('deleted_at', 'is', null)
        .where(sql<SqlBool>`id in (select value from json_each(${JSON.stringify(ids)}))`)
        .where((eb) =>
          eb.or([eb('last_accessed_at', 'is', null), eb('last_accessed_at', '<', DAY_AGO)]),
        );
      const [result] = await executor.batch([compile(query) as ScalarStatement]);
      return result?.changes ?? 0;
    },
  };
}
