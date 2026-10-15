import { sql } from 'kysely';
import type { CredentialRecord } from '@package-broker/core/db/credentials';
import type { LocalLoginSetupWriter } from '@package-broker/core/db/local-login';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { adminEligibility, compile, db, newOpId, opGuard, type Guard } from '../kysely.js';
import { createCredentialRepository } from './credential.js';
import { revokePreviousStatement, sessionInsertStatement } from './session.js';

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SECRET_HASH = /^[0-9a-f]{64}$/;
const PASSWORD_HASH_PREFIX = 'pbkdf2-sha256$';
const TOTP_KIND = 'totp';

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

function secretHash(field: string, value: string): string {
  if (typeof value !== 'string' || !SECRET_HASH.test(value)) {
    throw new TypeError(`${field} must be 64 lowercase hexadecimal characters`);
  }
  return value;
}

function nonNegativeInteger(field: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function markSetup(
  ctx: OrgContext,
  input: { userId: string; setupHash: string; opId: string; now: string },
): Statement {
  return compile(
    db
      .updateTable('local_login')
      .set({ last_op_id: input.opId, updated_at: input.now })
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', input.userId)
      .where('setup_hash', '=', input.setupHash)
      .where('setup_expires_at', '>', input.now)
      .where('totp_enabled_at', 'is', null)
      .where('last_op_id', 'is not', input.opId),
  );
}

function deletePending(ctx: OrgContext, userId: string, guard: Guard): Statement {
  return compile(
    db
      .deleteFrom('credential')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', (eb) =>
        eb
          .selectFrom('local_login')
          .select('local_login.totp_credential_id')
          .where('local_login.org_id', '=', ctx.orgId)
          .where('local_login.user_id', '=', userId)
          .where('local_login.totp_enabled_at', 'is', null),
      )
      .where(guard),
  );
}

function insertPending(
  ctx: OrgContext,
  row: CredentialRecord & { readonly now: string },
  guard: Guard,
): Statement {
  return compile(
    db
      .insertInto('credential')
      .columns([
        'id',
        'org_id',
        'project_id',
        'kind',
        'ciphertext',
        'nonce',
        'key_version',
        'aad',
        'rotated_at',
        'created_at',
        'updated_at',
      ])
      .expression(
        db
          .selectNoFrom((eb) => [
            eb.val(row.id).as('id'),
            eb.val(ctx.orgId).as('org_id'),
            eb.val(null).as('project_id'),
            eb.val(row.kind).as('kind'),
            eb.val(row.sealed.ciphertext).as('ciphertext'),
            eb.val(row.sealed.nonce).as('nonce'),
            eb.val(row.sealed.keyVersion).as('key_version'),
            eb.val(row.aad).as('aad'),
            eb.val(row.rotatedAt).as('rotated_at'),
            eb.val(row.now).as('created_at'),
            eb.val(row.now).as('updated_at'),
          ])
          .where(guard),
      ),
  );
}

function pointAtPending(
  ctx: OrgContext,
  userId: string,
  credentialId: string,
  now: string,
  guard: Guard,
): Statement {
  return compile(
    db
      .updateTable('local_login')
      .set({ totp_credential_id: credentialId, updated_at: now })
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', userId)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('credential')
            .select(sql.lit(1).as('one'))
            .where('credential.id', '=', credentialId)
            .where('credential.org_id', '=', ctx.orgId)
            .where('credential.kind', '=', TOTP_KIND)
            .where('credential.created_at', '=', now),
        ),
      )
      .where(guard),
  );
}

export function createLocalLoginSetupWriter(executor: SqlExecutor): LocalLoginSetupWriter {
  const credentials = createCredentialRepository(executor);

  return {
    async stagePendingTotp(ctx, input) {
      const now = timestamp('now', input.now);
      const setupHash = secretHash('setupHash', input.setupHash);
      credentials.insertStatement(ctx, input.credential);
      if (input.credential.projectId !== null || input.credential.kind !== TOTP_KIND) {
        throw new TypeError('credential must be an organization-level totp credential');
      }
      if (input.credential.now !== now) {
        throw new TypeError('credential.now must equal now');
      }
      const opId = newOpId();
      const guard = opGuard(ctx, 'local_login', { userId: input.userId }, opId);

      const results = await executor.batch([
        markSetup(ctx, { userId: input.userId, setupHash, opId, now }),
        deletePending(ctx, input.userId, guard),
        insertPending(ctx, input.credential, guard),
        pointAtPending(ctx, input.userId, input.credential.id, now, guard),
      ]);
      return results[3]?.changes === 1;
    },

    async completeSetup(ctx, input) {
      if (input.session.userId !== input.userId) {
        throw new TypeError('session.userId must be the user being set up');
      }
      const now = timestamp('now', input.now);
      const setupHash = secretHash('setupHash', input.setupHash);
      const step = nonNegativeInteger('step', input.step);
      const credentialRev = nonNegativeInteger('credentialRev', input.credentialRev);
      if (
        typeof input.passwordHash !== 'string' ||
        !input.passwordHash.startsWith(PASSWORD_HASH_PREFIX)
      ) {
        throw new TypeError(`passwordHash must start with ${PASSWORD_HASH_PREFIX}`);
      }
      if (input.session.identityId !== null) {
        throw new TypeError('session.identityId must be null for a local login');
      }
      if (input.session.now !== now) {
        throw new TypeError('session.now must equal now');
      }
      const opId = newOpId();
      const guard = opGuard(ctx, 'local_login', { userId: input.userId }, opId);
      const statements: Statement[] = [
        compile(
          db
            .updateTable('local_login')
            .set({
              password_hash: input.passwordHash,
              totp_enabled_at: now,
              totp_last_step: step,
              credential_rev: sql<number>`credential_rev + 1`,
              setup_hash: null,
              setup_expires_at: null,
              failed_count: 0,
              locked_until: null,
              last_op_id: opId,
              last_login_at: now,
              updated_at: now,
            })
            .where('org_id', '=', ctx.orgId)
            .where('user_id', '=', input.userId)
            .where('setup_hash', '=', setupHash)
            .where('setup_expires_at', '>', now)
            .where('totp_credential_id', '=', input.expectedCredentialId)
            .where('credential_rev', '=', credentialRev)
            .where('last_op_id', 'is not', opId)
            .where((eb) => adminEligibility(ctx, eb.ref('local_login.user_id'))),
        ),
        sessionInsertStatement(ctx, input.session, [guard]),
      ];
      if (input.previousSecretHash !== null) {
        statements.push(
          revokePreviousStatement(ctx, input.previousSecretHash, input.session.id, now),
        );
      }

      const results = await executor.batch(statements);
      return results[1]?.changes === 1;
    },
  };
}
