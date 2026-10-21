import { sql, type SqlBool } from 'kysely';
import { SESSION_IDLE_MS } from '@package-broker/core/auth/session';
import type { MutationFence } from '@package-broker/core/authz/fence';
import type { OrgContext } from '@package-broker/core/db/port';
import { existsGuard, type Guard, type ProtectedHolderProvider } from '../kysely.js';
import { holdsPermission } from './access.js';
import { liveSessionCondition, requireIdleSeconds } from './session-liveness.js';

export interface LiveActorOptions {
  /** Defaults to the session idle timeout. */
  readonly idleSeconds?: number;
  readonly sessionCondition?: (alias: string) => Guard;
}

export interface ActorHoldsInput extends LiveActorOptions {
  readonly permission: string;
  /** Null checks an organization-scope permission; an id adds that project's grants. */
  readonly projectId: string | null;
  readonly allowArchived?: boolean;
  readonly providerAnchors: readonly ProtectedHolderProvider[];
}

/** The fence owns a live session whose identity, if present, belongs to the same user and org. */
export function liveActorSession(
  ctx: OrgContext,
  fence: MutationFence,
  options: LiveActorOptions = {},
): Guard {
  const idleSeconds = requireIdleSeconds(options.idleSeconds ?? SESSION_IDLE_MS / 1000);
  return existsGuard((database) => {
    const session = database
      .selectFrom('session as s')
      .innerJoin('user_account as actor', (join) =>
        join.onRef('actor.id', '=', 's.user_id').onRef('actor.org_id', '=', 's.org_id'),
      )
      .leftJoin('identity as i', (join) =>
        join
          .onRef('i.id', '=', 's.identity_id')
          .onRef('i.org_id', '=', 's.org_id')
          .onRef('i.user_id', '=', 's.user_id'),
      )
      .select('s.id')
      .where('s.org_id', '=', ctx.orgId)
      .where('s.id', '=', fence.sessionId)
      .where('s.user_id', '=', fence.userId)
      .where('actor.status', '=', sql.lit('active'))
      .where(sql<SqlBool>`(s.identity_id is null or i.id is not null)`)
      .where(liveSessionCondition('s', idleSeconds));
    return options.sessionCondition === undefined
      ? session
      : session.where(options.sessionCondition('s'));
  });
}

/** Live actor permission evidence, including project existence and archive policy. */
export function actorAuthority(
  ctx: OrgContext,
  fence: MutationFence,
  input: ActorHoldsInput,
): Guard {
  const session = liveActorSession(ctx, fence, input);
  const projectExists =
    input.projectId !== null && input.allowArchived === true
      ? existsGuard((database) =>
          database
            .selectFrom('project')
            .select('id')
            .where('org_id', '=', ctx.orgId)
            .where('id', '=', input.projectId as string),
        )
      : sql<SqlBool>`1`;
  const held = holdsPermission(ctx, {
    userId: fence.userId,
    permission: input.permission,
    projectId: input.projectId,
    providerAnchors: input.providerAnchors,
    projectState: input.allowArchived === true ? 'any' : 'active',
    session: fence.sessionId,
  });
  return sql<SqlBool>`(${session} and ${projectExists} and ${held})`;
}

/** The actor holds the permission at the instant the fenced batch runs. */
export function actorHolds(ctx: OrgContext, fence: MutationFence, input: ActorHoldsInput): Guard {
  return actorAuthority(ctx, fence, input);
}
