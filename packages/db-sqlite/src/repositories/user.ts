import { sql, type Compilable } from 'kysely';
import type { OrgContext, ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import type {
  LoginLookup,
  StoredIdentity,
  User,
  UserRepository,
} from '@package-broker/core/db/users';
import { compile, db } from '../kysely.js';

const MAX_LIST_LIMIT = 200;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

type Status = 'active' | 'suspended';

interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly display_name: string | null;
  readonly status: Status;
  readonly last_login_at: string | null;
  readonly created_at: string;
}

interface IdentityRow {
  readonly id: string;
  readonly user_id: string;
  readonly provider: string;
  readonly subject: string;
  readonly email: string;
  readonly validated_at: string | null;
}

interface LoginRow {
  readonly bound_anchor: string | null;
  readonly identity_id: string | null;
  readonly identity_user_id: string | null;
  readonly identity_provider: string | null;
  readonly identity_subject: string | null;
  readonly identity_email: string | null;
  readonly identity_validated_at: string | null;
  readonly identity_account_id: string | null;
  readonly identity_account_email: string | null;
  readonly identity_account_status: Status | null;
  readonly email_account_id: string | null;
  readonly email_account_status: Status | null;
  readonly email_account_linked: number;
  readonly invited: number;
}

function run<R>(executor: ScalarSqlExecutor, query: Compilable): Promise<R[]> {
  return executor.all<R>(compile(query) as ScalarStatement);
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    status: row.status,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
  };
}

function toIdentity(row: IdentityRow): StoredIdentity {
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    subject: row.subject,
    email: row.email,
    validatedAt: row.validated_at,
  };
}

function requireLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new RangeError(`limit must be an integer from 1 to ${MAX_LIST_LIMIT}`);
  }
  return limit;
}

function groupsJson(groups: readonly string[]): string {
  for (const group of groups) {
    if (typeof group !== 'string' || LONE_SURROGATE.test(group)) {
      throw new TypeError('every group must be a well-formed string');
    }
  }
  return JSON.stringify(groups);
}

function userQuery(ctx: OrgContext) {
  return db
    .selectFrom('user_account')
    .select([
      'user_account.id',
      'user_account.email',
      'user_account.display_name',
      'user_account.status',
      'user_account.last_login_at',
      'user_account.created_at',
    ])
    .where('user_account.org_id', '=', ctx.orgId);
}

function loginQuery(
  ctx: OrgContext,
  input: {
    readonly provider: string;
    readonly subject: string;
    readonly email: string;
    readonly groups: readonly string[];
  },
) {
  if (/[A-Z]/.test(input.email)) {
    throw new TypeError('email must be normalized to lower case');
  }
  const groups = groupsJson(input.groups);

  return db
    .selectFrom(db.selectNoFrom(sql.lit(1).as('one')).as('base'))
    .leftJoin('identity', (join) =>
      join
        .on('identity.org_id', '=', ctx.orgId)
        .on('identity.provider', '=', input.provider)
        .on('identity.subject', '=', input.subject),
    )
    .leftJoin('user_account as identity_account', (join) =>
      join
        .onRef('identity_account.id', '=', 'identity.user_id')
        .on('identity_account.org_id', '=', ctx.orgId),
    )
    .leftJoin('user_account as email_account', (join) =>
      join.on('email_account.org_id', '=', ctx.orgId).on('email_account.email', '=', input.email),
    )
    .select((eb) => [
      eb
        .selectFrom('identity_provider_binding')
        .select('identity_provider_binding.anchor')
        .where('identity_provider_binding.org_id', '=', ctx.orgId)
        .where('identity_provider_binding.provider', '=', input.provider)
        .as('bound_anchor'),
      'identity.id as identity_id',
      'identity.user_id as identity_user_id',
      'identity.provider as identity_provider',
      'identity.subject as identity_subject',
      'identity.email as identity_email',
      'identity.validated_at as identity_validated_at',
      'identity_account.id as identity_account_id',
      'identity_account.email as identity_account_email',
      'identity_account.status as identity_account_status',
      'email_account.id as email_account_id',
      'email_account.status as email_account_status',
      eb
        .exists(
          eb
            .selectFrom('identity as linked_identity')
            .select(sql.lit(1).as('one'))
            .where('linked_identity.org_id', '=', ctx.orgId)
            .where('linked_identity.provider', '=', input.provider)
            .whereRef('linked_identity.user_id', '=', 'email_account.id'),
        )
        .as('email_account_linked'),
      eb
        .exists(
          eb
            .selectFrom('access_grant as email_grant')
            .leftJoin('project as email_project', (join) =>
              join
                .onRef('email_project.id', '=', 'email_grant.project_id')
                .on('email_project.org_id', '=', ctx.orgId),
            )
            .select(sql.lit(1).as('one'))
            .where('email_grant.org_id', '=', ctx.orgId)
            .where('email_grant.subject_type', '=', 'email')
            .where('email_grant.subject_provider', 'is', null)
            .where(
              sql<string>`coalesce(email_project.status, iif(email_grant.project_id is null, 'active', 'unavailable'))`,
              '=',
              'active',
            )
            .where('email_grant.subject_value', '=', input.email)
            .unionAll(
              eb
                .selectFrom('access_grant as group_grant')
                .leftJoin('project as group_project', (join) =>
                  join
                    .onRef('group_project.id', '=', 'group_grant.project_id')
                    .on('group_project.org_id', '=', ctx.orgId),
                )
                .select(sql.lit(1).as('one'))
                .where(
                  sql<string>`coalesce(group_project.status, iif(group_grant.project_id is null, 'active', 'unavailable'))`,
                  '=',
                  'active',
                )
                .where('group_grant.org_id', '=', ctx.orgId)
                .where('group_grant.subject_type', '=', 'group')
                .where('group_grant.subject_provider', '=', input.provider)
                .where(
                  'group_grant.subject_value',
                  'in',
                  sql<string>`(select value from json_each(${groups}))`,
                ),
            ),
        )
        .as('invited'),
    ]);
}

function toLookup(row: LoginRow | undefined): LoginLookup {
  if (row === undefined) {
    throw new Error('login lookup returned no row');
  }
  const identity =
    row.identity_id === null || row.identity_account_id === null
      ? null
      : toIdentity({
          id: row.identity_id,
          user_id: row.identity_user_id as string,
          provider: row.identity_provider as string,
          subject: row.identity_subject as string,
          email: row.identity_email as string,
          validated_at: row.identity_validated_at,
        });
  return {
    boundAnchor: row.bound_anchor,
    identity,
    identityUser:
      row.identity_account_id === null
        ? null
        : {
            id: row.identity_account_id,
            email: row.identity_account_email as string,
            status: row.identity_account_status as Status,
          },
    userByEmail:
      row.email_account_id === null
        ? null
        : {
            id: row.email_account_id,
            status: row.email_account_status as Status,
            linkedAtProvider: row.email_account_linked === 1,
          },
    invited: row.invited === 1,
  };
}

export function createUserRepository(executor: ScalarSqlExecutor): UserRepository {
  return {
    async lookupForLogin(ctx, input) {
      const rows = await run<LoginRow>(executor, loginQuery(ctx, input));
      return toLookup(rows[0]);
    },

    async getIdentity(ctx, id) {
      const rows = await run<IdentityRow>(
        executor,
        db
          .selectFrom('identity')
          .select([
            'identity.id',
            'identity.user_id',
            'identity.provider',
            'identity.subject',
            'identity.email',
            'identity.validated_at',
          ])
          .where('identity.org_id', '=', ctx.orgId)
          .where('identity.id', '=', id),
      );
      const row = rows[0];
      return row === undefined ? null : toIdentity(row);
    },

    async get(ctx, id) {
      const rows = await run<UserRow>(executor, userQuery(ctx).where('user_account.id', '=', id));
      const row = rows[0];
      return row === undefined ? null : toUser(row);
    },

    async list(ctx, page) {
      const limit = requireLimit(page.limit);
      let query = userQuery(ctx);
      if (page.afterId !== null) {
        query = query.where('user_account.id', '>', page.afterId);
      }
      const rows = await run<UserRow>(
        executor,
        query.orderBy('user_account.id', 'asc').limit(limit),
      );
      return rows.map(toUser);
    },
  };
}
