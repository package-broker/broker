import { sql, type Kysely } from 'kysely';
import type { CatalogueReader, PackageRef } from '@package-broker/core/db/catalogue';
import type { NameEcosystem } from '@package-broker/core/catalogue/names';
import type { OrgContext, ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import { compile, db, guardAliases } from '../kysely.js';
import {
  admissionCondition,
  attachedSourceCondition,
  col,
  proxyEligibleCondition,
} from './catalogue-predicates.js';

type LooseDatabase = Record<string, Record<string, unknown>>;

const loose = db as unknown as Kysely<LooseDatabase>;

/**
 * Attached proxy sources that may be asked upstream for the key of `keyRow`, ordered by precedence
 * then id. `keyRow` is a table alias in scope exposing `org_id`, `ecosystem` and `name`; it may be
 * an outer row, which makes the query correlated. Internal aliases never shadow `keyRow`.
 */
export function admittedProxySources(
  ctx: OrgContext,
  projectId: string,
  ecosystem: NameEcosystem,
  keyRow: string,
) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyRow)) {
    throw new TypeError('keyRow must be a plain table alias');
  }
  const { ps, src, prj } = guardAliases(['ps', 'src', 'prj'], keyRow);
  const key = (column: string) => col(`${keyRow}.${column}`);
  return loose
    .selectFrom(`project_source as ${ps}`)
    .innerJoin(`source as ${src}`, `${src}.id`, `${ps}.source_id`)
    .innerJoin(`project as ${prj}`, `${prj}.id`, `${ps}.project_id`)
    .select(sql<string>`${sql.ref(`${ps}.source_id`)}`.as('source_id'))
    .where(`${ps}.project_id`, '=', projectId)
    .where(`${ps}.org_id`, '=', ctx.orgId)
    .where(`${src}.org_id`, '=', ctx.orgId)
    .where(`${prj}.org_id`, '=', ctx.orgId)
    .where(`${prj}.status`, '=', 'active')
    .where(`${src}.ecosystem`, '=', ecosystem)
    .where(`${src}.type`, 'in', ['packagist_proxy', 'npmjs_proxy'])
    .where(key('org_id'), '=', ctx.orgId)
    .where(key('ecosystem'), '=', ecosystem)
    .where(
      attachedSourceCondition(
        ctx,
        col(`${ps}.project_id`),
        col(`${ps}.source_id`),
        col(`${src}.ecosystem`),
      ),
    )
    .where(proxyEligibleCondition({ package: keyRow, source: src }))
    .where(
      admissionCondition(
        col(`${ps}.project_id`),
        col(`${ps}.source_id`),
        key('name'),
        col(`${src}.default_visible_to_new_projects`),
      ),
    )
    .orderBy(`${ps}.precedence`)
    .orderBy(`${ps}.source_id`);
}

function statement(ctx: OrgContext, query: PackageRef): ScalarStatement {
  const key = sql`(select ${ctx.orgId} as org_id, ${query.ecosystem} as ecosystem, ${query.key} as name)`;
  const raw = admittedProxySources(ctx, query.projectId, query.ecosystem, 'k').innerJoin(
    key.as('k'),
    (join) => join.onTrue(),
  );
  return compile(raw) as ScalarStatement;
}

export function createProxyAdmission(
  executor: ScalarSqlExecutor,
): Pick<CatalogueReader, 'admitProxy'> {
  return {
    async admitProxy(ctx, query) {
      const rows = await executor.all<{ source_id: string }>(statement(ctx, query));
      return rows.map((row) => row.source_id);
    },
  };
}
