import { sql, type SqlBool } from 'kysely';
import { MAX_VERIFIED_CLAIMS_BYTES } from '@package-broker/core/sources/proxy-claims';
import type { OrgContext } from '@package-broker/core/db/port';
import type { Guard } from '../kysely.js';

export function proxyClaimsVerified(ctx: OrgContext, verified: readonly string[] = []): Guard {
  const proof = JSON.stringify(verified);
  if (new TextEncoder().encode(proof).length > MAX_VERIFIED_CLAIMS_BYTES) return sql<SqlBool>`0`;
  return sql<SqlBool>`not exists (
    select 1 from registered_name as proxy_claim
    join source as claim_owner on claim_owner.id = proxy_claim.source_id
      and claim_owner.org_id = ${ctx.orgId}
    where proxy_claim.org_id = ${ctx.orgId}
      and claim_owner.type = 'hosted' and claim_owner.ecosystem = 'npm'
      and proxy_claim.ecosystem = 'npm' and instr(proxy_claim.pattern, '*') = 0
      and proxy_claim.pattern not in (select value from json_each(${proof})))`;
}
