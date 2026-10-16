import { sql, type RawBuilder } from 'kysely';
import {
  CATALOGUE_PAGE_MAX,
  CATALOGUE_SEARCH_MAX,
  validateLimit,
  type CatalogueReader,
  type ListedPackage,
  type VisibleListing,
} from '@package-broker/core/db/catalogue';
import type { NameEcosystem } from '@package-broker/core/catalogue/names';
import type { OrgContext, ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import { compile, db } from '../kysely.js';
import {
  attachedSourceCondition,
  col,
  proxyEligibleCondition,
  readTimeCondition,
  winnerOrder,
} from './catalogue-predicates.js';

const SEARCH_TEXT_MAX = 100;
/** D1 refuses LIKE patterns longer than 50 bytes. */
const LIKE_PATTERN_BYTES_MAX = 50;

interface Row {
  readonly open_namespace: number;
  readonly key: string | null;
  readonly package_id: string | null;
  readonly source_id: string | null;
  readonly description: string | null;
}

function rowsFilter(ctx: OrgContext, alias: { pp: string; pkg: string; src: string; ps: string }) {
  const { pp, pkg, src, ps } = alias;
  return sql`${sql.ref(`${pp}.org_id`)} = ${ctx.orgId}
    and ${sql.ref(`${pkg}.org_id`)} = ${ctx.orgId}
    and ${sql.ref(`${src}.org_id`)} = ${ctx.orgId}
    and ${sql.ref(`${ps}.org_id`)} = ${ctx.orgId}
    and ${attachedSourceCondition(ctx, col(`${pp}.project_id`), col(`${pkg}.source_id`), col(`${pkg}.ecosystem`))}
    and ${readTimeCondition(ctx, col(`${pp}.project_id`), { package: pkg, source: src })}
    and ${proxyEligibleCondition({ package: pkg, source: src })}`;
}

function winners(
  ctx: OrgContext,
  projectId: string,
  ecosystem: NameEcosystem,
  filter: RawBuilder<unknown>,
  limit: number,
): RawBuilder<unknown> {
  const better = sql.join(winnerOrder({ source: 'bs', attachment: 'bps' }));
  const current = sql.join(winnerOrder({ source: 'src', attachment: 'ps' }));
  return sql`select pkg.name as key, pkg.id as package_id, pkg.source_id, pkg.description
  from project_package as pp
  join package as pkg on pkg.id = pp.package_id
  join source as src on src.id = pkg.source_id
  join project_source as ps on ps.project_id = pp.project_id and ps.source_id = pkg.source_id
  where pp.project_id = ${projectId} and pkg.ecosystem = ${ecosystem} and ${filter}
    and ${rowsFilter(ctx, { pp: 'pp', pkg: 'pkg', src: 'src', ps: 'ps' })}
    and not exists (
      select 1 from package as bp indexed by package_by_name
      join project_package as bpp on bpp.project_id = pp.project_id and bpp.package_id = bp.id
      join source as bs on bs.id = bp.source_id
      join project_source as bps on bps.project_id = pp.project_id and bps.source_id = bp.source_id
      where bp.org_id = pkg.org_id and bp.ecosystem = pkg.ecosystem and bp.name = pkg.name
        and ${rowsFilter(ctx, { pp: 'bpp', pkg: 'bp', src: 'bs', ps: 'bps' })}
        and (${better}) < (${current})
    )
  order by pkg.name
  limit ${limit}`;
}

function openNamespace(
  ctx: OrgContext,
  projectId: string,
  ecosystem: NameEcosystem,
): RawBuilder<unknown> {
  return sql`exists (
    select 1 from project_source as ops
    join source as os on os.id = ops.source_id
    join project as op on op.id = ops.project_id
    where ops.project_id = ${projectId} and ops.org_id = ${ctx.orgId}
      and os.org_id = ${ctx.orgId} and op.org_id = ${ctx.orgId} and op.status = 'active'
      and os.ecosystem = ${ecosystem} and os.type in ('packagist_proxy', 'npmjs_proxy')
      and (os.project_id is null or os.project_id = ops.project_id)
  )`;
}

function statement(
  ctx: OrgContext,
  projectId: string,
  ecosystem: NameEcosystem,
  filter: RawBuilder<unknown>,
  limit: number,
): ScalarStatement {
  const raw = sql`with w as (${winners(ctx, projectId, ecosystem, filter, limit)})
select ${openNamespace(ctx, projectId, ecosystem)} as open_namespace,
  w.key, w.package_id, w.source_id, w.description
from (select 1) as one
left join w on 1 = 1
order by w.key`;
  return compile({ compile: () => raw.compile(db) }) as ScalarStatement;
}

function toItem(row: Row): ListedPackage {
  return {
    key: row.key as string,
    packageId: row.package_id as string,
    sourceId: row.source_id as string,
    description: row.description,
  };
}

function searchFilter(text: unknown): RawBuilder<unknown> {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  const needle = text.trim().toLowerCase();
  const length = Array.from(needle).length;
  if (length < 1 || length > SEARCH_TEXT_MAX) {
    throw new TypeError(`text must be 1 to ${SEARCH_TEXT_MAX} characters`);
  }
  if (needle.includes('!')) throw new TypeError('text must not contain !');
  // SQLite cuts LIKE patterns and instr needles at NUL, which would widen the match.
  if (needle.includes('\0')) throw new TypeError('text must not contain NUL');
  const searchable = sql`replace(pkg.name, '!', '')`;
  const pattern = `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  if (new TextEncoder().encode(pattern).length <= LIKE_PATTERN_BYTES_MAX) {
    return sql`${searchable} like ${pattern} escape '\\'`;
  }
  // Names and the needle are lowercase, so instr matches what LIKE would for a pattern over D1's limit.
  return sql`instr(${searchable}, ${needle}) > 0`;
}

export function createCatalogueList(
  executor: ScalarSqlExecutor,
): Pick<CatalogueReader, 'listVisible' | 'search'> {
  return {
    async listVisible(ctx, query): Promise<VisibleListing> {
      const limit = validateLimit(query?.limit, CATALOGUE_PAGE_MAX);
      if (query.after !== undefined && typeof query.after !== 'string') {
        throw new TypeError('after must be a package key');
      }
      const filter = query.after === undefined ? sql`1 = 1` : sql`pkg.name > ${query.after}`;
      const rows = await executor.all<Row>(
        statement(ctx, query.projectId, query.ecosystem, filter, limit + 1),
      );
      const items = rows.filter((row) => row.key !== null).map(toItem);
      const more = items.length > limit;
      const page = more ? items.slice(0, limit) : items;
      return {
        items: page,
        next: more ? (page.at(-1)?.key ?? null) : null,
        openNamespace: rows[0]?.open_namespace === 1,
      };
    },
    async search(ctx, query): Promise<readonly ListedPackage[]> {
      const limit = validateLimit(query?.limit, CATALOGUE_SEARCH_MAX);
      const filter = searchFilter(query.text);
      const rows = await executor.all<Row>(
        statement(ctx, query.projectId, query.ecosystem, filter, limit),
      );
      return rows.filter((row) => row.key !== null).map(toItem);
    },
  };
}
