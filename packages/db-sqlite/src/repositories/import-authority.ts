import { sql, type Expression, type SqlBool } from 'kysely';
import {
  fenceKind,
  type MutationFence,
  type TokenMutationFence,
} from '@package-broker/core/authz/fence';
import type { OrgContext } from '@package-broker/core/db/port';
import {
  adminEligibility,
  guardAliases,
  usableLocalLogin,
  verifiedIdentity,
  EVIDENCE_MAX_AGE_MS,
  EVIDENCE_FUTURE_SKEW_MS,
  type Guard,
  type ProtectedHolderProvider,
} from '../kysely.js';
import { actorHolds } from './actor-authority.js';
import { permissionRows } from './access.js';

const CLOCK = sql`unixepoch('now', 'subsec')`;

export function importWriteAuthority(
  ctx: OrgContext,
  fence: MutationFence | TokenMutationFence,
  providerAnchors: readonly ProtectedHolderProvider[],
): Guard {
  const kind = fenceKind(fence);
  const permission = 'org:import:write';
  const anchors = providerAnchors;
  if (kind === 'session')
    return actorHolds(ctx, fence as MutationFence, {
      permission,
      projectId: null,
      providerAnchors: anchors,
    });
  if (kind !== 'token') throw new TypeError('invalid import fence');
  const token = fence as TokenMutationFence;
  if (token.permission !== permission) throw new TypeError('invalid import permission');
  const alias = {
    ...guardAliases(
      ['user', 'grant', 'role', 'member', 'identity', 'binding', 'login', 'credential'],
      ['irt', 'iru', 'irp'],
    ),
    user: 'iru',
  };
  const evidence = (column: string) =>
    sql<SqlBool>`unixepoch(${sql.ref(column)}, 'subsec') between ${CLOCK} - ${EVIDENCE_MAX_AGE_MS / 1000} and ${CLOCK} + ${EVIDENCE_FUTURE_SKEW_MS / 1000}`;
  const sso =
    anchors.length === 0
      ? sql<SqlBool>`0`
      : sql<SqlBool>`exists ${verifiedIdentity(ctx, alias, anchors, undefined)
          .whereRef(`${alias.identity}.id`, '=', 'irt.validation_identity_id')
          .where(evidence(`${alias.identity}.validated_at`))}`;
  const local = sql<SqlBool>`(exists ${usableLocalLogin(ctx, alias).where(evidence(`${alias.login}.last_login_at`))} and ${adminEligibility(ctx, sql.ref('iru.id') as Expression<string>)})`;
  const heldRows = permissionRows(ctx, token.principalId, null, anchors, {
    localAdmin: sql<SqlBool>`irt.validation_kind = 'local'`,
  }).as('ir_permissions');
  const held = sql<SqlBool>`exists (select 1 from ${heldRows} where ir_permissions.permission = ${permission})`;
  return sql<SqlBool>`exists (select 1 from token irt
      left join user_account iru on iru.id = irt.user_id and iru.org_id = irt.org_id
      left join service_principal irp on irp.id = irt.service_principal_id and irp.org_id = irt.org_id
      where irt.org_id = ${ctx.orgId} and irt.id = ${token.tokenId} and irt.kind = ${token.tokenKind}
      and irt.revoked_at is null and unixepoch(irt.expires_at, 'subsec') > ${CLOCK}
      and irt.read_only = 0 and json_type(irt.scopes_json) = 'array'
      and json_array_length(irt.scopes_json) = 1 and json_extract(irt.scopes_json, '$[0]') = 'full'
      and irt.project_id is null and irt.project_mode = 'all'
      and ((irt.kind = 'pat' and iru.id = ${token.principalId} and iru.status = 'active'
        and ${held} and ((irt.validation_kind = 'sso' and ${sso})
          or (irt.validation_kind = 'local' and irt.validation_identity_id is null and ${local})))
        or (irt.kind = 'svc' and irp.id = ${token.principalId} and irp.status = 'active'
          and irp.project_id is null and exists (select 1 from service_principal_permission irpp
            where irpp.org_id = irt.org_id and irpp.service_principal_id = irp.id and irpp.permission = ${permission}))))`;
}
