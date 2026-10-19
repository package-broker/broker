import { sql, type Expression, type SqlBool } from 'kysely';
import { MAX_PATTERN_BYTES } from '@package-broker/core/catalogue/patterns';
import type { OrgContext } from '@package-broker/core/db/port';
import { guardAliases } from '../kysely.js';

export type Ref = Expression<unknown>;

export function col(reference: string): Ref {
  return sql.ref(reference);
}

export interface PackageRefs {
  readonly package: string;
  readonly source: string;
}

export interface WinnerRefs {
  readonly source: string;
  readonly attachment: string;
}

const PROXY_TYPES = sql`('packagist_proxy', 'npmjs_proxy')`;

const MAX_PATTERN_WILDCARDS = 4;
const MAX_PATTERNS_PER_RULE = 64;

// Mirrors isValidPattern in core/catalogue/patterns.ts; length() and glob stop at NUL, so a byte-length mismatch (NUL, non-ASCII) is invalid.
function invalidPattern(pattern: Expression<unknown>): Expression<SqlBool> {
  return sql<SqlBool>`(
    length(cast(${pattern} as blob)) <> length(${pattern})
    or length(${pattern}) not between 1 and ${sql.lit(MAX_PATTERN_BYTES)}
    or ${pattern} glob '*[^a-z0-9._~@!/*-]*'
    or length(${pattern}) - length(replace(${pattern}, '*', '')) > ${sql.lit(MAX_PATTERN_WILDCARDS)}
  )`;
}

function referencedTables(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) referencedTables(item, found);
  } else if (typeof node === 'object' && node !== null) {
    const record = node as {
      kind?: unknown;
      table?: { table?: { identifier?: { name?: unknown } } };
    };
    const name = record.table?.table?.identifier?.name;
    if (record.kind === 'ReferenceNode' && typeof name === 'string') found.push(name);
    for (const value of Object.values(node)) referencedTables(value, found);
  }
  return found;
}

function assertRef(node: unknown): void {
  const n = node as {
    kind?: string;
    table?: unknown;
    sqlFragments?: unknown;
    parameters?: unknown;
  };
  if (
    n.kind === 'RawNode' &&
    Array.isArray(n.sqlFragments) &&
    Array.isArray(n.parameters) &&
    n.parameters.length === 1 &&
    n.sqlFragments.every((fragment) => fragment === '')
  ) {
    assertRef(n.parameters[0]);
    return;
  }
  if (n.kind === 'ValueNode' || (n.kind === 'ReferenceNode' && n.table !== undefined)) return;
  throw new TypeError('ref must be a table-qualified column reference or a literal value');
}

function aliasesFor<K extends string>(
  names: readonly K[],
  refs: readonly Ref[],
  tables: readonly string[],
): Record<K, string> {
  for (const r of refs) assertRef(r.toOperationNode());
  return guardAliases(names, [
    ...tables,
    ...refs.flatMap((r) => referencedTables(r.toOperationNode())),
  ]);
}

const at = (alias: string, column: string) => sql.ref(`${alias}.${column}`);

export function attachedSourceCondition(
  ctx: OrgContext,
  projectRef: Ref,
  sourceRef: Ref,
  ecosystemRef: Ref,
): Expression<SqlBool> {
  const a = aliasesFor(['ps', 's', 'p'], [projectRef, sourceRef, ecosystemRef], []);
  return sql<SqlBool>`exists (
    select 1 from project_source as ${sql.id(a.ps)}
    join source as ${sql.id(a.s)} on ${at(a.s, 'id')} = ${at(a.ps, 'source_id')}
    join project as ${sql.id(a.p)} on ${at(a.p, 'id')} = ${at(a.ps, 'project_id')}
    where ${at(a.ps, 'project_id')} = ${projectRef}
      and ${at(a.ps, 'source_id')} = ${sourceRef}
      and ${at(a.ps, 'org_id')} = ${ctx.orgId}
      and ${at(a.s, 'org_id')} = ${ctx.orgId}
      and ${at(a.p, 'org_id')} = ${ctx.orgId}
      and ${at(a.s, 'ecosystem')} = ${ecosystemRef}
      and (${at(a.s, 'project_id')} is null or ${at(a.s, 'project_id')} = ${at(a.ps, 'project_id')})
  )`;
}

// INDEXED BY: package_identity covers source_id and wins the planner, which leaves name unused.
export function proxyEligibleCondition(pkg: PackageRefs): Expression<SqlBool> {
  const p = (column: string) => at(pkg.package, column);
  const a = aliasesFor(['q', 'qs', 'r'], [], [pkg.package, pkg.source]);
  return sql<SqlBool>`(
    ${at(pkg.source, 'type')} not in ${PROXY_TYPES}
    or (
      not exists (
        select 1 from package as ${sql.id(a.q)} indexed by package_by_name
        join source as ${sql.id(a.qs)} on ${at(a.qs, 'id')} = ${at(a.q, 'source_id')}
          and ${at(a.qs, 'org_id')} = ${p('org_id')}
        where ${at(a.q, 'org_id')} = ${p('org_id')}
          and ${at(a.q, 'ecosystem')} = ${p('ecosystem')}
          and ${at(a.q, 'name')} = ${p('name')}
          and ${at(a.qs, 'type')} not in ${PROXY_TYPES}
      )
      and not exists (
        select 1 from registered_name as ${sql.id(a.r)}
        where ${at(a.r, 'org_id')} = ${p('org_id')}
          and ${at(a.r, 'ecosystem')} = ${p('ecosystem')}
          and (case when ${invalidPattern(at(a.r, 'pattern'))} then 1 else ${p('name')} glob ${at(a.r, 'pattern')} end)
      )
    )
  )`;
}

export function readTimeCondition(
  ctx: OrgContext,
  projectRef: Ref,
  pkg: PackageRefs,
): Expression<SqlBool> {
  const a = aliasesFor(['p'], [projectRef], [pkg.package, pkg.source]);
  const status = at(pkg.package, 'status');
  return sql<SqlBool>`(
    exists (
      select 1 from project as ${sql.id(a.p)}
      where ${at(a.p, 'id')} = ${projectRef} and ${at(a.p, 'org_id')} = ${ctx.orgId} and ${at(a.p, 'status')} = 'active'
    )
    and (
      ${status} = 'active'
      or (${status} = 'removed_upstream' and ${at(pkg.source, 'removal_policy')} = 'flag')
    )
  )`;
}

export function admissionCondition(
  ctx: OrgContext,
  projectRef: Ref,
  sourceRef: Ref,
  keyRef: Ref,
  flagRef: Ref,
): Expression<SqlBool> {
  const a = aliasesFor(
    ['bad', 'ci', 'cx', 'i', 'im', 'x'],
    [projectRef, sourceRef, keyRef, flagRef],
    [],
  );
  const scoped = (alias: string) =>
    sql`${at(alias, 'org_id')} = ${ctx.orgId} and ${at(alias, 'project_id')} = ${projectRef} and ${at(alias, 'source_id')} = ${sourceRef}`;
  const effect = (alias: string, value: 'include' | 'exclude') =>
    sql`${at(alias, 'effect')} = ${sql.lit(value)}`;
  const table = (alias: string) => sql`project_package_pattern as ${sql.id(alias)}`;
  return sql<SqlBool>`(
    ${flagRef} = 1
    and not exists (
      select 1 from ${table(a.bad)}
      where ${scoped(a.bad)} and ${invalidPattern(at(a.bad, 'pattern'))}
    )
    and (
      select count(*) from ${table(a.ci)}
      where ${scoped(a.ci)} and ${effect(a.ci, 'include')}
    ) <= ${sql.lit(MAX_PATTERNS_PER_RULE)}
    and (
      select count(*) from ${table(a.cx)}
      where ${scoped(a.cx)} and ${effect(a.cx, 'exclude')}
    ) <= ${sql.lit(MAX_PATTERNS_PER_RULE)}
    and (
      not exists (
        select 1 from ${table(a.i)}
        where ${scoped(a.i)} and ${effect(a.i, 'include')}
      )
      or exists (
        select 1 from ${table(a.im)}
        where ${scoped(a.im)} and ${effect(a.im, 'include')}
          and ${keyRef} glob ${at(a.im, 'pattern')}
      )
    )
    and not exists (
      select 1 from ${table(a.x)}
      where ${scoped(a.x)} and ${effect(a.x, 'exclude')}
        and ${keyRef} glob ${at(a.x, 'pattern')}
    )
  )`;
}

export function winnerOrder(refs: WinnerRefs): readonly Expression<unknown>[] {
  const source = (column: string) => sql.ref(`${refs.source}.${column}`);
  return [
    sql`case when ${source('type')} in ${PROXY_TYPES} then 1 else 0 end`,
    sql`case when ${source('project_id')} is null then 1 else 0 end`,
    sql.ref(`${refs.attachment}.precedence`),
    source('id'),
  ];
}

export function visibleRowsCondition(
  ctx: OrgContext,
  alias: { pp: string; pkg: string; src: string; ps: string },
) {
  const { pp, pkg, src, ps } = alias;
  return sql`${sql.ref(`${pp}.org_id`)} = ${ctx.orgId}
    and ${sql.ref(`${pkg}.org_id`)} = ${ctx.orgId}
    and ${sql.ref(`${src}.org_id`)} = ${ctx.orgId}
    and ${sql.ref(`${ps}.org_id`)} = ${ctx.orgId}
    and ${attachedSourceCondition(ctx, col(`${pp}.project_id`), col(`${pkg}.source_id`), col(`${pkg}.ecosystem`))}
    and ${readTimeCondition(ctx, col(`${pp}.project_id`), { package: pkg, source: src })}
    and ${proxyEligibleCondition({ package: pkg, source: src })}`;
}
