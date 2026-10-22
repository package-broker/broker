import { sql } from 'kysely';
import type { OrgContext } from '@package-broker/core/db/port';

export function sourceSelectionRevision(ctx: OrgContext, sourceId: string) {
  return sql<string>`(SELECT json_array(source.config_json, source.status = 'active',
      (SELECT json_group_array(registration.pattern) FROM (
        SELECT registered_name.pattern FROM registered_name
        WHERE registered_name.org_id = ${ctx.orgId} AND registered_name.source_id = ${sourceId}
        ORDER BY registered_name.pattern) AS registration))
    FROM source WHERE source.org_id = ${ctx.orgId} AND source.id = ${sourceId})`;
}
