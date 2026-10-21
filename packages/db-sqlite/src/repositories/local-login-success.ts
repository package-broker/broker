import { expressionBuilder, sql } from 'kysely';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import type { LocalLoginSuccessWriter } from '@package-broker/core/db/local-login';
import {
  adminEligibility,
  compile,
  db,
  newOpId,
  opGuard,
  type Database,
  type Guard,
} from '../kysely.js';
import { revokePreviousStatement, sessionInsertStatement } from './session.js';

type SucceedInput = Parameters<LocalLoginSuccessWriter['succeed']>[1];

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SECRET_HASH = /^[0-9a-f]{64}$/;
const LOCK_EVERY = 5;

const loginEb = expressionBuilder<Database, 'local_login'>();

function timestamp(field: string, value: string): string {
  if (typeof value !== 'string' || !TIMESTAMP.test(value)) {
    throw new TypeError(`${field} must be a UTC timestamp with millisecond precision`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError(`${field} must be a UTC timestamp with millisecond precision`);
  }
  return value;
}

function validate(input: SucceedInput): void {
  timestamp('now', input.now);
  if (!Number.isSafeInteger(input.step) || input.step < 0) {
    throw new TypeError('step must be a non-negative safe integer');
  }
  const { session, previousSecretHash } = input;
  if (session !== null) {
    if (session.userId !== input.snapshot.userId) {
      throw new TypeError('session must belong to the snapshot user');
    }
    if (session.identityId !== null) {
      throw new TypeError('a local login session cannot carry an identity');
    }
  }
  if (previousSecretHash !== null) {
    if (!SECRET_HASH.test(previousSecretHash)) {
      throw new TypeError('previousSecretHash must be 64 lowercase hexadecimal characters');
    }
    if (session !== null && previousSecretHash === session.secretHash) {
      throw new TypeError('previousSecretHash must differ from the new session secret');
    }
  }
}

function reauthSessionExists(
  ctx: OrgContext,
  userId: string,
  sessionId: string,
  now: string,
): Guard {
  return loginEb.exists(
    db
      .selectFrom('session')
      .select(sql.lit(1).as('one'))
      .where('session.org_id', '=', ctx.orgId)
      .where('session.id', '=', sessionId)
      .where('session.user_id', '=', userId)
      .where('session.identity_id', 'is', null)
      .where('session.revoked_at', 'is', null)
      .where('session.expires_at', '>', now)
      .where((eb) =>
        eb.or([eb('session.reauth_at', 'is', null), eb('session.reauth_at', '<', now)]),
      ),
  );
}

function updateLocalLoginStatement(
  ctx: OrgContext,
  input: SucceedInput,
  opId: string,
  passwordHash: string,
  totpCredentialId: string,
): Statement {
  const { snapshot, step, rehash, now, reauthSessionId } = input;
  const reservedLock =
    snapshot.lockedUntil !== null &&
    snapshot.failedCount > 0 &&
    snapshot.failedCount % LOCK_EVERY === 0;
  let update = db
    .updateTable('local_login')
    .set((eb) => ({
      totp_last_step: step,
      failed_count: 0,
      locked_until: null,
      last_op_id: opId,
      last_login_at: now,
      password_hash: eb.fn.coalesce(eb.val(rehash), 'local_login.password_hash'),
      updated_at: now,
    }))
    .where('local_login.org_id', '=', ctx.orgId)
    .where('local_login.user_id', '=', snapshot.userId)
    .where('local_login.credential_rev', '=', snapshot.credentialRev)
    .where('local_login.password_hash', '=', passwordHash)
    .where('local_login.totp_credential_id', '=', totpCredentialId)
    .where('local_login.totp_enabled_at', 'is not', null)
    .where((eb) =>
      eb.or([
        eb('local_login.totp_last_step', 'is', null),
        eb('local_login.totp_last_step', '<', step),
      ]),
    )
    .where((eb) =>
      eb.or([
        eb('local_login.locked_until', 'is', null),
        eb('local_login.locked_until', '<=', now),
        ...(reservedLock
          ? [
              eb.and([
                eb('local_login.locked_until', '=', snapshot.lockedUntil),
                eb('local_login.failed_count', '=', snapshot.failedCount),
              ]),
            ]
          : []),
      ]),
    )
    .where(adminEligibility(ctx, loginEb.ref('local_login.user_id')));
  if (reauthSessionId !== null) {
    update = update.where(reauthSessionExists(ctx, snapshot.userId, reauthSessionId, now));
  }
  return compile(update);
}

function reauthStatement(
  ctx: OrgContext,
  input: SucceedInput,
  sessionId: string,
  guard: Guard,
): Statement {
  return compile(
    db
      .updateTable('session')
      .set({ reauth_at: input.now })
      .where('session.org_id', '=', ctx.orgId)
      .where('session.id', '=', sessionId)
      .where('session.user_id', '=', input.snapshot.userId)
      .where('session.identity_id', 'is', null)
      .where('session.revoked_at', 'is', null)
      .where('session.expires_at', '>', input.now)
      .where((eb) =>
        eb.or([eb('session.reauth_at', 'is', null), eb('session.reauth_at', '<', input.now)]),
      )
      .where(guard),
  );
}

/**
 * Every call mints its own operation marker, so a replayed step cannot pass the later statements. A re-authenticating caller checks the
 * idle cutoff of the session itself before calling; this writer only checks revocation and expiry.
 */
export function createLocalLoginSuccessWriter(executor: SqlExecutor): LocalLoginSuccessWriter {
  return {
    async replacePasswordHash(ctx, input): Promise<boolean> {
      timestamp('now', input.now);
      if (typeof input.newHash !== 'string' || !input.newHash.startsWith('pbkdf2-sha256$')) {
        throw new TypeError('newHash must start with pbkdf2-sha256$');
      }
      const results = await executor.batch([
        compile(
          db
            .updateTable('local_login')
            .set({
              password_hash: input.newHash,
              credential_rev: sql<number>`credential_rev + 1`,
              updated_at: input.now,
            })
            .where('local_login.org_id', '=', ctx.orgId)
            .where('local_login.user_id', '=', input.userId)
            .where('local_login.password_hash', '=', input.expectedHash)
            .where((eb) =>
              eb.exists(
                db
                  .selectFrom('user_account')
                  .select(sql.lit(1).as('one'))
                  .where('user_account.org_id', '=', ctx.orgId)
                  .where('user_account.id', '=', input.userId)
                  .where('user_account.status', '=', 'active'),
              ),
            ),
        ),
      ]);
      return results[0]?.changes === 1;
    },
    async succeed(ctx, input): Promise<boolean> {
      validate(input);
      const { snapshot, session, reauthSessionId, previousSecretHash, now } = input;
      if (
        snapshot.passwordHash === null ||
        snapshot.totpCredentialId === null ||
        snapshot.totpState !== 'enabled'
      ) {
        return false;
      }
      const opId = newOpId();
      const guard = opGuard(ctx, 'local_login', { userId: snapshot.userId }, opId);
      const update = updateLocalLoginStatement(
        ctx,
        input,
        opId,
        snapshot.passwordHash,
        snapshot.totpCredentialId,
      );

      if (session !== null) {
        if (reauthSessionId !== null) {
          throw new TypeError('session and reauthSessionId are mutually exclusive');
        }
        const statements = [update, sessionInsertStatement(ctx, session, [guard])];
        if (previousSecretHash !== null) {
          statements.push(
            revokePreviousStatement(ctx, previousSecretHash, session.id, now, [guard]),
          );
        }
        const results = await executor.batch(statements);
        return (results[1]?.rows.length ?? 0) === 1;
      }
      if (reauthSessionId === null) {
        throw new TypeError('one of session and reauthSessionId must be given');
      }
      const results = await executor.batch([
        update,
        reauthStatement(ctx, input, reauthSessionId, guard),
      ]);
      return results[1]?.changes === 1;
    },
  };
}
