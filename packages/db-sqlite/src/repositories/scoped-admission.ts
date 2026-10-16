import { sql } from 'kysely';
import type { OrgContext, ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import { compile, db } from '../kysely.js';
import { admissionCondition, attachedSourceCondition, col } from './catalogue-predicates.js';

export function createScopedAdmission(executor: ScalarSqlExecutor) {
  return {
    async admitScoped(
      ctx: OrgContext,
      query: { readonly projectId: string; readonly key: string },
    ): Promise<readonly string[]> {
      const slash = query.key.indexOf('/');
      const scope =
        query.key.startsWith('@') &&
        slash > 1 &&
        slash < query.key.length - 1 &&
        query.key.indexOf('/', slash + 1) === -1
          ? query.key.slice(0, slash)
          : null;
      const statement = db
        .selectFrom('source as src')
        .innerJoin('project_source as ps', 'ps.source_id', 'src.id')
        .innerJoin('project as prj', 'prj.id', 'ps.project_id')
        .select('src.id as source_id')
        .where('ps.project_id', '=', query.projectId)
        .where('prj.org_id', '=', ctx.orgId)
        .where('prj.status', '=', 'active')
        .where('src.type', '=', 'npm_registry')
        .where('src.ecosystem', '=', 'npm')
        .where('src.status', '=', 'active')
        .where(
          attachedSourceCondition(ctx, col('ps.project_id'), col('src.id'), col('src.ecosystem')),
        )
        .where(
          sql<boolean>`exists (
          select 1 from json_each(src.config_json, '$.scopes') as scope
          where scope.value = ${scope}
        )`,
        )
        .where(
          sql<boolean>`exists (
          select 1 from registered_name as rn
          where rn.source_id = src.id and rn.org_id = ${ctx.orgId}
            and rn.ecosystem = 'npm' and rn.pattern = ${scope === null ? null : `${scope}/*`}
        )`,
        )
        .where(
          admissionCondition(
            col('ps.project_id'),
            col('src.id'),
            sql.val(query.key),
            col('src.default_visible_to_new_projects'),
          ),
        )
        .where(
          sql<boolean>`not exists (
          select 1 from package as pkg
          where pkg.org_id = ${ctx.orgId} and pkg.source_id = src.id
            and pkg.ecosystem = 'npm' and pkg.name = ${query.key}
        )`,
        )
        .orderBy('ps.precedence')
        .orderBy('src.id');
      const rows = await executor.all<{ source_id: string }>(compile(statement) as ScalarStatement);
      return rows.map((row) => row.source_id);
    },
  };
}
