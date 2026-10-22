import { sql, type Expression, type SqlBool } from 'kysely';
import type { OrgContext } from '@package-broker/core/db/port';
import { MAX_PATTERN_BYTES, MAX_PATTERN_WILDCARDS } from '@package-broker/core/catalogue/patterns';
import { coveredByRegisteredNames } from './registered-name.js';

/** Current refresh selection; deliberately separate from read-time visibility. */
export function sourceSelectionCondition(
  ctx: OrgContext,
  sourceId: string | Expression<string>,
  ecosystem: 'composer' | 'npm' | Expression<string>,
  key: string | Expression<string>,
  allowUnconfigured = false,
): Expression<SqlBool> {
  const config = sql`CASE WHEN json_valid(selection_source.config_json)
    THEN selection_source.config_json ELSE '{}' END`;
  const registered = coveredByRegisteredNames(ctx, sourceId, ecosystem, key);
  // Existing catalogue packages also predate refresh configuration on a source.
  const unconfigured = allowUnconfigured
    ? sql`OR (selection_source.config_json = '{}' AND selection_source.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM registered_name AS selection_registration
          WHERE selection_registration.org_id = ${ctx.orgId}
            AND selection_registration.source_id = selection_source.id))`
    : sql``;
  return sql<SqlBool>`EXISTS (SELECT 1 FROM source AS selection_source
    WHERE selection_source.org_id = ${ctx.orgId} AND selection_source.id = ${sourceId}
      AND selection_source.ecosystem = ${ecosystem}
      AND (selection_source.type IN ('packagist_proxy', 'npmjs_proxy')
        ${unconfigured}
        OR (${registered} AND (
          (selection_source.type = 'vcs')
          OR (selection_source.type = 'npm_registry' AND EXISTS (
            SELECT 1 FROM json_each(${config}, '$.scopes') AS selected_scope
            WHERE selected_scope.type = 'text'
              AND substr(${key}, 1, instr(${key}, '/') - 1) = selected_scope.value))
          OR (selection_source.type = 'composer_repository' AND (
            EXISTS (SELECT 1 FROM json_each(${config}, '$.selection.packages') AS selected_name
              WHERE selected_name.type = 'text' AND selected_name.value = ${key})
            OR EXISTS (SELECT 1 FROM json_each(${config}, '$.selection.patterns') AS selected_pattern
              WHERE CASE WHEN selected_pattern.type = 'text'
                AND selected_pattern.value NOT GLOB '*[^a-z0-9._~@!/*-]*'
                AND length(selected_pattern.value) BETWEEN 1 AND ${sql.lit(MAX_PATTERN_BYTES)}
                AND length(selected_pattern.value) - length(replace(selected_pattern.value, '*', '')) <= ${sql.lit(MAX_PATTERN_WILDCARDS)}
                THEN ${key} GLOB selected_pattern.value ELSE 0 END)))))))`;
}
