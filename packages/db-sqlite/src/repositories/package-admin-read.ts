import { redactValue } from '@package-broker/core/audit/redact';
import { sql, type RawBuilder } from 'kysely';
import type { NameEcosystem } from '@package-broker/core/catalogue/names';
import { validateLimit } from '@package-broker/core/db/catalogue';
import type {
  ManagedVersion,
  PackageAdminReader,
  PackageListItem,
  PackageListQuery,
  VersionListItem,
} from '@package-broker/core/db/package-admin';
import type { OrgContext, ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import { compile, db } from '../kysely.js';
import { visibleRowsCondition, winnerOrder } from './catalogue-predicates.js';

function safeName(value: string | null, fallback: string): string {
  if (!value || value.includes('@')) return fallback;
  const safe = redactValue(value, 200, 'name');
  return safe.ok && safe.value === value ? value : fallback;
}

const CANDIDATE_BUDGET = 500;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const STATUSES = new Set(['active', 'quarantined', 'tombstoned', 'removed_upstream']);

function statement(raw: RawBuilder<unknown>): ScalarStatement {
  return compile({ compile: () => raw.compile(db) }) as ScalarStatement;
}

function ecosystem(value: unknown): value is NameEcosystem {
  return value === 'composer' || value === 'npm';
}

function cursor(after: string | undefined, organization: boolean) {
  if (after === undefined) return undefined;
  if (typeof after !== 'string') throw new TypeError('invalid package cursor');
  const first = after.indexOf(':');
  const last = organization ? after.lastIndexOf(':') : after.length;
  const eco = after.slice(0, first);
  const name = after.slice(first + 1, last);
  const id = after.slice(last + 1);
  if (
    first < 0 ||
    !ecosystem(eco) ||
    name.length === 0 ||
    (organization && (last === first || !ULID.test(id)))
  ) {
    throw new TypeError('invalid package cursor');
  }
  return {
    ecosystem: eco,
    name,
    condition: organization
      ? sql`(pkg.ecosystem, pkg.name, pkg.id) > (${eco}, ${name}, ${id})`
      : sql`(pkg.ecosystem, pkg.name) > (${eco}, ${name})`,
  };
}

function validateQuery(query: PackageListQuery): void {
  validateLimit(query?.limit, 100);
  if (query.ecosystem !== undefined && !ecosystem(query.ecosystem)) {
    throw new TypeError('invalid ecosystem');
  }
  if (query.status !== undefined && !STATUSES.has(query.status)) {
    throw new TypeError('invalid package status');
  }
  if (
    query.q !== undefined &&
    (typeof query.q !== 'string' ||
      query.q !== query.q.toLowerCase() ||
      Array.from(query.q).length < 1 ||
      Array.from(query.q).length > 100 ||
      query.q.includes('\0'))
  )
    throw new TypeError('q must be 1 to 100 lowercase characters without NUL');
}

function winnerId(ctx: OrgContext, projectId: string, keyAlias: string): RawBuilder<unknown> {
  return sql`(
    select wpkg.id from project_package as wpp
    join package as wpkg on wpkg.id = wpp.package_id
    join source as wsrc on wsrc.id = wpkg.source_id
    join project_source as wps on wps.project_id = wpp.project_id and wps.source_id = wpkg.source_id
    where wpp.project_id = ${projectId}
      and wpkg.ecosystem = ${sql.ref(`${keyAlias}.ecosystem`)} and wpkg.name = ${sql.ref(`${keyAlias}.name`)}
      and ${visibleRowsCondition(ctx, { pp: 'wpp', pkg: 'wpkg', src: 'wsrc', ps: 'wps' })}
    order by ${sql.join(winnerOrder({ source: 'wsrc', attachment: 'wps' }))}
    limit 1
  )`;
}

function winner(ctx: OrgContext, projectId: string): RawBuilder<unknown> {
  return sql`pkg.id = ${winnerId(ctx, projectId, 'pkg')}`;
}

function activeProject(ctx: OrgContext, projectId: string): RawBuilder<unknown> {
  return sql`exists (select 1 from project as p
    where p.id = ${projectId} and p.org_id = ${ctx.orgId} and p.status = 'active')`;
}

function owner(ctx: OrgContext, projectId: string): RawBuilder<unknown> {
  return sql`src.project_id = ${projectId} and ${activeProject(ctx, projectId)}`;
}

function derivedStatus(ctx: OrgContext): RawBuilder<unknown> {
  return sql`case when c.status = 'removed_upstream' then 'removed_upstream'
    when exists (select 1 from version as vs where vs.org_id = ${ctx.orgId}
      and vs.package_id = c.id and vs.status = 'quarantined'
      and not exists (select 1 from publish_approval pa where pa.org_id = ${ctx.orgId} and pa.version_id = vs.id)) then 'quarantined'
    when exists (select 1 from version as vs where vs.org_id = ${ctx.orgId}
      and vs.package_id = c.id and vs.status = 'tombstoned')
      and not exists (select 1 from version as vs indexed by version_package_status where vs.org_id = ${ctx.orgId}
        and vs.package_id = c.id and vs.status <> 'tombstoned'
        and not (vs.status = 'quarantined' and exists (select 1 from publish_approval pa where pa.org_id = ${ctx.orgId} and pa.version_id = vs.id))) then 'tombstoned'
    else 'active' end`;
}

type PackageRow = Omit<
  PackageListItem,
  | 'id'
  | 'source'
  | 'latestVersion'
  | 'versionCount'
  | 'lastSyncedAt'
  | 'visibleToNewProjects'
  | 'newProjectAccessMode'
  | 'revision'
> & {
  readonly id: string | null;
  readonly visible_to_new_projects: number;
  readonly new_project_access_mode: 'none' | 'request';
  readonly settings_revision: number;
  readonly scanned: number;
  readonly source_id: string;
  readonly source_name: string;
  readonly source_type: PackageListItem['source']['type'];
  readonly source_project_id: string | null;
  readonly latest_version: string | null;
  readonly version_count: number;
  readonly last_synced_at: string | null;
  readonly qualifies: number;
};

async function list(
  executor: ScalarSqlExecutor,
  ctx: OrgContext,
  query: PackageListQuery,
  projectId?: string,
  attachedProjectId?: string,
  target?: { readonly packageId: string; readonly projectId: string | null },
) {
  validateQuery(query);
  const organization = projectId === undefined;
  const after = cursor(query.after, organization);
  const filters = [
    sql`pkg.org_id = ${ctx.orgId}`,
    sql`pkg.held_until_active = 0`,
    sql`src.org_id = ${ctx.orgId}`,
    after?.condition ?? sql`1 = 1`,
  ];
  if (target) {
    filters.push(sql`pkg.id = ${target.packageId}`);
    if (target.projectId !== null)
      filters.push(sql`((${owner(ctx, target.projectId)}) or (${winner(ctx, target.projectId)}))`);
  }
  const range = (eco: NameEcosystem | undefined, limit: RawBuilder<unknown>) => {
    const rangeFilters = [...filters];
    if (eco !== undefined) rangeFilters.push(sql`pkg.ecosystem = ${eco}`);
    if (after !== undefined && eco !== undefined && eco < after.ecosystem)
      rangeFilters.push(sql`0 = 1`);
    const cursorName = after !== undefined && eco === after.ecosystem ? after.name : undefined;
    const lower =
      query.q === undefined
        ? cursorName === undefined
          ? undefined
          : sql`${cursorName}`
        : cursorName === undefined
          ? sql`${query.q}`
          : sql`max(${query.q}, ${cursorName})`;
    if (lower !== undefined) rangeFilters.push(sql`pkg.name >= ${lower}`);
    if (query.q !== undefined) {
      rangeFilters.push(sql`pkg.name < ${query.q} || char(0x10FFFF)
        and substr(pkg.name, 1, length(${query.q})) = ${query.q}`);
    }
    return sql`
    select pkg.id, pkg.ecosystem, pkg.name, pkg.status, pkg.last_synced_at, pkg.visible_to_new_projects, pkg.new_project_access_mode, pkg.settings_revision,
      src.id as source_id, src.name as source_name, src.type as source_type, src.project_id as source_project_id
    from package as pkg join source as src on src.id = +pkg.source_id
    where ${sql.join(rangeFilters, sql` and `)}
    order by pkg.ecosystem, pkg.name, pkg.id limit ${limit}`;
  };
  const scan =
    query.ecosystem === undefined && (query.q !== undefined || after !== undefined)
      ? sql`composer_scan as materialized (${range('composer', sql`${CANDIDATE_BUDGET}`)}),
      npm_scan as materialized (${range('npm', sql`${CANDIDATE_BUDGET} - (select count(*) from composer_scan)`)}),
      scan as materialized (select * from composer_scan union all select * from npm_scan)`
      : sql`scan as materialized (${range(query.ecosystem, sql`${CANDIDATE_BUDGET}`)})`;
  const qualifies = [sql`d.id is not null`];
  if (attachedProjectId !== undefined)
    qualifies.push(sql`exists (
    select 1 from project_source as ps where ps.source_id = d.source_id
      and ps.org_id = ${ctx.orgId} and ps.project_id = ${attachedProjectId}
  ) and ${activeProject(ctx, attachedProjectId)}`);
  if (query.status !== undefined) qualifies.push(sql`d.list_status = ${query.status}`);
  if (query.sourceId !== undefined) qualifies.push(sql`d.source_id = ${query.sourceId}`);
  const candidates =
    projectId === undefined
      ? sql`select * from scan`
      : sql`select k.ecosystem, k.name, pkg.id, pkg.status, pkg.last_synced_at, pkg.visible_to_new_projects, pkg.new_project_access_mode, pkg.settings_revision,
        src.id as source_id, src.name as source_name, src.type as source_type, src.project_id as source_project_id
      from (
        select ecosystem, name from scan group by ecosystem, name
      ) as k
      left join package as pkg on pkg.id = ${winnerId(ctx, projectId, 'k')} and pkg.org_id = ${ctx.orgId}
      left join source as src on src.id = pkg.source_id and src.org_id = ${ctx.orgId}`;
  // Resolve every scanned name before advancing its cursor, including a winner outside the scan.
  const rows = await executor.all<PackageRow>(
    statement(sql`with ${scan}, c as materialized (${candidates}), d as materialized (
    select c.*, ${derivedStatus(ctx)} as list_status from c
  ) select d.id, d.ecosystem, d.name, d.list_status as status,
    d.visible_to_new_projects, d.new_project_access_mode, d.settings_revision,
    d.source_id, d.source_name, d.source_type, d.source_project_id, d.last_synced_at,
    (select count(*) from scan) as scanned,
    (select v.version from version as v where v.org_id = ${ctx.orgId} and v.package_id = d.id
      and v.status in ('active', 'removed_upstream') order by v.published_at desc, v.id desc limit 1) as latest_version,
    (select count(*) from version as v where v.org_id = ${ctx.orgId} and v.package_id = d.id
      and not (v.status = 'quarantined' and exists (select 1 from publish_approval pa where pa.org_id = ${ctx.orgId} and pa.version_id = v.id and (pa.approval_state = 'pending' or pa.scan_state in ('queued', 'running', 'failed'))))) as version_count,
    (${sql.join(qualifies, sql` and `)}) as qualifies
  from d order by d.ecosystem, d.name, d.id`),
  );
  const items: PackageListItem[] = [];
  let examined = 0;
  for (const row of rows) {
    examined++;
    if (row.qualifies === 1 && row.id !== null)
      items.push({
        id: row.id,
        ...(organization
          ? {
              visibleToNewProjects: row.visible_to_new_projects === 1,
              newProjectAccessMode: row.new_project_access_mode,
              revision: row.settings_revision,
            }
          : {}),
        ecosystem: row.ecosystem,
        name: row.name,
        latestVersion: row.latest_version,
        status: row.status,
        source: {
          id: row.source_id,
          name: row.source_name,
          type: row.source_type,
          projectId: row.source_project_id,
        },
        versionCount: row.version_count,
        lastSyncedAt: row.last_synced_at,
      });
    if (items.length === query.limit) break;
  }
  const last = rows[examined - 1];
  const next =
    last !== undefined && (examined < rows.length || last.scanned === CANDIDATE_BUDGET)
      ? `${last.ecosystem}:${last.name}${organization ? `:${last.id}` : ''}`
      : null;
  return { items, next };
}

type VersionRow = {
  readonly integrity: string | null;
  readonly dist_tags: string;
  readonly publisher_kind: 'user' | 'service' | 'system' | null;
  readonly publisher_name: string | null;
  readonly approver_name: string | null;
  readonly decided_at: string | null;
  readonly package_id: string;
  readonly id: string | null;
  readonly version: string;
  readonly stability: VersionListItem['stability'];
  readonly status: VersionListItem['status'];
  readonly published_at: string;
  readonly removed_upstream_at: string | null;
  readonly tombstoned_at: string | null;
  readonly revision: number;
};

export function createPackageAdminReader(executor: ScalarSqlExecutor): PackageAdminReader {
  return {
    listProject: (ctx, projectId, query) => list(executor, ctx, query, projectId),
    listOrganization: (ctx, query) => list(executor, ctx, query, undefined, query.projectId),
    async listVersions(ctx, query) {
      const limit = validateLimit(query?.limit, 100);
      if (
        query.after !== undefined &&
        (typeof query.after !== 'string' || !ULID.test(query.after))
      ) {
        throw new TypeError('after must be a version id');
      }
      const access =
        query.projectId === null
          ? sql`1 = 1`
          : sql`((${owner(ctx, query.projectId)}) or (${winner(ctx, query.projectId)}))`;
      const after = query.after === undefined ? sql`1 = 1` : sql`v.id > ${query.after}`;
      const rows = await executor.all<VersionRow>(
        statement(sql`with publication as not materialized (
        select id, target_id, actor_type, actor_id from audit_pending where org_id = ${ctx.orgId} and target_type = 'version' and action = 'package.publish'
        union all select id, target_id, actor_type, actor_id from audit_event where org_id = ${ctx.orgId} and target_type = 'version' and action = 'package.publish'
      ), target as (
        select pkg.id from package as pkg join source as src on src.id = pkg.source_id
        where pkg.org_id = ${ctx.orgId} and src.org_id = ${ctx.orgId}
          and pkg.held_until_active = 0 and pkg.id = ${query.packageId} and ${access}
      ), versions as (
        select v.id, v.version, v.stability, v.status, v.published_at,
          v.removed_upstream_at, v.tombstoned_at, v.revision, v.npm_integrity as integrity,
          (select json_group_array(tag) from (select dt.tag from dist_tag dt where dt.org_id = ${ctx.orgId} and dt.package_id = v.package_id and dt.version_id = v.id order by dt.tag)) as dist_tags,
          coalesce(pa.requested_by_type, case pub.actor_type when 'service_principal' then 'service' when 'user' then 'user' when 'system' then 'system' end) as publisher_kind,
          case when coalesce(pa.requested_by_type, pub.actor_type) = 'user' then pu.display_name else sp.name end as publisher_name,
          au.display_name as approver_name, case when pa.approval_state = 'approved' then pa.decided_at end as decided_at
        from version as v join target as t on t.id = v.package_id
        left join publish_approval pa on pa.version_id = v.id and pa.package_id = v.package_id and pa.org_id = ${ctx.orgId}
        left join publication pub on pub.target_id = v.id and pub.id = (select p.id from publication p where p.target_id = v.id order by p.id desc limit 1)
        left join user_account pu on pu.id = coalesce(pa.requested_by_id, pub.actor_id) and pu.org_id = ${ctx.orgId} and coalesce(pa.requested_by_type, pub.actor_type) = 'user'
        left join service_principal sp on sp.id = coalesce(pa.requested_by_id, pub.actor_id) and sp.org_id = ${ctx.orgId} and coalesce(pa.requested_by_type, pub.actor_type) in ('service', 'service_principal')
        left join user_account au on au.id = pa.decided_by_user_id and au.org_id = ${ctx.orgId}
        where v.org_id = ${ctx.orgId}
          and not (v.status = 'quarantined' and exists (select 1 from publish_approval pa where pa.org_id = ${ctx.orgId} and pa.version_id = v.id and (pa.approval_state = 'pending' or pa.scan_state in ('queued', 'running', 'failed')))) and ${after} order by v.id limit ${limit + 1}
      ) select t.id as package_id, versions.* from target as t left join versions on 1 = 1 order by versions.id`),
      );
      if (rows.length === 0) return null;
      const present = rows.filter((row) => row.id !== null);
      const items = present.slice(0, limit).map((row) => ({
        id: row.id!,
        integrity: row.integrity,
        distTags: JSON.parse(row.dist_tags) as string[],
        publishedBy:
          row.publisher_kind === null
            ? null
            : {
                kind: row.publisher_kind,
                displayName: safeName(
                  row.publisher_name,
                  row.publisher_kind === 'user'
                    ? 'User'
                    : row.publisher_kind === 'service'
                      ? 'Service principal'
                      : 'System',
                ),
              },
        approvedBy:
          row.decided_at === null
            ? null
            : { displayName: safeName(row.approver_name, 'User'), decidedAt: row.decided_at },
        version: row.version,
        stability: row.stability,
        status: row.status,
        publishedAt: row.published_at,
        removedUpstreamAt: row.removed_upstream_at,
        tombstonedAt: row.tombstoned_at,
        revision: row.revision,
      }));
      return { items, next: present.length > limit ? items.at(-1)!.id : null };
    },
    async findManagedVersion(ctx, query) {
      const access = query.projectId === null ? sql`1 = 1` : owner(ctx, query.projectId);
      const rows = await executor.all<
        Omit<ManagedVersion, 'publishGate' | 'hostedNpm'> & {
          publishGate: number;
          hostedNpm: number;
        }
      >(
        statement(sql`select pkg.id as "packageId", v.id as "versionId",
        pkg.ecosystem, pkg.name as "packageName", v.version, v.status, v.revision,
        (pkg.ecosystem='npm' and src.type='hosted') as "hostedNpm",
        src.id as "sourceId", src.project_id as "sourceProjectId",
        exists (select 1 from publish_approval pa where pa.org_id = ${ctx.orgId} and pa.version_id = v.id and (pa.approval_state = 'pending' or pa.scan_state in ('queued', 'running', 'failed'))) as "publishGate"
        from package as pkg join source as src on src.id = pkg.source_id
        join version as v on v.package_id = pkg.id
        where pkg.org_id = ${ctx.orgId} and src.org_id = ${ctx.orgId} and v.org_id = ${ctx.orgId}
          and pkg.held_until_active = 0 and pkg.id = ${query.packageId} and v.id = ${query.versionId} and ${access}`),
      );
      const row = rows[0];
      if (!row) return null;
      const { publishGate, hostedNpm, ...version } = row;
      return {
        ...version,
        ...(hostedNpm === 1 ? { hostedNpm: true as const } : {}),
        ...(publishGate === 1 ? { publishGate: true } : {}),
      };
    },
  };
}

export async function readPackageDetail(
  executor: ScalarSqlExecutor,
  ctx: OrgContext,
  query: { readonly packageId: string; readonly projectId: string | null },
): Promise<PackageListItem | null> {
  const page = await list(executor, ctx, { limit: 1 }, undefined, undefined, query);
  return page.items[0] ?? null;
}
