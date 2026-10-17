import type { OrgContext, ScalarSqlValue } from '@package-broker/core/db/port';

export interface LeaseGuardCondition {
  readonly sql: string;
  readonly params: readonly ScalarSqlValue[];
}

const ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = /^(bref_|bls_blob$)/i;

export function blobLeaseNotLive(ctx: OrgContext, versionAlias: string): LeaseGuardCondition {
  if (
    typeof versionAlias !== 'string' ||
    !ALIAS.test(versionAlias) ||
    RESERVED.test(versionAlias)
  ) {
    throw new TypeError('invalid blob lease guard alias');
  }
  return {
    sql: `(${versionAlias}.blob_id IS NULL OR NOT EXISTS (SELECT 1 FROM blob bls_blob WHERE bls_blob.id = ${versionAlias}.blob_id AND bls_blob.org_id = ? AND bls_blob.purge_lease_until > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))`,
    params: [ctx.orgId],
  };
}
