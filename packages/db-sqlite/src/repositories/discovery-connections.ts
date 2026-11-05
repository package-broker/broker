import type { OrgContext, ScalarSqlExecutor } from '@package-broker/core/db/port';

/** Metadata only: credential material is never selected or opened. */
export function createDiscoveryConnections(executor: ScalarSqlExecutor) {
  return {
    async list(ctx: OrgContext) {
      const rows = await executor.all<{
        credential_id: string;
        installation_id: number;
        source_names: string;
        source_count: number;
      }>({
        sql: `WITH connections AS (
          SELECT s.credential_id, json_extract(s.config_json, '$.installationId') AS installation_id,
            s.name,
            row_number() OVER (
              PARTITION BY s.credential_id, json_extract(s.config_json, '$.installationId')
              ORDER BY s.name, s.id
            ) AS position
          FROM source s JOIN credential c ON c.id = s.credential_id
          WHERE s.org_id = ? AND c.org_id = ?
            AND s.project_id IS NULL AND c.project_id IS NULL AND c.kind = 'github_app'
            AND s.type = 'vcs' AND json_extract(s.config_json, '$.provider') = 'github'
            AND json_type(s.config_json, '$.installationId') = 'integer'
            AND json_extract(s.config_json, '$.installationId') >= 1
            AND json_extract(s.config_json, '$.installationId') <= 9007199254740991
        )
        SELECT credential_id, installation_id,
          json_group_array(name) FILTER (WHERE position <= 5) AS source_names,
          count(*) AS source_count
        FROM (SELECT * FROM connections ORDER BY credential_id, installation_id, position) GROUP BY credential_id, installation_id
        ORDER BY credential_id, installation_id LIMIT 100`,
        params: [ctx.orgId, ctx.orgId],
      });
      return rows.map((row) => ({
        credentialId: row.credential_id,
        installationId: row.installation_id,
        sourceNames: JSON.parse(row.source_names) as string[],
        sourceCount: row.source_count,
      }));
    },
  };
}
