import type { AdminLog } from '@package-broker/core/authz/administration';
import type { ProjectAdministrationDeps } from '@package-broker/core/authz/project-administration';
import type { OrgContext, ScalarStatement } from '@package-broker/core/db/port';

export interface AccessLossOptions {
  readonly onProjectAccessLost?: ProjectAdministrationDeps['onProjectAccessLost'];
  readonly log?: AdminLog;
}

export function grantGroupMembersStatement(ctx: OrgContext, grantId: string): ScalarStatement {
  return {
    sql: `SELECT DISTINCT member.user_id FROM access_grant AS removed
      JOIN user_group AS member ON member.org_id = removed.org_id
        AND member.provider = removed.subject_provider AND member.group_name = removed.subject_value
      WHERE removed.org_id = ? AND removed.id = ? AND removed.subject_type = 'group'`,
    params: [ctx.orgId, grantId],
  };
}

export async function notifyProjectAccessLost(
  options: AccessLossOptions,
  ctx: OrgContext,
  userIds: readonly string[],
  at: string,
): Promise<void> {
  for (const userId of userIds) {
    try {
      await options.onProjectAccessLost?.(ctx, { userId, at });
    } catch (error) {
      try {
        options.log?.({
          level: 'warn',
          event: 'user.pat_offboarding_enqueue_failed',
          orgId: ctx.orgId,
          userId,
          cause: 'project_removed',
          error: error instanceof Error ? error.name : typeof error,
        });
      } catch {
        // The access change is stored; callback and sink failures cannot undo it.
      }
    }
  }
}

/** Persists selected-token invalidation before the removed access can be reacquired. */
export function selectedPatInvalidationStatement(
  ctx: OrgContext,
  input: {
    readonly opId: string;
    readonly at: string;
    readonly grantId?: string;
    readonly userId?: string;
    readonly membership?: { readonly provider: string; readonly groups: readonly string[] };
    readonly when?: ScalarStatement;
  },
): ScalarStatement {
  const membership = input.membership;
  const userTargeted = input.userId !== undefined && input.grantId === undefined;
  // Unary + keeps login off the org-first group-name index, so it seeks the user-first key.
  const lostOrg = userTargeted ? '+lost.org_id' : 'lost.org_id';
  const storedMembership = `EXISTS (
    SELECT 1 FROM user_group AS via
    WHERE via.org_id = owner.org_id AND via.user_id = owner.id
      AND via.provider = reach.subject_provider AND via.group_name = reach.subject_value
  )`;
  const groupReach =
    membership === undefined
      ? storedMembership
      : `(
    (reach.subject_provider = ? AND reach.subject_value IN (SELECT value FROM json_each(?)))
    OR (reach.subject_provider <> ? AND ${storedMembership})
  )`;
  return {
    sql: `INSERT INTO job (id, org_id, type, payload_json, resource_key, idempotency_key)
      SELECT substr(?, 1, 10) || hex(randomblob(8)), token.org_id, 'core:pat-offboarding:v1',
        json_object('userId', token.user_id, 'cause', 'project_removed', 'cutoff', ?, 'invalidatedTokenId', token.id),
        'user:' || token.user_id, 'pat-invalidation:' || ? || ':' || token.id
      FROM token
      JOIN user_account AS owner ON owner.org_id = token.org_id AND owner.id = token.user_id
      WHERE token.org_id = ? AND token.kind = 'pat' AND token.project_mode = 'selected' AND token.revoked_at IS NULL
        AND unixepoch(token.created_at, 'subsec') <= unixepoch(?, 'subsec')
        ${input.when === undefined ? '' : `AND EXISTS (${input.when.sql})`}
        ${
          membership === undefined
            ? ''
            : `AND EXISTS (
          SELECT 1 FROM user_group AS lost
          WHERE ${lostOrg} = owner.org_id AND lost.user_id = ${userTargeted ? '?' : 'owner.id'} AND lost.provider = ?
            AND lost.group_name NOT IN (SELECT value FROM json_each(?))
        )`
        }
        AND ${
          userTargeted
            ? 'token.user_id = ?'
            : `(
          owner.id = ? OR EXISTS (
            SELECT 1 FROM access_grant AS removed
            WHERE removed.org_id = owner.org_id AND removed.id = ? AND (
              (removed.subject_type = 'email' AND removed.subject_value = owner.email)
              OR (removed.subject_type = 'group' AND EXISTS (
                SELECT 1 FROM user_group AS member
                WHERE member.org_id = owner.org_id AND member.user_id = owner.id
                  AND member.provider = removed.subject_provider AND member.group_name = removed.subject_value
              ))
            )
          )
        )`
        }
        AND NOT EXISTS (
          SELECT 1 FROM token_project AS bound
          WHERE bound.org_id = token.org_id AND bound.token_id = token.id AND EXISTS (
            SELECT 1 FROM access_grant AS reach
            WHERE reach.org_id = owner.org_id AND reach.id <> coalesce(?, '')
              AND unixepoch(reach.created_at, 'subsec') <= unixepoch(?, 'subsec')
              AND (reach.scope = 'organization' OR reach.project_id = bound.project_id)
              AND (
                (reach.subject_type = 'email' AND reach.subject_value = owner.email)
                OR (reach.subject_type = 'group' AND ${groupReach})
              )
          )
        )
      ON CONFLICT (org_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
    params: [
      input.opId,
      input.at,
      input.opId,
      ctx.orgId,
      input.at,
      ...(input.when?.params ?? []),
      ...(membership === undefined
        ? []
        : [
            ...(userTargeted ? [input.userId!] : []),
            membership.provider,
            JSON.stringify(membership.groups),
          ]),
      ...(userTargeted ? [input.userId!] : [input.userId ?? null, input.grantId ?? null]),
      input.grantId ?? null,
      input.at,
      ...(membership === undefined
        ? []
        : [membership.provider, JSON.stringify(membership.groups), membership.provider]),
    ],
  };
}
