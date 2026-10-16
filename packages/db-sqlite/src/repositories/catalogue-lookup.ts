import { sql, type RawBuilder } from 'kysely';
import type {
  CatalogueReader,
  CatalogueVersion,
  DistTagsLookup,
  DistType,
  PackageRef,
  ResolvedPackage,
  VersionLookup,
} from '@package-broker/core/db/catalogue';
import type { VersionStability } from '@package-broker/core/catalogue/versions';
import type { OrgContext, ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import { compile, db } from '../kysely.js';
import { visibleWinner } from './catalogue-read.js';

interface Header {
  readonly package_id: string;
  readonly source_id: string;
  readonly rev: number;
  readonly modified_at: string;
  readonly created_at: string;
  readonly last_synced_at: string | null;
  readonly cache_epoch: string | null;
}

interface VersionRow extends Header {
  readonly id: string;
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

interface TagRow extends Header {
  readonly tag: string | null;
  readonly version: string | null;
}

const HEADER_COLUMNS = sql.raw(
  'w.package_id, w.source_id, w.rev, w.modified_at, w.created_at, w.last_synced_at, e.version as cache_epoch',
);

const VERSION_COLUMNS = sql.raw(
  `v.id, v.revision, v.version, v.version_normalized, v.stability, v.status, v.published_at,
   v.upstream_released_at, v.license, v.dist_type, v.composer_shasum, v.npm_integrity,
   v.deprecated_message, v.metadata_json`,
);

function available(ctx: OrgContext): RawBuilder<unknown> {
  return sql`v.package_id = w.package_id and v.org_id = ${ctx.orgId}
    and (v.status = 'active' or (v.status = 'removed_upstream' and w.removal_policy = 'flag'))`;
}

function tagged(ctx: OrgContext, query: PackageRef): RawBuilder<unknown> {
  return sql`dt.package_id = w.package_id and dt.org_id = ${ctx.orgId} and ${sql.lit(query.ecosystem === 'npm' ? 1 : 0)} = 1`;
}

function winner(ctx: OrgContext, query: PackageRef): RawBuilder<unknown> {
  return sql`${visibleWinner(ctx, query.projectId, query.ecosystem, query.key)}`;
}

function toStatement(raw: RawBuilder<unknown>): ScalarStatement {
  return compile({ compile: () => raw.compile(db) }) as ScalarStatement;
}

function versionStatement(ctx: OrgContext, query: PackageRef, match: RawBuilder<unknown>) {
  return toStatement(sql`with w as ${winner(ctx, query)}
select ${HEADER_COLUMNS}, ${VERSION_COLUMNS}
from w
${match}
left join cache_epoch as e on e.org_id = ${ctx.orgId}
limit 1`);
}

function requireString(value: unknown, name: string): void {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
}

function toPackage(query: PackageRef, row: Header): ResolvedPackage {
  return {
    projectId: query.projectId,
    ecosystem: query.ecosystem,
    key: query.key,
    packageId: row.package_id,
    sourceId: row.source_id,
    rev: row.rev,
    modifiedAt: row.modified_at,
    createdAt: row.created_at,
    listingComplete: row.last_synced_at !== null,
    cacheEpoch: row.cache_epoch,
  };
}

function toLookup(query: PackageRef, row: VersionRow | undefined): VersionLookup | null {
  if (row === undefined) return null;
  const version: CatalogueVersion = {
    versionId: row.id,
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
  return { pkg: toPackage(query, row), version };
}

export function createCatalogueLookup(
  executor: ScalarSqlExecutor,
): Pick<CatalogueReader, 'lookupVersion' | 'lookupTag' | 'distTags'> {
  return {
    async lookupVersion(ctx, query): Promise<VersionLookup | null> {
      requireString(query.versionNormalized, 'versionNormalized');
      const match = sql`cross join version as v indexed by version_identity
  on v.version_normalized = ${query.versionNormalized} and ${available(ctx)}`;
      const rows = await executor.all<VersionRow>(versionStatement(ctx, query, match));
      return toLookup(query, rows[0]);
    },

    async lookupTag(ctx, query): Promise<VersionLookup | null> {
      requireString(query.tag, 'tag');
      const match = sql`cross join dist_tag as dt on dt.tag = ${query.tag} and ${tagged(ctx, query)}
join version as v on v.id = dt.version_id and ${available(ctx)}`;
      const rows = await executor.all<VersionRow>(versionStatement(ctx, query, match));
      return toLookup(query, rows[0]);
    },

    async distTags(ctx, query): Promise<DistTagsLookup | null> {
      const raw = sql`with w as ${winner(ctx, query)},
t as (
  select dt.tag, v.version
  from w
  cross join dist_tag as dt on ${tagged(ctx, query)}
  join version as v on v.id = dt.version_id and ${available(ctx)}
)
select ${HEADER_COLUMNS}, t.tag, t.version
from w
left join t on 1 = 1
left join cache_epoch as e on e.org_id = ${ctx.orgId}
order by t.tag`;
      const rows = await executor.all<TagRow>(toStatement(raw));
      const head = rows[0];
      if (head === undefined) return null;
      const tags = Object.create(null) as Record<string, string>;
      for (const row of rows) {
        if (row.tag !== null && row.version !== null) tags[row.tag] = row.version;
      }
      return { pkg: toPackage(query, head), tags };
    },
  };
}
