import { sql } from 'kysely';
import type { CatalogueWriteGuard, PublishVersionInput } from '@package-broker/core/db/catalogue';
import type { SqlExecutor, OrgContext } from '@package-broker/core/db/port';
import { db, compile, assertCheck, type ProtectedHolderProvider } from '../kysely.js';
import { registerCatalogueWriteGuard } from '../internal/catalogue-write-guard.js';
import { tokenAccessCondition } from './access.js';
import { admissionCondition, attachedSourceCondition } from './catalogue-predicates.js';

interface PublishGuardInput {
  readonly tokenId: string;
  readonly selector: string;
  readonly projectSlug: string;
  readonly routeProjectId: string;
  readonly sourceId: string;
  readonly key: string;
  readonly permission?: 'project:packages:manage';
}
const issued = new WeakMap<CatalogueWriteGuard, { orgId: string; input: PublishGuardInput }>();

function publishAdmission(ctx: OrgContext, input: PublishGuardInput) {
  return sql<boolean>`(${attachedSourceCondition(ctx, sql`${input.routeProjectId}`, sql`${input.sourceId}`, sql.lit('npm'))} and exists (select 1 from source as pub_source
    where pub_source.org_id = ${ctx.orgId} and pub_source.id = ${input.sourceId}
    and (exists (select 1 from project_package pp join package pkg on pkg.id = pp.package_id
      where pp.org_id = ${ctx.orgId} and pkg.org_id = ${ctx.orgId}
      and pp.project_id = ${input.routeProjectId} and pkg.source_id = pub_source.id and pkg.name = ${input.key})
      or (coalesce((select visible_to_new_projects from package where org_id = ${ctx.orgId}
          and source_id = ${input.sourceId} and ecosystem = 'npm' and name = ${input.key}), pub_source.default_visible_to_new_projects) = 1
          and ${admissionCondition(ctx, sql`${input.routeProjectId}`, sql`${input.sourceId}`, sql`${input.key}`, sql.lit(1))}))))`;
}

export async function checkPublishAdmission(
  executor: SqlExecutor,
  ctx: OrgContext,
  input: PublishGuardInput,
): Promise<boolean> {
  const rows = await executor.all<{ admitted: number }>(
    compile(db.selectNoFrom(publishAdmission(ctx, input).as('admitted'))),
  );
  return rows[0]?.admitted === 1;
}

export function createPublishWriteGuard(
  ctx: OrgContext,
  input: PublishGuardInput,
  providerAnchors: readonly ProtectedHolderProvider[],
): CatalogueWriteGuard {
  const permission = (name: string, scope: 'organization' | 'project') => sql<boolean>`(
    exists (select 1 from json_each(json_extract(pa.access, ${`$.${scope}`})) where value = ${name})
    or (${scope} = 'project' and exists (select 1 from json_each(json_extract(pa.access, '$.organization')) where value = ${name}))
    or (pa.kind = 'svc' and exists (select 1 from json_each(pa.service_permissions) where value = ${name})))`;
  const admitted = publishAdmission(ctx, input);
  const condition = tokenAccessCondition(
    ctx,
    {
      selector: input.selector,
      boundary: 'project',
      projectSlug: input.projectSlug,
      providerAnchors,
    },
    sql<boolean>` pa.token_id = ${input.tokenId} and pa.revoked_at is null and pa.expired = 0
    and (pa.token_package_name is null or pa.token_package_name = ${input.key})
    and pa.principal_status = 'active' and pa.binding_ok = 1 and pa.stamp_invalid = 0
    and (pa.kind = 'svc' or pa.validation_fresh = 1)
    and pa.read_only = 0 and json_array_length(pa.scopes_json) = 1
    and json_extract(pa.scopes_json,'$[0]') in ('write','full')
    and ${admitted}
    and ${input.permission === undefined ? sql.lit(true) : sql<boolean>`json_extract(pa.scopes_json,'$[0]') = 'full' and pa.project_token_max_scope = 'full'`}
    and ((${input.permission === undefined ? sql.lit(true) : sql.lit(false)} and pa.project_mode = 'all' and pa.token_project_id is null and pa.principal_project_id is null
      and ${permission('org:packages:publish', 'organization')})
      or (pa.project_id = ${input.routeProjectId} and pa.project_token_max_scope in ('write','full')
        and (${permission(input.permission ?? 'project:packages:write', 'project')} or (${input.permission === undefined ? sql.lit(true) : sql.lit(false)} and ${permission('org:packages:publish', 'organization')}))))`,
  );
  const guard = registerCatalogueWriteGuard(ctx, assertCheck(condition));
  issued.set(guard, {
    orgId: ctx.orgId,
    input: {
      tokenId: input.tokenId,
      selector: input.selector,
      projectSlug: input.projectSlug,
      routeProjectId: input.routeProjectId,
      sourceId: input.sourceId,
      key: input.key,
      ...(input.permission === undefined ? {} : { permission: input.permission }),
    },
  });
  return guard;
}

export function assertPublishBinding(
  ctx: OrgContext,
  guard: CatalogueWriteGuard,
  input: Pick<PublishVersionInput, 'tokenId' | 'routeProjectId' | 'sourceId' | 'key'>,
  manage = false,
): void {
  const bound = issued.get(guard);
  if (
    bound?.orgId !== ctx.orgId ||
    (manage
      ? bound.input.permission !== 'project:packages:manage'
      : bound.input.permission !== undefined) ||
    bound.input.tokenId !== input.tokenId ||
    bound.input.routeProjectId !== input.routeProjectId ||
    bound.input.sourceId !== input.sourceId ||
    bound.input.key !== input.key
  ) {
    throw new TypeError('invalid publish write guard');
  }
}

export function createPublishReads(executor: SqlExecutor) {
  return {
    async source(ctx: OrgContext, key: string) {
      const rows = await executor.all<{
        id: string;
        status: string;
        requirePublishApproval: number;
      }>(
        compile(
          db
            .selectFrom('source as s')
            .select(['s.id', 's.status', 's.require_publish_approval as requirePublishApproval'])
            .where('s.org_id', '=', ctx.orgId)
            .where('s.ecosystem', '=', 'npm')
            .where('s.type', '=', 'hosted')
            .where('s.project_id', 'is', null)
            .where(
              sql<boolean>`exists (select 1 from registered_name r where r.org_id = ${ctx.orgId} and r.source_id = s.id and r.ecosystem = 'npm' and r.pattern in (${key}, ${key.startsWith('@') ? key.slice(0, key.indexOf('/')) + '/*' : key}))`,
            )
            .limit(2),
        ),
      );
      return rows.map((row) => ({
        ...row,
        requirePublishApproval: row.requirePublishApproval === 1,
      }));
    },
    async packageBinding(ctx: OrgContext, tokenId: string) {
      const rows = await executor.all<{ packageName: string | null }>(
        compile(
          db
            .selectFrom('token as pub_token')
            .select('pub_token.package_name as packageName')
            .where('pub_token.org_id', '=', ctx.orgId)
            .where('pub_token.id', '=', tokenId),
        ),
      );
      return rows[0] ?? null;
    },
    async blobId(ctx: OrgContext, sha256: string) {
      const rows = await executor.all<{ id: string }>(
        compile(
          db
            .selectFrom('blob as pub_blob')
            .select('pub_blob.id')
            .where('pub_blob.org_id', '=', ctx.orgId)
            .where('pub_blob.sha256', '=', sha256)
            .where('pub_blob.deleted_at', 'is', null),
        ),
      );
      return rows[0]?.id ?? null;
    },
  };
}
