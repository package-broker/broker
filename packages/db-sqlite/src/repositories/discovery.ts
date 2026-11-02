import { sql } from 'kysely';
import type { OrgContext, ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import type { BulkDiscoveryDeps } from '@package-broker/core/sources/bulk-discovery';
import { compile, db } from '../kysely.js';

export function createDiscoveryRepositoryReader(
  executor: ScalarSqlExecutor,
): BulkDiscoveryDeps['existingRepository'] {
  return {
    async has(ctx: OrgContext, repository, ecosystem) {
      const rows = await executor.all(
        compile(
          db
            .selectFrom('source')
            .select('id')
            .where('org_id', '=', ctx.orgId)
            .where('project_id', 'is', null)
            .where('type', '=', 'vcs')
            .where('ecosystem', '=', ecosystem)
            .where(
              sql<boolean>`json_extract(config_json, '$.provider') = 'github' AND lower(json_extract(config_json, '$.repository')) = ${repository.toLowerCase()}`,
            )
            .limit(1),
        ) as ScalarStatement,
      );
      return rows.length > 0;
    },
    async hasSourceName(ctx: OrgContext, name) {
      const rows = await executor.all(
        compile(
          db
            .selectFrom('source')
            .select('id')
            .where('org_id', '=', ctx.orgId)
            .where('project_id', 'is', null)
            .where('name', '=', name)
            .limit(1),
        ) as ScalarStatement,
      );
      return rows.length > 0;
    },
  };
}
