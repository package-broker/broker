import { sql } from 'kysely';
import type { OrgContext, ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import type { BulkDiscoveryDeps } from '@package-broker/core/sources/bulk-discovery';
import { compile, db } from '../kysely.js';

export function createDiscoveryRepositoryReader(
  executor: ScalarSqlExecutor,
): BulkDiscoveryDeps['existingRepository'] {
  return {
    async pending(ctx, fence, repository, ecosystem) {
      const [row] = await executor.all<{ id: string; named: number }>({
        sql: `select s.id,exists(select 1 from registered_name n where n.org_id=s.org_id and n.source_id=s.id) as named
        from source s join source_discovery_admission da on da.org_id=s.org_id and da.source_id=s.id
        join source_discovery_rule dr on dr.org_id=da.org_id and dr.id=da.rule_id
        where s.org_id=? and da.rule_id=? and s.status='paused' and s.ecosystem=?
          and lower(json_extract(s.config_json,'$.repository'))=? limit 1`,
        params: [ctx.orgId, fence.ruleId, ecosystem, repository.toLowerCase()],
      });
      return row === undefined ? null : { id: row.id, named: row.named === 1 };
    },
    async has(ctx: OrgContext, repository, ecosystem, fence) {
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
              fence === undefined
                ? sql<boolean>`1`
                : sql<boolean>`not (status='paused' and exists(select 1 from source_discovery_admission da join source_discovery_rule dr on dr.org_id=da.org_id and dr.id=da.rule_id where da.org_id=${ctx.orgId} and da.source_id=source.id and da.rule_id=${fence.ruleId}))`,
            )
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
