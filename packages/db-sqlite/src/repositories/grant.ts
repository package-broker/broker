import { sql, type Compilable, type ExpressionBuilder } from 'kysely';
import { DbError } from '@package-broker/core/db/errors';
import type {
  GrantRepository,
  GrantSubject,
  OrganizationGrant,
} from '@package-broker/core/db/grants';
import type { OrgContext, ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import { normalizeEmail } from '@package-broker/core/identity/policy';
import { isValidProviderId } from '@package-broker/core/identity/port';
import {
  compile,
  db,
  existsGuard,
  protectedHolder,
  type Database,
  type Guard,
  type ProtectedHolderExclusion,
  type ProtectedHolderInput,
} from '../kysely.js';
import { revokeAllForUserStatement } from './session.js';

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_GROUP_LENGTH = 256;
const UNSAFE_GROUP_CHARACTER = /[\p{Cc}\p{Cf}]/u;

interface GrantRow {
  readonly id: string;
  readonly subject_type: string;
  readonly subject_value: string;
  readonly subject_provider: string | null;
  readonly role_id: string;
  readonly created_by: string | null;
  readonly created_at: string;
}

interface IdRow {
  readonly id: string;
}

interface StatusRow {
  readonly status: string;
}

interface RoleCheckRow {
  readonly role_ok: number;
}

interface CountRow {
  readonly n: number;
}

function scalar(query: Compilable): ScalarStatement {
  return compile(query) as ScalarStatement;
}

function timestamp(value: string): string {
  const parsed = typeof value === 'string' ? new Date(value) : new Date(Number.NaN);
  if (!TIMESTAMP.test(value) || Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError('now must be a UTC timestamp with millisecond precision');
  }
  return value;
}

function requireSubject(subject: GrantSubject): void {
  if (typeof subject.value !== 'string') {
    throw new TypeError('grant subject value must be a string');
  }
  if (subject.type === 'email') {
    if (normalizeEmail(subject.value) !== subject.value) {
      throw new TypeError('grant e-mail must be a normalized e-mail address');
    }
    return;
  }
  if (typeof subject.provider !== 'string' || !isValidProviderId(subject.provider)) {
    throw new TypeError('grant provider must be a valid provider id');
  }
  const length = [...subject.value].length;
  if (
    length < 1 ||
    length > MAX_GROUP_LENGTH ||
    subject.value !== subject.value.trim() ||
    UNSAFE_GROUP_CHARACTER.test(subject.value)
  ) {
    throw new TypeError(`grant group must be 1 to ${MAX_GROUP_LENGTH} printable characters`);
  }
}

export type {
  ProtectedHolderExclusion,
  ProtectedHolderInput,
  ProtectedHolderProvider,
} from '../kysely.js';

export interface GrantRepositoryOptions {
  readonly holderInput: (ctx: OrgContext) => ProtectedHolderInput | Promise<ProtectedHolderInput>;
}

export interface ProtectedGrantRepository extends GrantRepository {
  isProtectedHolder(ctx: OrgContext, userId: string, input: ProtectedHolderInput): Promise<boolean>;
  countProtectedHoldersFor(ctx: OrgContext, input: ProtectedHolderInput): Promise<number>;
}

function toGrant(row: GrantRow): OrganizationGrant {
  let subject: GrantSubject;
  if (row.subject_type === 'email') {
    subject = { type: 'email', value: row.subject_value };
  } else if (row.subject_type === 'group' && row.subject_provider !== null) {
    subject = { type: 'group', provider: row.subject_provider, value: row.subject_value };
  } else {
    throw new Error('stored grant has an unexpected subject');
  }
  return {
    id: row.id,
    subject,
    roleId: row.role_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function organizationRoleExists(ctx: OrgContext, roleId: string) {
  return (eb: ExpressionBuilder<Database, keyof Database>) =>
    eb.exists(
      eb
        .selectFrom('role as target_role')
        .select(sql.lit(1).as('one'))
        .where('target_role.id', '=', roleId)
        .where('target_role.org_id', '=', ctx.orgId)
        .where('target_role.scope', '=', 'organization'),
    );
}

function withExclusion(
  input: ProtectedHolderInput,
  exclude: ProtectedHolderExclusion,
): ProtectedHolderInput {
  return { ...input, exclude: { ...input.exclude, ...exclude } };
}

function anotherHolder(
  ctx: OrgContext,
  input: ProtectedHolderInput,
  exclude: ProtectedHolderExclusion,
): Guard {
  const remaining = withExclusion(input, exclude);
  return existsGuard((database) =>
    database
      .selectFrom('user_account as holder')
      .select(sql.lit(1).as('one'))
      .where('holder.org_id', '=', ctx.orgId)
      .where((eb) => protectedHolder(ctx, eb.ref('holder.id'), remaining)),
  );
}

function organizationGrantExists(ctx: OrgContext, id: string) {
  return db
    .selectFrom('access_grant')
    .select('access_grant.id')
    .where('access_grant.id', '=', id)
    .where('access_grant.org_id', '=', ctx.orgId)
    .where('access_grant.scope', '=', 'organization');
}

export function createGrantRepository(
  executor: ScalarSqlExecutor,
  options: GrantRepositoryOptions,
): ProtectedGrantRepository {
  return {
    async listOrganization(ctx: OrgContext): Promise<OrganizationGrant[]> {
      const rows = await executor.all<GrantRow>(
        scalar(
          db
            .selectFrom('access_grant')
            .select([
              'access_grant.id',
              'access_grant.subject_type',
              'access_grant.subject_value',
              'access_grant.subject_provider',
              'access_grant.role_id',
              'access_grant.created_by',
              'access_grant.created_at',
            ])
            .where('access_grant.org_id', '=', ctx.orgId)
            .where('access_grant.scope', '=', 'organization')
            .orderBy('access_grant.created_at')
            .orderBy('access_grant.id'),
        ),
      );
      return rows.map(toGrant);
    },

    async createOrganization(ctx, input) {
      requireSubject(input.subject);
      const now = timestamp(input.now);
      const subject = input.subject;
      const provider = subject.type === 'group' ? subject.provider : null;
      const createdBy = input.createdBy;
      let source = db
        .selectFrom('role')
        .select((eb) => [
          eb.val(input.id).as('id'),
          eb.val(ctx.orgId).as('org_id'),
          eb.val(subject.type).as('subject_type'),
          eb.val(subject.value).as('subject_value'),
          eb.val(provider).as('subject_provider'),
          eb.val('organization').as('scope'),
          eb.val(null).as('project_id'),
          'role.id as role_id',
          eb.val(createdBy).as('created_by'),
          eb.val(now).as('created_at'),
          eb.val(now).as('updated_at'),
        ])
        .where('role.id', '=', input.roleId)
        .where('role.org_id', '=', ctx.orgId)
        .where('role.scope', '=', 'organization');
      if (createdBy !== null) {
        source = source.where((eb) =>
          eb.exists(
            eb
              .selectFrom('user_account as creator')
              .select(sql.lit(1).as('one'))
              .where('creator.id', '=', createdBy)
              .where('creator.org_id', '=', ctx.orgId),
          ),
        );
      }
      const insert = scalar(
        db
          .insertInto('access_grant')
          .columns([
            'id',
            'org_id',
            'subject_type',
            'subject_value',
            'subject_provider',
            'scope',
            'project_id',
            'role_id',
            'created_by',
            'created_at',
            'updated_at',
          ])
          .expression(source)
          .returning('id'),
      );
      const roleCheck = scalar(
        db
          .selectFrom('role as target_role')
          .select('target_role.id')
          .where('target_role.id', '=', input.roleId)
          .where('target_role.org_id', '=', ctx.orgId)
          .where('target_role.scope', '=', 'organization'),
      );
      try {
        const [inserted, role] = await executor.batch([insert, roleCheck]);
        if ((inserted?.rows.length ?? 0) > 0) return 'created';
        if ((role?.rows.length ?? 0) === 0) return 'role_scope_mismatch';
      } catch (error) {
        if (error instanceof DbError && error.kind === 'unique') return 'duplicate';
        throw error;
      }
      throw new TypeError('createdBy must be a user of the organization');
    },

    async deleteOrganization(ctx, id) {
      const holders = await options.holderInput(ctx);
      const [deleted, remaining] = await executor.batch([
        scalar(
          db
            .deleteFrom('access_grant')
            .where('access_grant.id', '=', id)
            .where('access_grant.org_id', '=', ctx.orgId)
            .where('access_grant.scope', '=', 'organization')
            .where((eb) =>
              eb.or([
                eb.not(
                  eb.exists(
                    eb
                      .selectFrom('role as current_role')
                      .select(sql.lit(1).as('one'))
                      .whereRef('current_role.id', '=', 'access_grant.role_id')
                      .whereRef('current_role.org_id', '=', 'access_grant.org_id')
                      .where('current_role.protects_last_holder', '=', 1),
                  ),
                ),
                anotherHolder(ctx, holders, { grantId: id }),
              ]),
            )
            .returning('id'),
        ),
        scalar(organizationGrantExists(ctx, id)),
      ]);
      if ((deleted?.rows.length ?? 0) > 0) return 'deleted';
      return (remaining?.rows.length ?? 0) > 0 ? 'last_holder' : 'not_found';
    },

    async changeRole(ctx, id, roleId, now) {
      const stamp = timestamp(now);
      const holders = await options.holderInput(ctx);
      const targetRole = organizationRoleExists(ctx, roleId);
      const [updated, state] = await executor.batch([
        scalar(
          db
            .updateTable('access_grant')
            .set({ role_id: roleId, updated_at: stamp })
            .where('access_grant.id', '=', id)
            .where('access_grant.org_id', '=', ctx.orgId)
            .where('access_grant.scope', '=', 'organization')
            .where(targetRole)
            .where((eb) =>
              eb.or([
                eb.not(
                  eb.exists(
                    eb
                      .selectFrom('role as current_role')
                      .select(sql.lit(1).as('one'))
                      .whereRef('current_role.id', '=', 'access_grant.role_id')
                      .whereRef('current_role.org_id', '=', 'access_grant.org_id')
                      .where('current_role.protects_last_holder', '=', 1),
                  ),
                ),
                eb.exists(
                  eb
                    .selectFrom('role as next_role')
                    .select(sql.lit(1).as('one'))
                    .where('next_role.id', '=', roleId)
                    .where('next_role.org_id', '=', ctx.orgId)
                    .where('next_role.protects_last_holder', '=', 1),
                ),
                anotherHolder(ctx, holders, { grantId: id }),
              ]),
            )
            .returning('id'),
        ),
        scalar(organizationGrantExists(ctx, id).select((eb) => targetRole(eb).as('role_ok'))),
      ]);
      if ((updated?.rows.length ?? 0) > 0) return 'updated';
      const row = state?.rows[0] as RoleCheckRow | undefined;
      if (row === undefined) return 'not_found';
      return row.role_ok === 1 ? 'last_holder' : 'role_scope_mismatch';
    },

    async suspendUser(ctx, userId, now) {
      const stamp = timestamp(now);
      const holders = await options.holderInput(ctx);
      const suspended = existsGuard((database) =>
        database
          .selectFrom('user_account')
          .select(sql.lit(1).as('one'))
          .where('user_account.id', '=', userId)
          .where('user_account.org_id', '=', ctx.orgId)
          .where('user_account.status', '=', 'suspended'),
      );
      const [changed, , remaining] = await executor.batch([
        scalar(
          db
            .updateTable('user_account')
            .set({ status: 'suspended', updated_at: stamp })
            .where('user_account.id', '=', userId)
            .where('user_account.org_id', '=', ctx.orgId)
            .where('user_account.status', '=', 'active')
            .where((eb) =>
              eb.or([
                anotherHolder(ctx, holders, { userId }),
                eb.not(protectedHolder(ctx, eb.ref('user_account.id'), holders)),
              ]),
            )
            .returning('id'),
        ),
        revokeAllForUserStatement(ctx, userId, stamp, [suspended]) as ScalarStatement,
        scalar(
          db
            .selectFrom('user_account')
            .select('user_account.status')
            .where('user_account.id', '=', userId)
            .where('user_account.org_id', '=', ctx.orgId),
        ),
      ]);
      if ((changed?.rows.length ?? 0) > 0) return 'suspended';
      const current = remaining?.rows[0] as StatusRow | undefined;
      if (current === undefined) return 'not_found';
      return current.status === 'suspended' ? 'suspended' : 'last_holder';
    },

    async reactivateUser(ctx, userId, now) {
      const rows = await executor.all<IdRow>(
        scalar(
          db
            .updateTable('user_account')
            .set({ status: 'active', updated_at: timestamp(now) })
            .where('user_account.id', '=', userId)
            .where('user_account.org_id', '=', ctx.orgId)
            .where('user_account.status', '=', 'suspended')
            .returning('id'),
        ),
      );
      return rows.length > 0;
    },

    async countProtectedHolders(ctx) {
      const holders = await options.holderInput(ctx);
      const rows = await executor.all<CountRow>(
        scalar(
          db
            .selectFrom('user_account as holder')
            .select((eb) => eb.fn.countAll<number>().as('n'))
            .where('holder.org_id', '=', ctx.orgId)
            .where((eb) => protectedHolder(ctx, eb.ref('holder.id'), holders)),
        ),
      );
      return Number(rows[0]?.n ?? 0);
    },

    async isProtectedHolder(ctx, userId, input) {
      const rows = await executor.all<IdRow>(
        scalar(
          db
            .selectFrom('user_account as holder')
            .select('holder.id')
            .where('holder.org_id', '=', ctx.orgId)
            .where('holder.id', '=', userId)
            .where((eb) => protectedHolder(ctx, eb.ref('holder.id'), input)),
        ),
      );
      return rows.length > 0;
    },

    async countProtectedHoldersFor(ctx, input) {
      const rows = await executor.all<CountRow>(
        scalar(
          db
            .selectFrom('user_account as holder')
            .select((eb) => eb.fn.countAll<number>().as('n'))
            .where('holder.org_id', '=', ctx.orgId)
            .where((eb) => protectedHolder(ctx, eb.ref('holder.id'), input)),
        ),
      );
      return Number(rows[0]?.n ?? 0);
    },
  };
}
