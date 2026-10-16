import { sql, type Compilable, type Kysely, type SqlBool } from 'kysely';
import {
  REAUTH_WINDOW_MS,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
} from '@package-broker/core/auth/session';
import type { MutationFence } from '@package-broker/core/authz/fence';
import type { UnblockStoreOutcome } from '@package-broker/core/authz/unlink-service';
import type { OrgContext, ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import {
  isValidProviderId,
  isValidSubject,
  isValidTrustAnchor,
} from '@package-broker/core/identity/port';
import {
  assertCheck,
  assertGuard,
  compile,
  db,
  existsGuard,
  runOrgFenced,
  type Guard,
  type ProtectedHolderInput,
} from '../kysely.js';
import { holdsPermission, permissionRows } from './access.js';

type LooseDatabase = Record<string, Record<string, unknown>>;

const loose = db as unknown as Kysely<LooseDatabase>;

const DB_TIME = sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

function dbTimeAgo(ms: number) {
  return sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ${`-${ms / 1000} seconds`})`;
}

export interface IdentityBlockKey {
  readonly provider: string;
  /** The trust anchor recorded when the block was placed. */
  readonly issuer: string;
  readonly subject: string;
}

export type UnblockIdentityOutcome = UnblockStoreOutcome;

export interface IdentityBlockRepositoryOptions {
  readonly holderInput: (ctx: OrgContext) => ProtectedHolderInput | Promise<ProtectedHolderInput>;
}

export interface IdentityBlockRepository {
  unblock(
    ctx: OrgContext,
    fence: MutationFence,
    key: IdentityBlockKey,
  ): Promise<UnblockIdentityOutcome>;
}

function scalar(query: Compilable): ScalarStatement {
  return compile(query) as ScalarStatement;
}

function probe(condition: Guard): ScalarStatement {
  return scalar(db.selectNoFrom(sql<number>`${condition}`.as('holds')));
}

function requireKey(key: IdentityBlockKey): IdentityBlockKey {
  if (typeof key !== 'object' || key === null) {
    throw new TypeError('identity block key must be an object');
  }
  const { provider, issuer, subject } = key;
  if (typeof provider !== 'string' || !isValidProviderId(provider)) {
    throw new TypeError('provider must be a valid provider id');
  }
  if (typeof issuer !== 'string' || !isValidTrustAnchor(issuer)) {
    throw new TypeError('issuer must be a valid trust anchor');
  }
  if (!isValidSubject(subject)) {
    throw new TypeError('subject must be a valid subject');
  }
  return { provider, issuer, subject };
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
        and s.id = ${fence.sessionId} and s.revoked_at is null
        and s.expires_at > ${DB_TIME}
        and s.created_at > ${dbTimeAgo(SESSION_ABSOLUTE_MS)}
        and coalesce(s.last_seen_at, s.created_at) > ${dbTimeAgo(SESSION_IDLE_MS)}
        and s.reauth_at is not null
        and s.reauth_at >= ${dbTimeAgo(REAUTH_WINDOW_MS)}
        and s.reauth_at <= ${DB_TIME})
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

export function createIdentityBlockRepository(
  executor: ScalarSqlExecutor,
  options: IdentityBlockRepositoryOptions,
): IdentityBlockRepository {
  return {
    unblock: async (ctx, fence, key) => {
      const checked = requireKey(key);
      return unblockIdentity(executor, ctx, fence, checked, await options.holderInput(ctx));
    },
  };
}

/**
 * One fenced batch: proves the actor's live session, reauthentication within the window,
 * `org:users:write` and protected-holder reach on database time, then deletes exactly the one block
 * row of this organization.
 */
export async function unblockIdentity(
  executor: ScalarSqlExecutor,
  ctx: OrgContext,
  fence: MutationFence,
  key: IdentityBlockKey,
  holders: ProtectedHolderInput,
): Promise<UnblockIdentityOutcome> {
  const { provider, issuer, subject } = requireKey(key);
  const { live, reach } = actorAuthority(ctx, fence, holders);
  const present = existsGuard((database) =>
    database
      .selectFrom('identity_block as present')
      .select(sql.lit(1).as('one'))
      .where('present.org_id', '=', ctx.orgId)
      .where('present.provider', '=', provider)
      .where('present.issuer', '=', issuer)
      .where('present.subject', '=', subject),
  );
  const remove = scalar(
    db
      .deleteFrom('identity_block')
      .where('identity_block.org_id', '=', ctx.orgId)
      .where('identity_block.provider', '=', provider)
      .where('identity_block.issuer', '=', issuer)
      .where('identity_block.subject', '=', subject),
  );

  const outcome = await runOrgFenced(
    executor,
    ctx,
    fence,
    assertGuard(live, ctx),
    [...assertCheck(reach), remove, ...assertCheck(sql<SqlBool>`changes() = 1`)],
    {
      authority: probe(sql<SqlBool>`(${live} and ${reach}) is not 1`),
      conflict: probe(sql<SqlBool>`${present} is not 1`),
    },
  );
  if (outcome.ok) return 'unblocked';
  if (outcome.reason === 'indeterminate') return 'indeterminate';
  if (outcome.reason === 'authority') return 'authority';
  if (outcome.reason === 'conflict') return 'not_found';
  throw new Error(`identity unblock failed unclassified (${outcome.reason})`);
}
