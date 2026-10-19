import { sql, type RawBuilder } from 'kysely';
import {
  CATALOGUE_KEY_LIST_MAX,
  CATALOGUE_PAGE_MAX,
  CATALOGUE_WINNER_KEYS_MAX,
  validateLimit,
  type CatalogueReader,
  type CatalogueSourceType,
  type EdgePage,
  type EdgeRow,
  type KeyClass,
  type KeyClassification,
  type WinnerCandidate,
  type WinnerClassification,
} from '@package-broker/core/db/catalogue';
import type { NameEcosystem } from '@package-broker/core/catalogue/names';
import type { OrgContext, ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import { compile, db } from '../kysely.js';
import { admittedProxySources } from './proxy-admission.js';
import {
  admissionCondition,
  attachedSourceCondition,
  visibleRowsCondition,
  col,
  proxyEligibleCondition,
  readTimeCondition,
  winnerOrder,
} from './catalogue-predicates.js';

const NPM_DEPENDENCY_FIELDS = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
] as const;

function toStatement(raw: RawBuilder<unknown>): ScalarStatement {
  return compile({ compile: () => raw.compile(db) }) as ScalarStatement;
}

function orgScope(ctx: OrgContext): RawBuilder<unknown> {
  return sql`pp.org_id = ${ctx.orgId} and pkg.org_id = ${ctx.orgId}
    and src.org_id = ${ctx.orgId} and ps.org_id = ${ctx.orgId}
    and ${attachedSourceCondition(ctx, col('pp.project_id'), col('pkg.source_id'), col('pkg.ecosystem'))}`;
}

function visibleFrom(): RawBuilder<unknown> {
  return sql`from project_package as pp
    join package as pkg on pkg.id = pp.package_id
    join source as src on src.id = pkg.source_id
    join project_source as ps on ps.project_id = pp.project_id and ps.source_id = pkg.source_id`;
}

function rankedWinners(
  ctx: OrgContext,
  projectId: string,
  ecosystem: NameEcosystem,
  filter: RawBuilder<unknown>,
): RawBuilder<unknown> {
  return sql`select pkg.name as key, pkg.id as package_id, pkg.source_id, src.type as source_type,
    src.removal_policy,
    row_number() over (partition by pkg.name order by ${sql.join(winnerOrder({ source: 'src', attachment: 'ps' }))}) as rn
  ${visibleFrom()}
  where pp.project_id = ${projectId} and pkg.ecosystem = ${ecosystem} and ${filter}
    and ${visibleRowsCondition(ctx, { pp: 'pp', pkg: 'pkg', src: 'src', ps: 'ps' })}`;
}

function depsExpression(ecosystem: NameEcosystem): RawBuilder<unknown> {
  if (ecosystem === 'composer') {
    return sql`case when json_type(v.metadata_json, '$.require') in ('object', 'array')
      then json_extract(v.metadata_json, '$.require') else null end`;
  }
  const extract = (field: string) => sql`json_extract(v.metadata_json, ${`$.${field}`})`;
  const absent = sql.join(
    NPM_DEPENDENCY_FIELDS.map((field) => sql`${extract(field)} is null`),
    sql` and `,
  );
  const members = sql.join(NPM_DEPENDENCY_FIELDS.map((field) => sql`${field}, ${extract(field)}`));
  return sql`case when ${absent} then null else json_object(${members}) end`;
}

interface EdgeSqlRow {
  readonly requirer_key: string;
  readonly version_id: string;
  readonly version: string;
  readonly deps: string | null;
}

function keyList(keys: unknown, max: number): { readonly json: string; readonly count: number } {
  if (!Array.isArray(keys) || keys.length > max || keys.some((key) => typeof key !== 'string')) {
    throw new TypeError(`keys must be an array of at most ${max} strings`);
  }
  return { json: JSON.stringify(keys), count: keys.length };
}

function keyTable(
  ctx: OrgContext,
  ecosystem: NameEcosystem,
  list: { readonly json: string; readonly count: number },
): RawBuilder<unknown> {
  return sql`input as (select ${list.json} as keys), k as (
  select cast(j.key as integer) as idx, j.value as name,
    ${ctx.orgId} as org_id, ${ecosystem} as ecosystem
  from input, json_each(input.keys) as j
  where (select count(*) from input, json_each(input.keys)) = ${list.count}
)`;
}

function requireRows<T>(rows: readonly T[], count: number): void {
  if (rows.length !== count) {
    throw new Error('the key list was not read in full');
  }
}

const projectActiveCondition = (ctx: OrgContext) => sql`exists (
  select 1 from project as pj
  where pj.id = pp.project_id and pj.org_id = ${ctx.orgId} and pj.status = 'active'
)`;

export function createClosureEdges(
  executor: ScalarSqlExecutor,
): Pick<CatalogueReader, 'pageEdges' | 'classify' | 'classifyWinners' | 'previewWinners'> {
  return {
    async pageEdges(ctx, query): Promise<EdgePage> {
      const limit = validateLimit(query?.limit, CATALOGUE_PAGE_MAX);
      const { after } = query;
      if (
        after !== undefined &&
        (typeof after.requirerKey !== 'string' || typeof after.versionId !== 'string')
      ) {
        throw new TypeError('after must be an edge cursor');
      }
      const keyFrom = after === undefined ? sql`1 = 1` : sql`kp.name >= ${after.requirerKey}`;
      const versionFrom = (key: string, version: string) =>
        after === undefined
          ? sql`1 = 1`
          : sql`(${sql.ref(key)}, ${sql.ref(version)}) > (${after.requirerKey}, ${after.versionId})`;
      const raw = sql`with key_page as materialized (
  select kp.name
  from package as kp indexed by package_by_name
  where kp.org_id = ${ctx.orgId} and kp.ecosystem = ${query.ecosystem} and ${keyFrom}
    and exists (
      select 1
      from (${rankedWinners(ctx, query.projectId, query.ecosystem, sql`pkg.name = kp.name`)}) as w
      join version as ev on ev.package_id = w.package_id and ev.org_id = ${ctx.orgId}
        and (ev.status = 'active' or (ev.status = 'removed_upstream' and w.removal_policy = 'flag'))
      where w.rn = 1 and ${versionFrom('w.key', 'ev.id')}
    )
  group by kp.name
  order by kp.name
  limit ${limit + 1}
), c as materialized (
  ${rankedWinners(ctx, query.projectId, query.ecosystem, sql`pkg.name in (select name from key_page)`)}
), edge_page as materialized (
  select c.key as requirer_key, v.id as version_id
  from c
  join version as v on v.id in (
    select ev.id from version as ev
    where ev.package_id = c.package_id and ev.org_id = ${ctx.orgId}
      and (ev.status = 'active' or (ev.status = 'removed_upstream' and c.removal_policy = 'flag'))
      and ${versionFrom('c.key', 'ev.id')}
    order by ev.id
    limit ${limit + 1}
  )
  where c.rn = 1
  order by c.key, v.id
  limit ${limit + 1}
)
select edge_page.requirer_key, edge_page.version_id, v.version,
  ${depsExpression(query.ecosystem)} as deps
from edge_page
join version as v on v.id = edge_page.version_id and v.org_id = ${ctx.orgId}
order by edge_page.requirer_key, edge_page.version_id`;
      const rows = await executor.all<EdgeSqlRow>(toStatement(raw));
      const more = rows.length > limit;
      const page = (more ? rows.slice(0, limit) : rows).map((row): EdgeRow => ({
        requirerKey: row.requirer_key,
        versionId: row.version_id,
        version: row.version,
        deps: row.deps,
      }));
      const last = page.at(-1);
      return {
        rows: page,
        next: more && last ? { requirerKey: last.requirerKey, versionId: last.versionId } : null,
      };
    },

    async classify(ctx, query): Promise<readonly KeyClassification[]> {
      const list = keyList(query?.keys, CATALOGUE_KEY_LIST_MAX);
      const raw = sql`with ${keyTable(ctx, query.ecosystem, list)}
select k.idx,
  exists ${admittedProxySources(ctx, query.projectId, query.ecosystem, 'k')} as admissible,
  exists (
    select 1 from package as hp indexed by package_by_name
    join source as hs on hs.id = hp.source_id
    where hp.org_id = ${ctx.orgId} and hp.ecosystem = ${query.ecosystem} and hp.name = k.name
      and hs.org_id = ${ctx.orgId} and hs.ecosystem = ${query.ecosystem}
      and hs.project_id is null and hs.type not in ('packagist_proxy', 'npmjs_proxy')
      and ${admissionCondition(ctx, sql`${query.projectId}`, col('hp.source_id'), col('hp.name'), col('hp.visible_to_new_projects'))}
      and (hp.status = 'active' or (hp.status = 'removed_upstream' and hs.removal_policy = 'flag'))
      and exists (select 1 from project as pj
        where pj.id = ${query.projectId} and pj.org_id = ${ctx.orgId} and pj.status = 'active')
  ) as attachable
from k
order by k.idx`;
      const rows = await executor.all<{ idx: number; admissible: number; attachable: number }>(
        toStatement(raw),
      );
      requireRows(rows, list.count);
      return rows.map((row) => {
        const cls: KeyClass =
          row.admissible === 1
            ? 'proxy_admissible'
            : row.attachable === 1
              ? 'attachable'
              : 'not_available';
        return { key: query.keys[row.idx] as string, class: cls };
      });
    },

    async classifyWinners(ctx, query): Promise<readonly WinnerClassification[]> {
      const list = keyList(query?.keys, CATALOGUE_WINNER_KEYS_MAX);
      const raw = sql`with ${keyTable(ctx, query.ecosystem, list)},
c as (${rankedWinners(ctx, query.projectId, query.ecosystem, sql`pkg.name in (select name from k)`)})
select k.idx, c.source_id, c.source_type
from k
left join c on c.key = k.name and c.rn = 1
order by k.idx`;
      const rows = await executor.all<{
        idx: number;
        source_id: string | null;
        source_type: CatalogueSourceType | null;
      }>(toStatement(raw));
      requireRows(rows, list.count);
      return rows.map((row) => ({
        key: query.keys[row.idx] as string,
        winner:
          row.source_id === null || row.source_type === null
            ? null
            : { sourceId: row.source_id, sourceType: row.source_type },
      }));
    },

    async previewWinners(ctx, query): Promise<readonly WinnerCandidate[]> {
      if (typeof query?.key !== 'string') throw new TypeError('key must be a string');
      const raw = sql`select pkg.id as package_id, src.id as source_id, src.type as source_type,
  src.project_id is not null as project_level, ps.precedence,
  (${readTimeCondition(ctx, col('pp.project_id'), { package: 'pkg', source: 'src' })}
    and ${proxyEligibleCondition({ package: 'pkg', source: 'src' })}) as eligible
${visibleFrom()}
where pp.project_id = ${query.projectId} and pkg.ecosystem = ${query.ecosystem}
  and pkg.name = ${query.key} and ${orgScope(ctx)} and ${projectActiveCondition(ctx)}
order by ${sql.join(winnerOrder({ source: 'src', attachment: 'ps' }))}`;
      const rows = await executor.all<{
        package_id: string;
        source_id: string;
        source_type: CatalogueSourceType;
        project_level: number;
        precedence: number;
        eligible: number;
      }>(toStatement(raw));
      return rows.map((row) => ({
        sourceId: row.source_id,
        sourceType: row.source_type,
        projectLevel: row.project_level === 1,
        precedence: row.precedence,
        packageId: row.package_id,
        eligible: row.eligible === 1,
      }));
    },
  };
}
