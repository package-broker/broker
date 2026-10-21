import { sql, type RawBuilder, type SqlBool } from 'kysely';
import {
  CATALOGUE_PAGE_MAX,
  validateLimit,
  type CatalogueReader,
  type CatalogueVersion,
  type DistType,
  type PackageResolution,
  type PageChanged,
  type ResolveVersionsQuery,
} from '@package-broker/core/db/catalogue';
import type { NameEcosystem } from '@package-broker/core/catalogue/names';
import type { VersionStability } from '@package-broker/core/catalogue/versions';
import type { OrgContext, ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import { compile, db } from '../kysely.js';
import {
  attachedSourceCondition,
  col,
  proxyEligibleCondition,
  readTimeCondition,
  winnerOrder,
} from './catalogue-predicates.js';

export const CATALOGUE_PAGE_BYTES = 4 * 1024 * 1024;

export function visibleWinner(
  ctx: OrgContext,
  projectId: string,
  ecosystem: NameEcosystem,
  key: string,
) {
  let query = db
    .selectFrom('project_package as pp')
    .innerJoin('package as pkg', 'pkg.id', 'pp.package_id')
    // Unary + keeps package_identity out of the plan, so pkg is reached through package_by_name.
    .innerJoin('source as src', (join) => join.on(sql<SqlBool>`src.id = +pkg.source_id`))
    .innerJoin('project_source as ps', (join) =>
      join.onRef('ps.project_id', '=', 'pp.project_id').onRef('ps.source_id', '=', 'pkg.source_id'),
    )
    .select([
      'pkg.id as package_id',
      'pkg.source_id as source_id',
      'pkg.rev as rev',
      'pkg.modified_at as modified_at',
      'pkg.created_at as created_at',
      'pkg.last_synced_at as last_synced_at',
      'src.removal_policy as removal_policy',
    ])
    .where('pp.project_id', '=', projectId)
    .where('pp.org_id', '=', ctx.orgId)
    .where('pkg.org_id', '=', ctx.orgId)
    .where('pkg.ecosystem', '=', ecosystem)
    .where('pkg.name', '=', key)
    .where('src.org_id', '=', ctx.orgId)
    .where('ps.org_id', '=', ctx.orgId)
    .where(
      attachedSourceCondition(
        ctx,
        col('pp.project_id'),
        col('pkg.source_id'),
        col('pkg.ecosystem'),
      ),
    )
    .where(readTimeCondition(ctx, col('pp.project_id'), { package: 'pkg', source: 'src' }))
    .where(proxyEligibleCondition({ package: 'pkg', source: 'src' }));
  for (const term of winnerOrder({ source: 'src', attachment: 'ps' })) query = query.orderBy(term);
  return query.limit(1);
}

interface Row {
  readonly package_id: string | null;
  readonly source_id: string | null;
  readonly rev: number | null;
  readonly modified_at: string | null;
  readonly created_at: string | null;
  readonly last_synced_at: string | null;
  readonly cache_epoch: string | null;
  readonly changed: number;
  readonly candidates: number | null;
  readonly id: string | null;
  readonly revision: number;
  readonly version: string;
  readonly version_normalized: string;
  readonly stability: VersionStability;
  readonly status: 'active' | 'removed_upstream';
  readonly published_at: string;
  readonly upstream_released_at: string | null;
  readonly license: string | null;
  readonly dist_type: DistType | null;
  readonly composer_shasum: string | null;
  readonly npm_integrity: string | null;
  readonly deprecated_message: string | null;
  readonly metadata_json: string;
}

const VERSION_COLUMNS = sql.raw(
  `v.id, v.revision, v.version, v.version_normalized, v.stability, v.status, v.published_at,
   v.upstream_released_at, v.license, v.dist_type, v.composer_shasum, v.npm_integrity,
   v.deprecated_message, v.metadata_json`,
);

function validate(query: ResolveVersionsQuery): number {
  const limit = validateLimit(query?.limit, CATALOGUE_PAGE_MAX);
  if (query.after !== undefined && query.binding === undefined) {
    throw new TypeError('a continuation needs the page binding of its first page');
  }
  if (query.publishedAtMost !== undefined && typeof query.publishedAtMost !== 'string') {
    throw new TypeError('publishedAtMost must be a timestamp string');
  }
  return limit;
}

function statement(ctx: OrgContext, query: ResolveVersionsQuery, limit: number): ScalarStatement {
  const { binding, after } = query;
  const bound = binding
    ? sql`(w.package_id = ${binding.packageId} and w.source_id = ${binding.sourceId} and w.rev = ${binding.rev})`
    : sql`1 = 1`;
  const filters: RawBuilder<unknown>[] = [];
  if (query.ecosystem === 'composer' && query.stability !== undefined) {
    filters.push(query.stability === 'dev' ? sql`v.stability = 'dev'` : sql`v.stability <> 'dev'`);
  }
  if (query.publishedAtMost !== undefined) {
    filters.push(sql`v.published_at <= ${query.publishedAtMost}`);
  }
  if (after !== undefined) {
    filters.push(
      sql`v.published_at >= ${after.publishedAt} and (v.published_at > ${after.publishedAt} or v.id > ${after.id})`,
    );
  }
  const extra = filters.length === 0 ? sql`` : sql` and ${sql.join(filters, sql` and `)}`;
  const raw = sql`with w as ${visibleWinner(ctx, query.projectId, query.ecosystem, query.key)},
cand as (
  select ${VERSION_COLUMNS}
  from w cross join version as v indexed by version_by_published on v.package_id = w.package_id
  where v.org_id = ${ctx.orgId} and ${bound}
    and (v.status = 'active' or (v.status = 'removed_upstream' and w.removal_policy = 'flag'))${extra}
  order by v.published_at, v.id
  limit ${limit + 1}
),
sized as (
  select cand.*,
    row_number() over page as rn,
    sum(length(cast(metadata_json as blob))) over (page rows between unbounded preceding and current row) as bytes,
    count(*) over () as candidates
  from cand
  window page as (order by published_at, id)
)
select w.package_id, w.source_id, w.rev, w.modified_at, w.created_at, w.last_synced_at,
  e.version as cache_epoch,
  case when ${bound} then 0 else 1 end as changed,
  s.candidates, s.id, s.revision, s.version, s.version_normalized, s.stability, s.status,
  s.published_at, s.upstream_released_at, s.license, s.dist_type, s.composer_shasum,
  s.npm_integrity, s.deprecated_message, s.metadata_json
from (select 1) as one
left join w on 1 = 1
left join cache_epoch as e on e.org_id = ${ctx.orgId} and w.package_id is not null
left join sized as s on s.rn <= ${limit} and (s.rn = 1 or s.bytes <= ${CATALOGUE_PAGE_BYTES})
where w.package_id is not null or ${sql.lit(binding ? 1 : 0)} = 1
order by s.rn`;
  return compile({ compile: () => raw.compile(db) }) as ScalarStatement;
}

function toVersion(row: Row): CatalogueVersion {
  return {
    versionId: row.id as string,
    revision: row.revision,
    version: row.version,
    versionNormalized: row.version_normalized,
    stability: row.stability,
    status: row.status,
    publishedAt: row.published_at,
    upstreamReleasedAt: row.upstream_released_at,
    license: row.license,
    distType: row.dist_type,
    composerShasum: row.composer_shasum,
    npmIntegrity: row.npm_integrity,
    deprecatedMessage: row.deprecated_message,
    metadataJson: row.metadata_json,
  };
}

export function createVersionReader(
  executor: ScalarSqlExecutor,
): Pick<CatalogueReader, 'resolveVersions'> {
  return {
    async resolveVersions(ctx, query): Promise<PackageResolution | PageChanged | null> {
      const limit = validate(query);
      const rows = await executor.all<Row>(statement(ctx, query, limit));
      const head = rows[0];
      if (head === undefined) return null;
      if (head.changed === 1 || head.package_id === null) return { changed: true };
      const binding = {
        packageId: head.package_id,
        sourceId: head.source_id as string,
        rev: head.rev as number,
      };
      const versions = rows.filter((row) => row.id !== null).map(toVersion);
      const last = versions.at(-1);
      const more = last !== undefined && (head.candidates ?? 0) > versions.length;
      return {
        pkg: {
          projectId: query.projectId,
          ecosystem: query.ecosystem,
          key: query.key,
          packageId: binding.packageId,
          sourceId: binding.sourceId,
          rev: binding.rev,
          modifiedAt: head.modified_at as string,
          createdAt: head.created_at as string,
          listingComplete: head.last_synced_at !== null,
          cacheEpoch: head.cache_epoch,
        },
        versions,
        next: more ? { publishedAt: last.publishedAt, id: last.versionId } : null,
        binding,
      };
    },
  };
}
