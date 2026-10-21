import { sql, type Expression, type RawBuilder, type SqlBool } from 'kysely';
import type { OrgContext, Statement } from '@package-broker/core/db/port';
import type { ProjectPackageOrigin } from '../schema.js';
import { compile, db } from '../kysely.js';
import {
  admissionCondition,
  attachedSourceCondition,
  col,
  type Ref,
} from './catalogue-predicates.js';

export type DeriveScope =
  | { readonly kind: 'project'; readonly projectId: string }
  | { readonly kind: 'projectSource'; readonly projectId: string; readonly sourceId: string }
  | { readonly kind: 'package'; readonly packageId: string };

const ROW = 'project_package';

function derivedOrigin(
  ctx: OrgContext,
  projectRef: Ref,
  sourceRef: Expression<unknown>,
): RawBuilder<ProjectPackageOrigin> {
  return sql<ProjectPackageOrigin>`case when exists (
    select 1 from project_package_pattern as derive_include
    where derive_include.org_id = ${ctx.orgId}
      and derive_include.project_id = ${projectRef}
      and derive_include.source_id = ${sourceRef}
      and derive_include.effect = 'include'
  ) then 'pattern' else 'subscription' end`;
}

function derivedFor(ctx: OrgContext, projectRef: Ref, pkg: string): Expression<SqlBool> {
  const k = (column: string) => col(`${pkg}.${column}`);
  return sql<SqlBool>`(
    ${k('org_id')} = ${ctx.orgId}
    and ${attachedSourceCondition(ctx, projectRef, k('source_id'), k('ecosystem'))}
    and ${admissionCondition(ctx, projectRef, k('source_id'), k('name'), k('visible_to_new_projects'))}
  )`;
}

function rowInScope(scope: DeriveScope): Expression<SqlBool> {
  const project = col(`${ROW}.project_id`);
  const pkg = col(`${ROW}.package_id`);
  switch (scope.kind) {
    case 'project':
      return sql<SqlBool>`${project} = ${scope.projectId}`;
    case 'package':
      return sql<SqlBool>`${pkg} = ${scope.packageId}`;
    case 'projectSource':
      return sql<SqlBool>`${project} = ${scope.projectId} and exists (
        select 1 from package as scope_package
        where scope_package.id = ${pkg} and scope_package.source_id = ${scope.sourceId}
      )`;
  }
}

function candidateInScope(scope: DeriveScope): Expression<SqlBool> {
  switch (scope.kind) {
    case 'project':
      return sql<SqlBool>`${col('derive_attachment.project_id')} = ${scope.projectId}`;
    case 'package':
      return sql<SqlBool>`${col('derive_package.id')} = ${scope.packageId}`;
    case 'projectSource':
      return sql<SqlBool>`${col('derive_attachment.project_id')} = ${scope.projectId}
        and ${col('derive_package.source_id')} = ${scope.sourceId}`;
  }
}

export function rederiveStatements(ctx: OrgContext, scope: DeriveScope): Statement[] {
  const rowProject = col(`${ROW}.project_id`);
  const rowSource = sql`(select source_id from package as row_package where row_package.id = ${col(`${ROW}.package_id`)})`;

  const remove = db
    .deleteFrom(ROW)
    .where(`${ROW}.org_id`, '=', ctx.orgId)
    .where(`${ROW}.origin`, '<>', 'explicit')
    .where(rowInScope(scope))
    .where(
      sql<SqlBool>`not exists (
        select 1 from package as stay_package
        where stay_package.id = ${col(`${ROW}.package_id`)}
          and ${derivedFor(ctx, rowProject, 'stay_package')}
      )`,
    );

  const origin = derivedOrigin(ctx, rowProject, rowSource);
  const retag = db
    .updateTable(ROW)
    .set({ origin })
    .where(`${ROW}.org_id`, '=', ctx.orgId)
    .where(`${ROW}.origin`, '<>', 'explicit')
    .where(rowInScope(scope))
    .where(sql<SqlBool>`${col(`${ROW}.origin`)} <> ${origin}`);

  const attachmentProject = col('derive_attachment.project_id');
  const insert = db
    .insertInto(ROW)
    .orIgnore()
    .columns(['org_id', 'project_id', 'package_id', 'origin', 'ecosystem', 'name'])
    .expression(
      db
        .selectFrom('package as derive_package')
        .innerJoin(
          'project_source as derive_attachment',
          'derive_attachment.source_id',
          'derive_package.source_id',
        )
        .select([
          'derive_package.org_id',
          'derive_attachment.project_id',
          'derive_package.id',
          derivedOrigin(ctx, attachmentProject, col('derive_package.source_id')).as('origin'),
          'derive_package.ecosystem',
          'derive_package.name',
        ])
        .where('derive_attachment.org_id', '=', ctx.orgId)
        .where(candidateInScope(scope))
        .where(derivedFor(ctx, attachmentProject, 'derive_package')),
    );

  return [compile(remove), compile(retag), compile(insert)];
}
