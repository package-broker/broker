import { sql, type ExpressionBuilder, type SqlBool } from 'kysely';
import { DEFAULT_ROLES, type DefaultRoleKey } from '@package-broker/core/authz/permissions';
import type { OrgContext, ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import { normalizeEmail } from '@package-broker/core/identity/policy';
import { compile, db, existsGuard, type Database, type Guard } from '../kysely.js';
import { seedDefaultsStatements } from './role.js';

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SETUP_HASH = /^[0-9a-f]{64}$/;
const ID = /^[\x21-\x7e]{1,64}$/;
const ADMIN_ROLE_KEY: DefaultRoleKey = 'organization_admin';

export interface BootstrapAdminInput {
  readonly email: string;
  readonly userId: string;
  readonly setupHash: string;
  readonly setupExpiresAt: string;
  readonly grantId: string;
  readonly roleIds: Readonly<Record<DefaultRoleKey, string>>;
  readonly opId: string;
  readonly now: string;
}

export interface ResetLocalLoginInput {
  readonly email: string;
  readonly setupHash: string;
  readonly setupExpiresAt: string;
  readonly grantId: string;
  readonly roleIds: Readonly<Record<DefaultRoleKey, string>>;
  readonly opId: string;
  readonly now: string;
}

function scalar(query: Parameters<typeof compile>[0]): ScalarStatement {
  return compile(query) as ScalarStatement;
}

function requireEmail(raw: string): string {
  const email = typeof raw === 'string' ? normalizeEmail(raw) : null;
  if (email === null) throw new TypeError('invalid e-mail address');
  return email;
}

function requireId(field: string, value: string): string {
  if (typeof value !== 'string' || !ID.test(value)) {
    throw new TypeError(`${field} must be 1 to 64 printable ASCII characters`);
  }
  return value;
}

function requireTimestamp(field: string, value: string): string {
  if (typeof value === 'string' && TIMESTAMP.test(value)) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime()) && parsed.toISOString() === value) return value;
  }
  throw new TypeError(`${field} must be a UTC timestamp with millisecond precision`);
}

function requireSetup(hash: string, expiresAt: string, now: string): void {
  if (typeof hash !== 'string' || !SETUP_HASH.test(hash)) {
    throw new TypeError('setupHash must be 64 lowercase hexadecimal characters');
  }
  requireTimestamp('setupExpiresAt', expiresAt);
  requireTimestamp('now', now);
  if (Date.parse(expiresAt) <= Date.parse(now)) {
    throw new TypeError('setupExpiresAt must be later than now');
  }
}

function requireRoleIds(roleIds: Readonly<Record<DefaultRoleKey, string>>): void {
  for (const { key } of DEFAULT_ROLES) requireId(`roleIds.${key}`, roleIds[key]);
}

function userIdOf(ctx: OrgContext, email: string) {
  return db
    .selectFrom('user_account as target')
    .select('target.id')
    .where('target.org_id', '=', ctx.orgId)
    .where('target.email', '=', email);
}

function adminRoleIdOf(ctx: OrgContext) {
  return db
    .selectFrom('role')
    .select('role.id')
    .where('role.org_id', '=', ctx.orgId)
    .where('role.key', '=', ADMIN_ROLE_KEY);
}

function adminRoleExists(ctx: OrgContext): Guard {
  return existsGuard((database) =>
    database
      .selectFrom('role as admin_role')
      .select(sql.lit(1).as('one'))
      .where('admin_role.org_id', '=', ctx.orgId)
      .where('admin_role.key', '=', ADMIN_ROLE_KEY),
  );
}

function notSetUp(ctx: OrgContext, email: string): Guard {
  return sql<SqlBool>`not ${existsGuard((database) =>
    database
      .selectFrom('local_login as settled')
      .select(sql.lit(1).as('one'))
      .where('settled.org_id', '=', ctx.orgId)
      .where('settled.password_hash', 'is not', null)
      .where('settled.user_id', '=', userIdOf(ctx, email)),
  )}`;
}

function ownsOperation(ctx: OrgContext, email: string, opId: string): Guard {
  return existsGuard((database) =>
    database
      .selectFrom('local_login as owned')
      .select(sql.lit(1).as('one'))
      .where('owned.org_id', '=', ctx.orgId)
      .where('owned.last_op_id', '=', opId)
      .where('owned.user_id', '=', userIdOf(ctx, email)),
  );
}

function adminGrantStatements(
  ctx: OrgContext,
  input: { readonly email: string; readonly grantId: string; readonly now: string },
  guard: Guard | null,
): ScalarStatement[] {
  const organizationEmailGrant = (eb: ExpressionBuilder<Database, 'access_grant'>) =>
    eb.and([
      eb('access_grant.org_id', '=', ctx.orgId),
      eb('access_grant.scope', '=', 'organization'),
      eb('access_grant.subject_type', '=', 'email'),
      eb('access_grant.subject_value', '=', input.email),
    ]);

  let promote = db
    .updateTable('access_grant')
    .set({ role_id: adminRoleIdOf(ctx), updated_at: input.now })
    .where(organizationEmailGrant)
    .where((eb) => eb.exists(adminRoleIdOf(ctx)));
  if (guard !== null) promote = promote.where(guard);

  let source = db
    .selectFrom('role')
    .select((eb) => [
      eb.val(input.grantId).as('id'),
      eb.val(ctx.orgId).as('org_id'),
      eb.val('email').as('subject_type'),
      eb.val(input.email).as('subject_value'),
      eb.val('organization').as('scope'),
      'role.id as role_id',
      eb.val(input.now).as('created_at'),
      eb.val(input.now).as('updated_at'),
    ])
    .where('role.org_id', '=', ctx.orgId)
    .where('role.key', '=', ADMIN_ROLE_KEY)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb.selectFrom('access_grant').select(sql.lit(1).as('one')).where(organizationEmailGrant),
        ),
      ),
    );
  if (guard !== null) source = source.where(guard);

  const insert = db
    .insertInto('access_grant')
    .columns([
      'id',
      'org_id',
      'subject_type',
      'subject_value',
      'scope',
      'role_id',
      'created_at',
      'updated_at',
    ])
    .expression(source);

  return [scalar(promote), scalar(insert)];
}

function rowsOf(result: { readonly rows: readonly unknown[] } | undefined): number {
  return result === undefined ? 0 : result.rows.length;
}

function loginSource(
  ctx: OrgContext,
  email: string,
  input: {
    readonly setupHash: string;
    readonly setupExpiresAt: string;
    readonly opId: string;
    readonly now: string;
  },
) {
  return db
    .selectFrom('user_account as target')
    .select((eb) => [
      'target.id as user_id',
      eb.val(ctx.orgId).as('org_id'),
      eb.val(input.setupHash).as('setup_hash'),
      eb.val(input.setupExpiresAt).as('setup_expires_at'),
      eb.val(input.opId).as('last_op_id'),
      eb.val(input.now).as('created_at'),
      eb.val(input.now).as('updated_at'),
    ])
    .where('target.org_id', '=', ctx.orgId)
    .where('target.email', '=', email);
}

export async function bootstrapAdmin(
  executor: ScalarSqlExecutor,
  ctx: OrgContext,
  input: BootstrapAdminInput,
): Promise<'created' | 'refreshed' | 'already_set_up'> {
  const email = requireEmail(input.email);
  requireId('userId', input.userId);
  requireId('grantId', input.grantId);
  requireId('opId', input.opId);
  requireSetup(input.setupHash, input.setupExpiresAt, input.now);
  requireRoleIds(input.roleIds);

  const existed = scalar(
    db.selectNoFrom((eb) =>
      eb
        .exists(
          eb
            .selectFrom('local_login')
            .select(sql.lit(1).as('one'))
            .where('local_login.org_id', '=', ctx.orgId)
            .where('local_login.user_id', '=', userIdOf(ctx, email)),
        )
        .as('existed'),
    ),
  );

  const pending = notSetUp(ctx, email);

  const user = scalar(
    db
      .insertInto('user_account')
      .columns(['id', 'org_id', 'email', 'status', 'created_at', 'updated_at'])
      .expression(
        db
          .selectNoFrom((eb) => [
            eb.val(input.userId).as('id'),
            eb.val(ctx.orgId).as('org_id'),
            eb.val(email).as('email'),
            eb.val('active').as('status'),
            eb.val(input.now).as('created_at'),
            eb.val(input.now).as('updated_at'),
          ])
          .where(pending),
      )
      .onConflict((conflict) =>
        conflict.columns(['org_id', 'email']).doUpdateSet((eb) => ({
          status: 'active',
          updated_at: eb.ref('excluded.updated_at'),
        })),
      ),
  );

  const login = scalar(
    db
      .insertInto('local_login')
      .columns([
        'user_id',
        'org_id',
        'setup_hash',
        'setup_expires_at',
        'last_op_id',
        'created_at',
        'updated_at',
      ])
      .expression(loginSource(ctx, email, input))
      .onConflict((conflict) =>
        conflict
          .column('user_id')
          .doUpdateSet((eb) => ({
            setup_hash: eb.ref('excluded.setup_hash'),
            setup_expires_at: eb.ref('excluded.setup_expires_at'),
            last_op_id: eb.ref('excluded.last_op_id'),
            failed_count: 0,
            locked_until: null,
            updated_at: eb.ref('excluded.updated_at'),
          }))
          .where('local_login.password_hash', 'is', null),
      )
      .returning('user_id'),
  );

  const results = await executor.batch([
    existed,
    ...seedDefaultsStatements(ctx, { now: input.now, ids: input.roleIds }),
    user,
    ...adminGrantStatements(ctx, { email, grantId: input.grantId, now: input.now }, pending),
    login,
  ]);

  if (rowsOf(results[results.length - 1]) === 0) return 'already_set_up';
  const previous = results[0]?.rows[0] as { existed?: number } | undefined;
  return Number(previous?.existed) === 1 ? 'refreshed' : 'created';
}

/**
 * 'admin_role_missing': the organization has no `organization_admin` role (bootstrap seeds it);
 * nothing was written. 'not_found': no such user. `roleIds` is validated and otherwise unused.
 */
export async function resetLocalLogin(
  executor: ScalarSqlExecutor,
  ctx: OrgContext,
  input: ResetLocalLoginInput,
): Promise<'reset' | 'not_found' | 'admin_role_missing'> {
  const email = requireEmail(input.email);
  requireId('grantId', input.grantId);
  requireId('opId', input.opId);
  requireSetup(input.setupHash, input.setupExpiresAt, input.now);
  requireRoleIds(input.roleIds);

  const roleExists = adminRoleExists(ctx);
  const owned = sql<SqlBool>`${ownsOperation(ctx, email, input.opId)} and ${roleExists}`;

  const hasAdminRole = scalar(
    db.selectNoFrom((eb) =>
      eb
        .exists(
          eb
            .selectFrom('role as admin_role')
            .select(sql.lit(1).as('one'))
            .where('admin_role.org_id', '=', ctx.orgId)
            .where('admin_role.key', '=', ADMIN_ROLE_KEY),
        )
        .as('has_role'),
    ),
  );

  const dropTotp = scalar(
    db
      .deleteFrom('credential')
      .where('credential.org_id', '=', ctx.orgId)
      .where('credential.id', '=', (eb) =>
        eb
          .selectFrom('local_login')
          .select('local_login.totp_credential_id')
          .where('local_login.org_id', '=', ctx.orgId)
          .where('local_login.user_id', '=', userIdOf(ctx, email)),
      )
      .where(roleExists),
  );

  const clear = scalar(
    db
      .updateTable('local_login')
      .set((eb) => ({
        password_hash: null,
        totp_credential_id: null,
        totp_enabled_at: null,
        totp_last_step: null,
        credential_rev: eb('credential_rev', '+', 1),
        failed_count: 0,
        locked_until: null,
        setup_hash: input.setupHash,
        setup_expires_at: input.setupExpiresAt,
        last_op_id: input.opId,
        updated_at: input.now,
      }))
      .where('local_login.org_id', '=', ctx.orgId)
      .where('local_login.user_id', '=', userIdOf(ctx, email))
      .where(roleExists)
      .returning('user_id'),
  );

  const create = scalar(
    db
      .insertInto('local_login')
      .columns([
        'user_id',
        'org_id',
        'setup_hash',
        'setup_expires_at',
        'last_op_id',
        'created_at',
        'updated_at',
      ])
      .expression(loginSource(ctx, email, input).where(roleExists))
      .onConflict((conflict) => conflict.column('user_id').doNothing())
      .returning('user_id'),
  );

  const reactivate = scalar(
    db
      .updateTable('user_account')
      .set({ status: 'active', updated_at: input.now })
      .where('user_account.org_id', '=', ctx.orgId)
      .where('user_account.email', '=', email)
      .where(owned),
  );

  const revoke = scalar(
    db
      .updateTable('session')
      .set({ revoked_at: input.now })
      .where('session.org_id', '=', ctx.orgId)
      .where('session.user_id', '=', userIdOf(ctx, email))
      .where('session.revoked_at', 'is', null)
      .where(owned),
  );

  const results = await executor.batch([
    hasAdminRole,
    dropTotp,
    clear,
    create,
    reactivate,
    ...adminGrantStatements(ctx, { email, grantId: input.grantId, now: input.now }, owned),
    revoke,
  ]);

  const present = results[0]?.rows[0] as { has_role?: number } | undefined;
  if (Number(present?.has_role) !== 1) return 'admin_role_missing';
  return rowsOf(results[2]) + rowsOf(results[3]) > 0 ? 'reset' : 'not_found';
}
