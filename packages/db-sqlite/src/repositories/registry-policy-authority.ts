import { sql, type SqlBool } from 'kysely';
import { REAUTH_WINDOW_MS } from '@package-broker/core/auth/session';
import type { MutationFence } from '@package-broker/core/authz/fence';
import type { OrgContext } from '@package-broker/core/db/port';
import type { PolicyRuleKind, PolicyRuleScope } from '@package-broker/core/db/registry-policy';
import { existsGuard, type Guard, type ProtectedHolderProvider } from '../kysely.js';
import { holdsPermission } from './access.js';
import { actorAuthority, liveActorSession, type LiveActorOptions } from './actor-authority.js';

const DB_TIME = sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
const REAUTH_FLOOR = sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ${`-${REAUTH_WINDOW_MS / 1000} seconds`})`;

export interface PolicyAuthorityInput {
  readonly scope: PolicyRuleScope;
  readonly kind: PolicyRuleKind;
  /** A weakening write also needs a session reauthenticated within the window. */
  readonly fresh: boolean;
  readonly providerAnchors: readonly ProtectedHolderProvider[];
}

/** Settings authority governs age and client floors; package management governs the rest. */
export function policyPermission(kind: PolicyRuleKind, scope: PolicyRuleScope['kind']): string {
  const settings = kind === 'min_age' || kind === 'client_floor';
  if (scope === 'organization') return settings ? 'org:settings:write' : 'org:packages:manage';
  return settings ? 'project:settings:write' : 'project:packages:manage';
}

/**
 * Live human authority over the rule's scope, evaluated on database time inside the batch. A
 * project rule is also governed by the organization-scope permission of the same kind, for an
 * active project of the organization.
 */
export function policyAuthorityGuard(
  ctx: OrgContext,
  fence: MutationFence,
  input: PolicyAuthorityInput,
): Guard {
  const options: LiveActorOptions = input.fresh
    ? {
        sessionCondition: (
          alias: string,
        ) => sql<SqlBool>`(${sql.ref(`${alias}.reauth_at`)} is not null
          and ${sql.ref(`${alias}.reauth_at`)} >= ${REAUTH_FLOOR}
          and ${sql.ref(`${alias}.reauth_at`)} <= ${DB_TIME})`,
      }
    : {};
  if (input.scope.kind === 'organization') {
    return actorAuthority(ctx, fence, {
      permission: policyPermission(input.kind, 'organization'),
      projectId: null,
      providerAnchors: input.providerAnchors,
      ...options,
    });
  }
  const projectId = input.scope.projectId;
  const session = liveActorSession(ctx, fence, options);
  const viaProject = holdsPermission(ctx, {
    userId: fence.userId,
    permission: policyPermission(input.kind, 'project'),
    projectId,
    providerAnchors: input.providerAnchors,
    projectState: 'active',
    session: fence.sessionId,
  });
  const viaOrganization = holdsPermission(ctx, {
    userId: fence.userId,
    permission: policyPermission(input.kind, 'organization'),
    projectId: null,
    providerAnchors: input.providerAnchors,
    projectState: 'active',
    session: fence.sessionId,
  });
  const activeProject = existsGuard((database) =>
    database
      .selectFrom('project as pa_project')
      .select('pa_project.id')
      .where('pa_project.org_id', '=', ctx.orgId)
      .where('pa_project.id', '=', projectId)
      .where('pa_project.status', '=', sql.lit('active')),
  );
  return sql<SqlBool>`(${session} and (${viaProject} or (${activeProject} and ${viaOrganization})))`;
}
