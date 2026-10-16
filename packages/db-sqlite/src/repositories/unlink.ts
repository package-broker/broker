import { sql, type Compilable, type Kysely, type SqlBool } from 'kysely';
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from '@package-broker/core/auth/session';
import type { MutationFence } from '@package-broker/core/authz/fence';
import type { OrgContext, ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import { isValidProviderId, isValidTrustAnchor } from '@package-broker/core/identity/port';
import {
  anchorMatches,
  assertCheck,
  assertGuard,
  compile,
  db,
  existsGuard,
  protectedHolder,
  runOrgFenced,
  type Guard,
  type ProtectedHolderInput,
} from '../kysely.js';
import { holdsPermission, permissionRows } from './access.js';
import { liveSessionCondition } from './session-liveness.js';

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type LooseDatabase = Record<string, Record<string, unknown>>;

const loose = db as unknown as Kysely<LooseDatabase>;

function dbTimeAgo(ms: number) {
  return sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ${`-${ms / 1000} seconds`})`;
}

export interface UnlinkIdentityInput {
  readonly identityId: string;
  readonly userId: string;
  readonly provider: string;
  readonly subject: string;
  /** The provider's current trust anchor; it becomes the issuer of the block. */
  readonly anchor: string;
  readonly now: string;
}

export type UnlinkIdentityOutcome =
  'unlinked' | 'authority' | 'conflict' | 'last_holder' | 'indeterminate';

function scalar(query: Compilable): ScalarStatement {
  return compile(query) as ScalarStatement;
}

function requireText(value: string, label: string): void {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function requireTimestamp(value: string): void {
  const valid =
    typeof value === 'string' &&
    TIMESTAMP.test(value) &&
    !Number.isNaN(new Date(value).getTime()) &&
    new Date(value).toISOString() === value;
  if (!valid) {
    throw new TypeError('now must be a UTC timestamp with millisecond precision');
  }
}

function probe(condition: Guard): ScalarStatement {
  return scalar(db.selectNoFrom(sql<number>`${condition}`.as('holds')));
}

function identityMatches(ctx: OrgContext, input: UnlinkIdentityInput): Guard {
  return existsGuard((database) =>
    database
      .selectFrom('identity as target')
      .select(sql.lit(1).as('one'))
      .where('target.id', '=', input.identityId)
      .where('target.org_id', '=', ctx.orgId)
      .where('target.user_id', '=', input.userId)
      .where('target.provider', '=', input.provider)
      .where('target.subject', '=', input.subject),
  );
}

function holdsAfterUnlink(
  ctx: OrgContext,
  input: UnlinkIdentityInput,
  holders: ProtectedHolderInput,
): Guard {
  const withoutIdentity: ProtectedHolderInput = {
    ...holders,
    exclude: { ...holders.exclude, identityId: input.identityId },
  };
  const withoutProvider: ProtectedHolderInput =
    holders.kind === 'fresh'
      ? {
          ...withoutIdentity,
          kind: 'fresh',
          now: holders.now,
          providers: holders.providers.filter((entry) => entry.provider !== input.provider),
        }
      : withoutIdentity;
  const targetHolds = existsGuard((database) =>
    database
      .selectFrom('user_account as target_user')
      .select(sql.lit(1).as('one'))
      .where('target_user.id', '=', input.userId)
      .where('target_user.org_id', '=', ctx.orgId)
      .where((eb) => protectedHolder(ctx, eb.ref('target_user.id'), holders)),
  );
  const anotherUser = existsGuard((database) =>
    database
      .selectFrom('user_account as holder')
      .select(sql.lit(1).as('one'))
      .where('holder.org_id', '=', ctx.orgId)
      .where('holder.id', '<>', input.userId)
      .where((eb) => protectedHolder(ctx, eb.ref('holder.id'), withoutIdentity)),
  );
  const targetStays = existsGuard((database) =>
    database
      .selectFrom('user_account as stays')
      .select(sql.lit(1).as('one'))
      .where('stays.id', '=', input.userId)
      .where('stays.org_id', '=', ctx.orgId)
      .where((eb) => protectedHolder(ctx, eb.ref('stays.id'), withoutProvider)),
  );
  return sql<SqlBool>`(not ${targetHolds} or ${anotherUser} or ${targetStays})`;
}

function actorAuthority(
  ctx: OrgContext,
  fence: MutationFence,
  holders: ProtectedHolderInput,
): { readonly live: Guard; readonly reach: Guard } {
  const providers = holders.kind === 'fresh' ? holders.providers : [];
  const localAdmin = sql<SqlBool>`exists ${loose
    .selectFrom('session as la_session')
    .select(sql.lit(1).as('one'))
    .where('la_session.org_id', '=', ctx.orgId)
    .where('la_session.id', '=', fence.sessionId)
    .where('la_session.revoked_at', 'is', null)
    .where('la_session.identity_id', 'is', null)}`;
  const live = sql<SqlBool>`(
    exists (
      select 1 from user_account au
      join session s on s.org_id = au.org_id and s.user_id = au.id
      where au.org_id = ${ctx.orgId} and au.id = ${fence.userId} and au.status = 'active'
        and s.id = ${fence.sessionId}
        and s.created_at > ${dbTimeAgo(SESSION_ABSOLUTE_MS)}
        and ${liveSessionCondition('s', SESSION_IDLE_MS / 1000)})
    and ${holdsPermission(ctx, {
      userId: fence.userId,
      permission: 'org:users:write',
      projectId: null,
      providerAnchors: providers,
      projectState: 'any',
      session: fence.sessionId,
    })})`;
  const reach = sql<SqlBool>`exists ${loose
    .selectFrom(
      permissionRows(ctx, fence.userId, null, providers, { localAdmin }).as('lr') as never,
    )
    .select(sql.lit(1).as('one'))
    .where(sql<SqlBool>`lr.protects = 1`)}`;
  return { live, reach };
}

export interface UnlinkRepositoryOptions {
  readonly holderInput: (ctx: OrgContext) => ProtectedHolderInput | Promise<ProtectedHolderInput>;
}

export interface UnlinkRepository {
  unlinkIdentity(
    ctx: OrgContext,
    fence: MutationFence,
    input: UnlinkIdentityInput,
  ): Promise<UnlinkIdentityOutcome>;
}

export function createUnlinkRepository(
  executor: ScalarSqlExecutor,
  options: UnlinkRepositoryOptions,
): UnlinkRepository {
  return {
    unlinkIdentity: async (ctx, fence, input) =>
      unlinkIdentity(executor, ctx, fence, input, await options.holderInput(ctx)),
  };
}

/**
 * One fenced batch: proves the actor, the expected identity, the provider anchor and the remaining
 * protected holders, then blocks the subject, revokes the personal tokens bound to the identity,
 * deletes its sessions and this provider's group rows for the user, and deletes the identity.
 * Sessions are deleted, never detached: a NULL session identity would read as a local session.
 */
export async function unlinkIdentity(
  executor: ScalarSqlExecutor,
  ctx: OrgContext,
  fence: MutationFence,
  input: UnlinkIdentityInput,
  holders: ProtectedHolderInput,
): Promise<UnlinkIdentityOutcome> {
  requireText(input.identityId, 'identityId');
  requireText(input.userId, 'userId');
  requireText(input.subject, 'subject');
  if (typeof input.anchor !== 'string' || !isValidTrustAnchor(input.anchor)) {
    throw new TypeError('anchor must be a valid trust anchor');
  }
  if (typeof input.provider !== 'string' || !isValidProviderId(input.provider)) {
    throw new TypeError('provider must be a valid provider id');
  }
  requireTimestamp(input.now);

  const { live, reach } = actorAuthority(ctx, fence, holders);
  const matches = identityMatches(ctx, input);
  const anchored = anchorMatches(ctx, input.provider, input.anchor);
  const remaining = holdsAfterUnlink(ctx, input, holders);
  const guard = assertGuard(live, ctx);
  const checks = [
    ...assertCheck(reach),
    ...assertCheck(matches),
    ...assertCheck(anchored),
    ...assertCheck(remaining),
  ];

  const block = scalar(
    db
      .insertInto('identity_block')
      .columns(['org_id', 'provider', 'issuer', 'subject', 'blocked_at', 'blocked_by_user_id'])
      .expression(
        db
          .selectFrom('identity as target')
          .select([
            'target.org_id',
            'target.provider',
            sql<string>`${input.anchor}`.as('issuer'),
            'target.subject',
            sql<string>`${input.now}`.as('blocked_at'),
            sql<string>`${fence.userId}`.as('blocked_by_user_id'),
          ])
          .where('target.id', '=', input.identityId)
          .where('target.org_id', '=', ctx.orgId),
      )
      .onConflict((conflict) => conflict.doNothing()),
  );
  const revokeTokens = scalar(
    db
      .updateTable('token')
      .set({ revoked_at: input.now })
      .where('token.org_id', '=', ctx.orgId)
      .where('token.validation_identity_id', '=', input.identityId)
      .where('token.revoked_at', 'is', null),
  );
  const deleteSessions = scalar(
    db
      .deleteFrom('session')
      .where('session.org_id', '=', ctx.orgId)
      .where('session.identity_id', '=', input.identityId),
  );
  const deleteGroups = scalar(
    db
      .deleteFrom('user_group')
      .where('user_group.org_id', '=', ctx.orgId)
      .where('user_group.user_id', '=', input.userId)
      .where('user_group.provider', '=', input.provider),
  );
  const deleteIdentity = scalar(
    db
      .deleteFrom('identity')
      .where('identity.id', '=', input.identityId)
      .where('identity.org_id', '=', ctx.orgId)
      .where('identity.user_id', '=', input.userId)
      .where('identity.provider', '=', input.provider)
      .where('identity.subject', '=', input.subject),
  );
  const blocked = existsGuard((database) =>
    database
      .selectFrom('identity_block as placed')
      .select(sql.lit(1).as('one'))
      .where('placed.org_id', '=', ctx.orgId)
      .where('placed.provider', '=', input.provider)
      .where('placed.issuer', '=', input.anchor)
      .where('placed.subject', '=', input.subject),
  );

  const outcome = await runOrgFenced(
    executor,
    ctx,
    fence,
    guard,
    [
      ...checks,
      block,
      ...assertCheck(blocked),
      revokeTokens,
      deleteSessions,
      deleteGroups,
      deleteIdentity,
      ...assertCheck(sql<SqlBool>`changes() = 1`),
    ],
    {
      authority: probe(sql<SqlBool>`(${live} and ${reach}) is not 1`),
      conflict: probe(sql<SqlBool>`(${matches} and ${anchored}) is not 1`),
      collision: probe(sql<SqlBool>`${remaining} is not 1`),
    },
  );
  if (outcome.ok) return 'unlinked';
  if (outcome.reason === 'indeterminate') return 'indeterminate';
  if (outcome.reason === 'authority') return 'authority';
  if (outcome.reason === 'conflict') return 'conflict';
  if (outcome.reason === 'collision') return 'last_holder';
  throw new Error(`identity unlink failed unclassified (${outcome.reason})`);
}
