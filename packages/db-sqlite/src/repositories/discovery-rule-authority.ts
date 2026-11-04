import { sql, type SqlBool } from 'kysely';
import {
  fenceKind,
  type DiscoveryRuleFence,
  type SourceMutationFence,
} from '@package-broker/core/authz/fence';
import type { OrgContext } from '@package-broker/core/db/port';
import type { Guard } from '../kysely.js';
import { actorHolds, type ActorHoldsInput } from './actor-authority.js';

export function discoveryRuleAuthority(ctx: OrgContext, fence: DiscoveryRuleFence): Guard {
  return sql<SqlBool>`exists (
    select 1 from source_discovery_rule dr
    join credential dc on dc.org_id = dr.org_id and dc.id = dr.credential_id
    join job dj on dj.org_id = dr.org_id
    where dr.org_id = ${ctx.orgId} and dr.id = ${fence.ruleId}
      and dr.revision = ${fence.revision} and dr.enabled = 1
      and dr.credential_id = ${fence.credentialId} and dr.installation_id = ${fence.installationId}
      and dc.kind = 'github_app' and dc.project_id is null
      and dj.id = ${fence.job.id} and dj.lease_owner = ${fence.job.owner}
      and dj.fence = ${fence.job.fence} and dj.state = 'running'
      and dj.lease_until > strftime('%Y-%m-%dT%H:%M:%fZ','now')
      and dj.type = 'core:discovery-rule:v1'
      and dj.resource_key = ${`discovery-rule:${fence.ruleId}`}
      and json_extract(dj.payload_json, '$.ruleId') = dr.id
      and json_extract(dj.payload_json, '$.revision') = dr.revision)`;
}

export function sourceAuthority(
  ctx: OrgContext,
  fence: SourceMutationFence,
  input: ActorHoldsInput,
): Guard {
  if (fenceKind(fence) !== 'discovery')
    return actorHolds(ctx, fence as Exclude<SourceMutationFence, DiscoveryRuleFence>, input);
  return input.projectId === null && input.permission === 'org:sources:write'
    ? discoveryRuleAuthority(ctx, fence as DiscoveryRuleFence)
    : sql<SqlBool>`0`;
}

export function discoverySourceOwned(
  ctx: OrgContext,
  fence: DiscoveryRuleFence,
  sourceId: string,
): Guard {
  return sql<SqlBool>`exists(select 1 from source_discovery_admission da join source_discovery_rule dr
    on dr.org_id=da.org_id and dr.id=da.rule_id where da.org_id=${ctx.orgId} and da.source_id=${sourceId}
    and da.rule_id=${fence.ruleId})`;
}
