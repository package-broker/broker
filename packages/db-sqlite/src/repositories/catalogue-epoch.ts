import type { ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import type { EpochReader } from '@package-broker/core/platform/cache';
import { compile, db } from '../kysely.js';
import { parseEpochRows } from './cache-epoch.js';

/** Reads the live organization epoch for a resolved package, including after visibility narrows. */
export function createCatalogueEpochReader(
  executor: ScalarSqlExecutor,
  packageId: string,
): EpochReader {
  return {
    async read(ctx) {
      const statement = compile(
        db
          .selectFrom('cache_epoch')
          .select('cache_epoch.version')
          .where('cache_epoch.org_id', '=', ctx.orgId)
          .where((eb) =>
            eb.exists(
              eb
                .selectFrom('package')
                .select('package.id')
                .where('package.id', '=', packageId)
                .where('package.org_id', '=', ctx.orgId),
            ),
          ),
      ) as ScalarStatement;
      return parseEpochRows(await executor.all<{ version: string }>(statement));
    },
  };
}
