import { auditEvent } from '@package-broker/core/audit/actions';
import { auditPendingStatement } from './audit-pending.js';
import { sql, type ExpressionBuilder, type SqlBool } from 'kysely';
import { DEFAULT_ROLES, type DefaultRoleKey } from '@package-broker/core/authz/permissions';
import type { OrgContext, ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import { ACCESS_MUTATION_GUARD_CONSTRAINT, DbError } from '@package-broker/core/db/errors';
import type { GrantSubject } from '@package-broker/core/db/grants';
import { isValidProviderId } from '@package-broker/core/identity/port';
import { normalizeEmail } from '@package-broker/core/identity/policy';
import {
  assertCheck,
  cacheEpochBumpStatements,
  compile,
  db,
  existsGuard,
  newOpId,
  type Database,
  type Guard,
} from '../kysely.js';
import { seedDefaultsStatements } from './role.js';

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SETUP_HASH = /^[0-9a-f]{64}$/;
const ID = /^[\x21-\x7e]{1,64}$/;
const ADMIN_ROLE_KEY: DefaultRoleKey = 'organization_admin';
const ADMIN_PERMISSIONS = JSON.stringify(adminCatalogue());

function adminCatalogue(): readonly string[] {
  const role = DEFAULT_ROLES.find((candidate) => candidate.key === ADMIN_ROLE_KEY);
  if (role === undefined) throw new Error('DEFAULT_ROLES has no organization_admin role');
  return role.permissions;
}

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

export interface BootstrapAdminOutcome {
  readonly result: 'created' | 'refreshed' | 'already_set_up';
  readonly toppedUp: number;
}

export type BootstrapSsoAdminInput = {
  readonly grantId: string;
  readonly roleIds: Readonly<Record<DefaultRoleKey, string>>;
  readonly now: string;
} & (
  | {
      readonly subject: { readonly type: 'email'; readonly value: string };
      readonly userId: string;
    }
  | {
      readonly subject: {
        readonly type: 'group';
        readonly provider: string;
        readonly value: string;
      };
    }
);

export interface BootstrapSsoAdminOutcome {
  readonly result: 'created' | 'already_admin' | 'promoted';
  readonly toppedUp: number;
}

export class SuspendedSsoAdminError extends Error {
  constructor() {
    super('SSO admin account is suspended');
    this.name = 'SuspendedSsoAdminError';
  }
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

export async function hasUnusedLocalSetupToken(
  executor: ScalarSqlExecutor,
  ctx: OrgContext,
  rawEmail: string,
): Promise<boolean> {
  const email = requireEmail(rawEmail);
  const rows = await executor.all(
    scalar(
      db
        .selectFrom('local_login')
        .select('local_login.user_id')
        .where('local_login.org_id', '=', ctx.orgId)
        .where('local_login.user_id', '=', userIdOf(ctx, email))
        .where('local_login.password_hash', 'is', null)
        .where('local_login.setup_hash', 'is not', null),
    ),
  );
  return rows.length > 0;
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
  input: { readonly subject: GrantSubject; readonly grantId: string; readonly now: string },
  guard: Guard | null,
): ScalarStatement[] {
  const { subject } = input;
  const provider = subject.type === 'group' ? subject.provider : null;
  const organizationGrant = (eb: ExpressionBuilder<Database, 'access_grant'>) =>
    eb.and([
      eb('access_grant.org_id', '=', ctx.orgId),
      eb('access_grant.scope', '=', 'organization'),
      eb('access_grant.subject_type', '=', subject.type),
      eb('access_grant.subject_value', '=', subject.value),
      eb('access_grant.subject_provider', provider === null ? 'is' : '=', provider),
    ]);

  let promote = db
    .updateTable('access_grant')
    .set({
      role_id: adminRoleIdOf(ctx),
      updated_at: input.now,
      revision: sql`revision + 1`,
      last_op_id: newOpId(),
    })
    .where(organizationGrant)
    .where((eb) => eb.exists(adminRoleIdOf(ctx)))
    .where('role_id', '!=', adminRoleIdOf(ctx))
    .returning('id');
  if (guard !== null) promote = promote.where(guard);

  let source = db
    .selectFrom('role')
    .select((eb) => [
      eb.val(input.grantId).as('id'),
      eb.val(ctx.orgId).as('org_id'),
      eb.val(subject.type).as('subject_type'),
      eb.val(subject.value).as('subject_value'),
      eb.val(provider).as('subject_provider'),
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
          eb.selectFrom('access_grant').select(sql.lit(1).as('one')).where(organizationGrant),
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
      'subject_provider',
      'scope',
      'role_id',
      'created_at',
      'updated_at',
    ])
    .expression(source)
    .returning('id');

  const changed = sql<SqlBool>`${adminRoleExists(ctx)} and not ${existsGuard(() =>
    db
      .selectFrom('access_grant')
      .select(sql.lit(1).as('one'))
      .where(organizationGrant)
      .where('role_id', '=', adminRoleIdOf(ctx)),
  )}${guard === null ? sql`` : sql` and ${guard}`}`;
  return [
    ...(cacheEpochBumpStatements(ctx, changed) as ScalarStatement[]),
    scalar(promote),
    scalar(insert),
  ];
}

function protectedAdminRoles(ctx: OrgContext) {
  return db
    .selectFrom('role as topup_role')
    .innerJoin(sql`json_each(${ADMIN_PERMISSIONS})`.as('wanted'), (join) => join.onTrue())
    .where('topup_role.org_id', '=', ctx.orgId)
    .where('topup_role.key', '=', ADMIN_ROLE_KEY)
    .where('topup_role.is_system', '=', 1)
    .where('topup_role.protects_last_holder', '=', 1);
}

function adminPermissionsMissing(ctx: OrgContext): Guard {
  return existsGuard(() =>
    protectedAdminRoles(ctx)
      .select(sql.lit(1).as('one'))
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('role_permission as held')
              .select(sql.lit(1).as('one'))
              .whereRef('held.org_id', '=', 'topup_role.org_id')
              .whereRef('held.role_id', '=', 'topup_role.id')
              .where(sql<SqlBool>`held.permission = wanted.value`),
          ),
        ),
      ),
  );
}

/**
 * Runs before the seed: an existing protected admin role missing catalogue permissions gets them here,
 * with its revision and the organization's cache_epoch bumped first, and the batch fails unless
 * exactly one cache_epoch row was replaced. The insert returns one row per added permission. A role
 * created by the seed later in the batch is not a top-up.
 */
function adminTopUpStatements(ctx: OrgContext, now: string): ScalarStatement[] {
  const missing = adminPermissionsMissing(ctx);
  const bumpEpoch = db
    .updateTable('cache_epoch')
    .set({ version: sql<string>`hex(randomblob(16))` })
    .where('cache_epoch.org_id', '=', ctx.orgId)
    .where(missing);
  const epochBumpedOnce = db
    .insertInto('access_mutation_guard')
    .columns(['key'])
    .expression(
      db
        .selectFrom(sql`json_each('[1,2]')`.as('twice'))
        .select(sql<string>`${newOpId()}`.as('key'))
        .where(sql<SqlBool>`changes() <> 1`)
        .where(missing),
    );
  const revise = db
    .updateTable('role')
    .set((eb) => ({ revision: eb('revision', '+', 1), updated_at: now }))
    .where('role.org_id', '=', ctx.orgId)
    .where('role.key', '=', ADMIN_ROLE_KEY)
    .where('role.is_system', '=', 1)
    .where('role.protects_last_holder', '=', 1)
    .where(missing);
  const insert = db
    .insertInto('role_permission')
    .columns(['org_id', 'role_id', 'permission'])
    .expression(
      protectedAdminRoles(ctx).select((eb) => [
        eb.val(ctx.orgId).as('org_id'),
        'topup_role.id as role_id',
        sql<string>`wanted.value`.as('permission'),
      ]),
    )
    .onConflict((conflict) => conflict.doNothing())
    .returning('permission');
  return [scalar(bumpEpoch), scalar(epochBumpedOnce), scalar(revise), scalar(insert)];
}

function publisherSeedAudit(
  ctx: OrgContext,
  input: { readonly now: string; readonly roleIds: Readonly<Record<DefaultRoleKey, string>> },
): ScalarStatement {
  const role = DEFAULT_ROLES.find((role) => role.key === 'organization_publisher')!;
  const event = auditEvent({
    id: newOpId(),
    now: input.now,
    action: 'role.create',
    actor: { type: 'system', id: null },
    target: { type: 'role', id: input.roleIds.organization_publisher },
    context: { opId: newOpId(), requestId: newOpId(), sourceIp: null, tokenSelector: null },
    changes: {
      key: { new: role.key },
      name: { new: role.name },
      scope: { new: role.scope },
      permissions: { new: role.permissions },
    },
  });
  if (!event.ok) throw new TypeError('invalid_role_audit');
  return auditPendingStatement(
    ctx,
    event.event,
    scalar({
      compile: () =>
        sql<boolean>`not exists(select 1 from role where org_id=${ctx.orgId} and key='organization_publisher') and exists(select 1 from role where org_id=${ctx.orgId} and key='organization_admin')`.compile(
          db,
        ),
    }),
  ) as ScalarStatement;
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
): Promise<BootstrapAdminOutcome['result']> {
  return (await bootstrapAdminWithTopUp(executor, ctx, input)).result;
}

/** As bootstrapAdmin, also reporting how many organization_admin permissions the same batch added. */
export async function bootstrapAdminWithTopUp(
  executor: ScalarSqlExecutor,
  ctx: OrgContext,
  input: BootstrapAdminInput,
): Promise<BootstrapAdminOutcome> {
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

  const topUp = adminTopUpStatements(ctx, input.now);
  const results = await executor.batch([
    existed,
    ...topUp,
    publisherSeedAudit(ctx, input),
    ...seedDefaultsStatements(ctx, { now: input.now, ids: input.roleIds }),
    user,
    ...adminGrantStatements(
      ctx,
      { subject: { type: 'email', value: email }, grantId: input.grantId, now: input.now },
      pending,
    ),
    login,
  ]);

  const toppedUp = rowsOf(results[topUp.length]);
  if (rowsOf(results[results.length - 1]) === 0) return { result: 'already_set_up', toppedUp };
  const previous = results[0]?.rows[0] as { existed?: number } | undefined;
  return { result: Number(previous?.existed) === 1 ? 'refreshed' : 'created', toppedUp };
}

/**
 * Reports whether the organization grant was created, promoted, or already admin in the same batch.
 * Suspended email accounts throw SuspendedSsoAdminError; existing account state is preserved.
 */
export async function bootstrapSsoAdmin(
  executor: ScalarSqlExecutor,
  ctx: OrgContext,
  input: BootstrapSsoAdminInput,
): Promise<BootstrapSsoAdminOutcome> {
  requireId('grantId', input.grantId);
  requireTimestamp('now', input.now);
  requireRoleIds(input.roleIds);
  let subject: GrantSubject;
  const userStatements: ScalarStatement[] = [];
  const guards: ScalarStatement[] = [];
  let suspended: Guard | null = null;
  if (input.subject.type === 'email') {
    const email = requireEmail(input.subject.value);
    const userId = requireId('userId', 'userId' in input ? input.userId : '');
    subject = { type: 'email', value: email };
    suspended = existsGuard((database) =>
      database
        .selectFrom('user_account')
        .select(sql.lit(1).as('one'))
        .where('org_id', '=', ctx.orgId)
        .where('email', '=', email)
        .where('status', '!=', 'active'),
    );
    guards.push(...(assertCheck(sql<SqlBool>`not ${suspended}`) as ScalarStatement[]));
    userStatements.push(
      scalar(
        db
          .insertInto('user_account')
          .values({
            id: userId,
            org_id: ctx.orgId,
            email,
            status: 'active',
            created_at: input.now,
            updated_at: input.now,
          })
          .onConflict((conflict) => conflict.columns(['org_id', 'email']).doNothing()),
      ),
    );
  } else {
    const { provider, value } = input.subject;
    if (typeof provider !== 'string' || !isValidProviderId(provider)) {
      throw new TypeError('grant provider must be a valid provider id');
    }
    if (
      typeof value !== 'string' ||
      [...value].length < 1 ||
      [...value].length > 256 ||
      value !== value.trim() ||
      /[\p{Cc}\p{Cf}]/u.test(value)
    ) {
      throw new TypeError('grant group must be 1 to 256 printable characters');
    }
    subject = { type: 'group', provider, value };
  }
  const topUp = adminTopUpStatements(ctx, input.now);
  const results = await executor
    .batch([
      ...guards,
      ...topUp,
      publisherSeedAudit(ctx, input),
      ...seedDefaultsStatements(ctx, { now: input.now, ids: input.roleIds }),
      ...userStatements,
      ...adminGrantStatements(ctx, { subject, grantId: input.grantId, now: input.now }, null),
    ])
    .catch(async (error: unknown) => {
      if (
        suspended !== null &&
        error instanceof DbError &&
        error.kind === 'unique' &&
        error.constraint === ACCESS_MUTATION_GUARD_CONSTRAINT
      ) {
        const [state] = await executor.all<{ suspended: number }>(
          scalar(db.selectNoFrom(sql<SqlBool>`${suspended}`.as('suspended'))),
        );
        if (Number(state?.suspended) === 1) throw new SuspendedSsoAdminError();
      }
      throw error;
    });
  return {
    result:
      rowsOf(results[results.length - 1]) > 0
        ? 'created'
        : rowsOf(results[results.length - 2]) > 0
          ? 'promoted'
          : 'already_admin',
    toppedUp: rowsOf(results[guards.length + topUp.length - 1]),
  };
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
    ...adminGrantStatements(
      ctx,
      { subject: { type: 'email', value: email }, grantId: input.grantId, now: input.now },
      owned,
    ),
    revoke,
  ]);

  const present = results[0]?.rows[0] as { has_role?: number } | undefined;
  if (Number(present?.has_role) !== 1) return 'admin_role_missing';
  return rowsOf(results[2]) + rowsOf(results[3]) > 0 ? 'reset' : 'not_found';
}
