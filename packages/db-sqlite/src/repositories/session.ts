import { sql, type Compilable } from 'kysely';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import type {
  ActiveSession,
  NewSession,
  SessionCutoffs,
  SessionRepository,
} from '@package-broker/core/db/sessions';
import { compile, db, type Guard } from '../kysely.js';

const MAX_USER_AGENT = 512;
const MAX_IP = 64;
const MAX_DELETE_LIMIT = 500;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SECRET_HASH = /^[0-9a-f]{64}$/;

interface ActiveSessionRow {
  readonly id: string;
  readonly user_id: string;
  readonly identity_id: string | null;
  readonly csrf_hash: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly last_seen_at: string | null;
  readonly reauth_at: string | null;
  readonly user_email: string;
  readonly user_display_name: string | null;
}

interface IdRow {
  readonly id: string;
}

function run<R>(executor: SqlExecutor, query: Compilable): Promise<R[]> {
  return executor.all<R>(compile(query));
}

function truncate(value: string | null, max: number): string | null {
  if (value === null || value.length <= max) return value;
  const end = max - (isHighSurrogate(value.charCodeAt(max - 1)) ? 1 : 0);
  return value.slice(0, end);
}

function isCalendarInstant(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function timestamp(field: string, value: string): string {
  if (typeof value !== 'string' || !TIMESTAMP.test(value) || !isCalendarInstant(value)) {
    throw new TypeError(`${field} must be a UTC timestamp with millisecond precision`);
  }
  return value;
}

function secretHashOf(value: string): string {
  if (typeof value !== 'string' || !SECRET_HASH.test(value)) {
    throw new TypeError('secretHash must be 64 lowercase hexadecimal characters');
  }
  return value;
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function toActiveSession(row: ActiveSessionRow): ActiveSession {
  return {
    id: row.id,
    userId: row.user_id,
    identityId: row.identity_id,
    csrfHash: row.csrf_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
    reauthAt: row.reauth_at,
    user: { id: row.user_id, email: row.user_email, displayName: row.user_display_name },
  };
}

/**
 * The guards are evaluated in a `SELECT ... FROM user_account`, so they correlate to
 * `user_account` (`eb.ref('user_account.id')`); a reference to `session.user_id` is an error. A
 * non-null `identityId` must belong to the inserted user in this organization, else nothing is
 * inserted.
 */
export function sessionInsertStatement(
  ctx: OrgContext,
  session: NewSession,
  guards: readonly Guard[],
): Statement {
  const now = timestamp('now', session.now);
  const expiresAt = timestamp('expiresAt', session.expiresAt);
  const secretHash = secretHashOf(session.secretHash);
  let select = db
    .selectFrom('user_account')
    .select((eb) => [
      eb.val(session.id).as('id'),
      eb.val(ctx.orgId).as('org_id'),
      eb.val(session.userId).as('user_id'),
      eb.val(session.identityId).as('identity_id'),
      eb.val(secretHash).as('secret_hash'),
      eb.val(session.csrfHash).as('csrf_hash'),
      eb.val(now).as('created_at'),
      eb.val(expiresAt).as('expires_at'),
      eb.val(truncate(session.ip, MAX_IP)).as('ip'),
      eb.val(truncate(session.userAgent, MAX_USER_AGENT)).as('user_agent'),
    ])
    .where('user_account.id', '=', session.userId)
    .where('user_account.org_id', '=', ctx.orgId)
    .where('user_account.status', '=', 'active');
  const identityId = session.identityId;
  if (identityId !== null) {
    select = select.where((eb) =>
      eb.exists(
        eb
          .selectFrom('identity')
          .select(sql.lit(1).as('one'))
          .where('identity.id', '=', identityId)
          .where('identity.org_id', '=', ctx.orgId)
          .whereRef('identity.user_id', '=', 'user_account.id'),
      ),
    );
  }
  for (const guard of guards) select = select.where(guard);

  return compile(
    db
      .insertInto('session')
      .columns([
        'id',
        'org_id',
        'user_id',
        'identity_id',
        'secret_hash',
        'csrf_hash',
        'created_at',
        'expires_at',
        'ip',
        'user_agent',
      ])
      .expression(select)
      .returning('id'),
  );
}

export function revokePreviousStatement(
  ctx: OrgContext,
  previousSecretHash: string,
  newSessionId: string,
  now: string,
): Statement {
  timestamp('now', now);
  secretHashOf(previousSecretHash);
  return compile(
    db
      .updateTable('session')
      .set({ revoked_at: now })
      .where('org_id', '=', ctx.orgId)
      .where('secret_hash', '=', previousSecretHash)
      .where('revoked_at', 'is', null)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('session as created')
            .select('created.id')
            .where('created.id', '=', newSessionId)
            .where('created.org_id', '=', ctx.orgId),
        ),
      ),
  );
}

export function revokeAllForUserStatement(
  ctx: OrgContext,
  userId: string,
  now: string,
  guards: readonly Guard[],
): Statement {
  timestamp('now', now);
  let update = db
    .updateTable('session')
    .set({ revoked_at: now })
    .where('session.org_id', '=', ctx.orgId)
    .where('session.user_id', '=', userId)
    .where('session.revoked_at', 'is', null);
  for (const guard of guards) update = update.where(guard);
  return compile(update);
}

export function createSessionRepository(executor: SqlExecutor): SessionRepository {
  return {
    async findActive(
      ctx: OrgContext,
      secretHash: string,
      cutoffs: SessionCutoffs,
    ): Promise<ActiveSession | null> {
      secretHashOf(secretHash);
      timestamp('now', cutoffs.now);
      timestamp('idleSince', cutoffs.idleSince);
      const rows = await run<ActiveSessionRow>(
        executor,
        db
          .selectFrom('session')
          .innerJoin('user_account', (join) =>
            join
              .onRef('user_account.id', '=', 'session.user_id')
              .onRef('user_account.org_id', '=', 'session.org_id'),
          )
          .select([
            'session.id',
            'session.user_id',
            'session.identity_id',
            'session.csrf_hash',
            'session.created_at',
            'session.expires_at',
            'session.last_seen_at',
            'session.reauth_at',
            'user_account.email as user_email',
            'user_account.display_name as user_display_name',
          ])
          .where('session.secret_hash', '=', secretHash)
          .where('session.org_id', '=', ctx.orgId)
          .where('session.revoked_at', 'is', null)
          .where('session.expires_at', '>', cutoffs.now)
          .where(
            (eb) => eb.fn.coalesce('session.last_seen_at', 'session.created_at'),
            '>',
            cutoffs.idleSince,
          )
          .where('user_account.status', '=', 'active'),
      );
      const row = rows[0];
      return row === undefined ? null : toActiveSession(row);
    },

    async touch(ctx: OrgContext, id: string, now: string, staleBefore: string): Promise<void> {
      timestamp('now', now);
      timestamp('staleBefore', staleBefore);
      await run<IdRow>(
        executor,
        db
          .updateTable('session')
          .set({ last_seen_at: now })
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', id)
          .where('revoked_at', 'is', null)
          .where('expires_at', '>', now)
          .where((eb) => eb.fn.coalesce('last_seen_at', 'created_at'), '<', staleBefore)
          .returning('id'),
      );
    },

    async markReauthenticatedByIdentity(
      ctx: OrgContext,
      input: {
        readonly sessionId: string;
        readonly identityId: string | null;
        readonly authTime: string;
        readonly now: string;
      },
    ): Promise<boolean> {
      timestamp('now', input.now);
      timestamp('authTime', input.authTime);
      if (input.authTime > input.now) return false;
      const rows = await run<IdRow>(
        executor,
        db
          .updateTable('session')
          .set({ reauth_at: input.authTime })
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', input.sessionId)
          .where('revoked_at', 'is', null)
          .where('expires_at', '>', input.now)
          .where('identity_id', 'is', input.identityId)
          .where((eb) => eb.or([eb('reauth_at', 'is', null), eb('reauth_at', '<', input.authTime)]))
          .returning('id'),
      );
      return rows.length > 0;
    },

    async revoke(ctx: OrgContext, id: string, now: string): Promise<boolean> {
      timestamp('now', now);
      const rows = await run<IdRow>(
        executor,
        db
          .updateTable('session')
          .set({ revoked_at: now })
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', id)
          .where('revoked_at', 'is', null)
          .returning('id'),
      );
      return rows.length > 0;
    },

    async revokeBySecretHash(ctx: OrgContext, secretHash: string, now: string): Promise<boolean> {
      secretHashOf(secretHash);
      timestamp('now', now);
      const rows = await run<IdRow>(
        executor,
        db
          .updateTable('session')
          .set({ revoked_at: now })
          .where('org_id', '=', ctx.orgId)
          .where('secret_hash', '=', secretHash)
          .where('revoked_at', 'is', null)
          .returning('id'),
      );
      return rows.length > 0;
    },

    async deleteExpired(ctx: OrgContext, before: string, limit: number): Promise<number> {
      timestamp('before', before);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_DELETE_LIMIT) {
        throw new RangeError(`limit must be an integer from 1 to ${MAX_DELETE_LIMIT}`);
      }
      const rows = await run<IdRow>(
        executor,
        db
          .deleteFrom('session')
          .where('org_id', '=', ctx.orgId)
          .where('id', 'in', (eb) =>
            eb
              .selectFrom('session as expired')
              .select('expired.id')
              .where('expired.org_id', '=', ctx.orgId)
              .where('expired.expires_at', '<', before)
              .orderBy('expired.expires_at')
              .limit(limit),
          )
          .returning('id'),
      );
      return rows.length;
    },
  };
}
