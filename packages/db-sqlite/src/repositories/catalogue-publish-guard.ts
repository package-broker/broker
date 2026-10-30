import { sql } from 'kysely';
import type { CatalogueWriteGuard, PublishVersionInput } from '@package-broker/core/db/catalogue';
import type { OrgContext } from '@package-broker/core/db/port';
import { assertCheck, type ProtectedHolderProvider } from '../kysely.js';
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
}
const issued = new WeakMap<CatalogueWriteGuard, { orgId: string; input: PublishGuardInput }>();

export function createPublishWriteGuard(
  ctx: OrgContext,
  input: PublishGuardInput,
  providerAnchors: readonly ProtectedHolderProvider[],
): CatalogueWriteGuard {
  const permission = (name: string, scope: 'organization' | 'project') => sql<boolean>`(
    exists (select 1 from json_each(json_extract(pa.access, ${`$.${scope}`})) where value = ${name})
    or (${scope} = 'project' and exists (select 1 from json_each(json_extract(pa.access, '$.organization')) where value = ${name}))
    or (pa.kind = 'svc' and exists (select 1 from json_each(pa.service_permissions) where value = ${name})))`;
  const admitted = sql<boolean>`(${attachedSourceCondition(ctx, sql`${input.routeProjectId}`, sql`${input.sourceId}`, sql.lit('npm'))} and exists (select 1 from source as pub_source
    where pub_source.org_id = ${ctx.orgId} and pub_source.id = ${input.sourceId}
    and (exists (select 1 from project_package pp join package pkg on pkg.id = pp.package_id
      where pp.org_id = ${ctx.orgId} and pkg.org_id = ${ctx.orgId}
      and pp.project_id = ${input.routeProjectId} and pkg.source_id = pub_source.id and pkg.name = ${input.key})
      or (coalesce((select visible_to_new_projects from package where org_id = ${ctx.orgId}
          and source_id = ${input.sourceId} and ecosystem = 'npm' and name = ${input.key}), pub_source.default_visible_to_new_projects) = 1
          and ${admissionCondition(ctx, sql`${input.routeProjectId}`, sql`${input.sourceId}`, sql`${input.key}`, sql.lit(1))}))))`;
  const condition = tokenAccessCondition(
    ctx,
    {
      selector: input.selector,
      boundary: 'project',
      projectSlug: input.projectSlug,
      providerAnchors,
    },
    sql<boolean>` pa.token_id = ${input.tokenId} and pa.revoked_at is null and pa.expired = 0
    and pa.principal_status = 'active' and pa.binding_ok = 1 and pa.stamp_invalid = 0
    and (pa.kind = 'svc' or pa.validation_fresh = 1)
    and pa.read_only = 0 and json_array_length(pa.scopes_json) = 1
    and json_extract(pa.scopes_json,'$[0]') in ('write','full')
    and ((pa.project_mode = 'all' and pa.token_project_id is null and pa.principal_project_id is null
      and ${permission('org:packages:publish', 'organization')})
      or (pa.project_id = ${input.routeProjectId} and pa.project_token_max_scope in ('write','full')
        and ${permission('project:packages:write', 'project')} and ${admitted}))`,
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
    },
  });
  return guard;
}

export function assertPublishBinding(
  ctx: OrgContext,
  guard: CatalogueWriteGuard,
  input: PublishVersionInput,
): void {
  const bound = issued.get(guard);
  if (
    bound?.orgId !== ctx.orgId ||
    bound.input.tokenId !== input.tokenId ||
    bound.input.routeProjectId !== input.routeProjectId ||
    bound.input.sourceId !== input.sourceId ||
    bound.input.key !== input.key
  ) {
    throw new TypeError('invalid publish write guard');
  }
}
