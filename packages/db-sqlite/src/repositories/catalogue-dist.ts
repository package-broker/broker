import { sql, type RawBuilder } from 'kysely';
import type {
  CatalogueReader,
  DistTarget,
  DistType,
  ResolveDistQuery,
} from '@package-broker/core/db/catalogue';
import type { Sha256 } from '@package-broker/core/platform/blob';
import type { OrgContext, ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import { compile, db } from '../kysely.js';
import { visibleWinner } from './catalogue-read.js';

interface Row {
  readonly version_id: string;
  readonly revision: number;
  readonly current: number;
  readonly package_id: string;
  readonly source_id: string;
  readonly status: 'active' | 'removed_upstream';
  readonly source_ref: string | null;
  readonly dist_type: DistType | null;
  readonly composer_shasum: string | null;
  readonly npm_integrity: string | null;
  readonly upstream_dist_url: string | null;
  readonly npm_shasum: string | null;
  readonly blob_id: string | null;
  readonly sha256: string | null;
  readonly size_bytes: number | null;
  readonly media_type: string | null;
  readonly refetchable: number | null;
}

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isRevision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

function validate(query: ResolveDistQuery): void {
  if (!isText(query?.projectId) || !isText(query.key)) throw new TypeError('invalid dist query');
  if (query.ecosystem !== 'composer' && query.ecosystem !== 'npm') {
    throw new TypeError('invalid dist query');
  }
  if (query.by === 'version') {
    if (!isText(query.versionNormalized)) throw new TypeError('invalid dist query');
    const { expect } = query;
    if (expect !== undefined && (!isText(expect?.versionId) || !isRevision(expect.revision))) {
      throw new TypeError('invalid dist query');
    }
    return;
  }
  if (query.by !== 'id' || !isText(query.versionId) || !isRevision(query.revision)) {
    throw new TypeError('invalid dist query');
  }
}

const jsonText = (column: RawBuilder<unknown>, path: string) =>
  sql`case when json_type(${column}, ${path}) = 'text' then json_extract(${column}, ${path}) end`;

function statement(ctx: OrgContext, query: ResolveDistQuery): ScalarStatement {
  const npm = query.ecosystem === 'npm';
  const meta = sql.ref('t.metadata_json') as RawBuilder<unknown>;
  const historyMeta = sql.ref('r.metadata_json') as RawBuilder<unknown>;
  const available = sql`v.org_id = ${ctx.orgId}
    and (v.status = 'active' or (v.status = 'removed_upstream' and w.removal_policy = 'flag'))`;
  let selector: RawBuilder<unknown>;
  let history = sql``;
  if (query.by === 'version') {
    selector = sql`v.version_normalized = ${query.versionNormalized}`;
    if (query.expect !== undefined) {
      selector = sql`${selector} and v.id = ${query.expect.versionId} and v.revision = ${query.expect.revision}`;
    }
  } else {
    selector = sql`v.id = ${query.versionId} and v.revision = ${query.revision}`;
    const historyShasum = npm
      ? sql`null`
      : sql`lower(nullif(${jsonText(historyMeta, '$.dist.shasum')}, ''))`;
    const historyIntegrity = npm ? jsonText(historyMeta, '$.dist.integrity') : sql`null`;
    history = sql`
  union all
  select v.id, r.revision, 0, w.package_id, w.source_id, v.status, r.source_ref, r.blob_id, r.metadata_json,
    case when json_extract(r.metadata_json, '$.dist.type') in ('zip', 'tar', 'tgz')
      then json_extract(r.metadata_json, '$.dist.type') else v.dist_type end,
    ${historyShasum}, ${historyIntegrity}
  from w
  join version as v on v.package_id = w.package_id
  join version_revision as r on r.version_id = v.id and r.revision = ${query.revision}
  where ${available} and r.org_id = ${ctx.orgId}
    and v.id = ${query.versionId} and v.revision > ${query.revision}`;
  }
  const raw = sql`with w as ${visibleWinner(ctx, query.projectId, query.ecosystem, query.key)},
t (version_id, revision, current, package_id, source_id, status, source_ref, blob_id, metadata_json,
   dist_type, composer_shasum, npm_integrity) as (
  select v.id, v.revision, 1, w.package_id, w.source_id, v.status, v.source_ref, v.blob_id, v.metadata_json,
    v.dist_type, v.composer_shasum, v.npm_integrity
  from w
  join version as v on v.package_id = w.package_id
  where ${available} and ${selector}${history}
)
select t.version_id, t.revision, t.current, t.package_id, t.source_id, t.status, t.source_ref,
  t.dist_type, t.composer_shasum, t.npm_integrity,
  ${jsonText(meta, npm ? '$.dist.tarball' : '$.dist.url')} as upstream_dist_url,
  ${npm ? jsonText(meta, '$.dist.shasum') : sql`null`} as npm_shasum,
  b.id as blob_id, b.sha256, b.size_bytes, b.media_type, b.refetchable
from t
left join blob as b on b.id = t.blob_id and b.org_id = ${ctx.orgId} and b.deleted_at is null
limit 1`;
  return compile({ compile: () => raw.compile(db) }) as ScalarStatement;
}

function toTarget(row: Row): DistTarget {
  return {
    versionId: row.version_id,
    revision: row.revision,
    current: row.current === 1,
    packageId: row.package_id,
    sourceId: row.source_id,
    status: row.status,
    blob:
      row.blob_id === null
        ? null
        : {
            id: row.blob_id,
            sha256: row.sha256 as Sha256,
            sizeBytes: row.size_bytes as number,
            mediaType: row.media_type as string,
            refetchable: row.refetchable === 1,
          },
    fetch: {
      sourceRef: row.source_ref,
      upstreamDistUrl: row.upstream_dist_url,
      distType: row.dist_type,
      composerShasum: row.composer_shasum,
      npmIntegrity: row.npm_integrity,
      npmShasum: row.npm_shasum,
    },
  };
}

export function createDistResolver(
  executor: ScalarSqlExecutor,
): Pick<CatalogueReader, 'resolveDist'> {
  return {
    async resolveDist(ctx, query): Promise<DistTarget | null> {
      validate(query);
      const [row] = await executor.all<Row>(statement(ctx, query));
      return row === undefined ? null : toTarget(row);
    },
  };
}
