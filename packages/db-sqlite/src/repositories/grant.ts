import { sql, type Compilable, type ExpressionBuilder, type Kysely, type SqlBool } from 'kysely';
import { SESSION_IDLE_MS } from '@package-broker/core/auth/session';
import type { FailureProbes, MutationFence } from '@package-broker/core/authz/fence';
import type {
  GrantRepository,
  GrantSubject,
  OrganizationGrant,
} from '@package-broker/core/db/grants';
import type { OrgContext, ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import { DbError } from '@package-broker/core/db/errors';
import { normalizeEmail } from '@package-broker/core/identity/policy';
import { isValidProviderId } from '@package-broker/core/identity/port';
import {
  assertCheck,
  assertGuard,
  compile,
  db,
  existsGuard,
  databaseTimeMs,
  protectedHolder,
  runOrgFenced,
  type Database,
  type Guard,
  type ProtectedHolderExclusion,
  type ProtectedHolderInput,
  type ProtectedHolderProvider,
} from '../kysely.js';
import { holdsPermission, permissionRows } from './access.js';
import { revokeAllForUserStatement } from './session.js';
import { liveSessionCondition } from './session-liveness.js';

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
  readonly revision: number;
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
  readonly providerAnchors: readonly ProtectedHolderProvider[];
  readonly holderInput: (ctx: OrgContext) => ProtectedHolderInput | Promise<ProtectedHolderInput>;
}

export interface ProtectedGrantRepository extends GrantRepository {
  isProtectedHolder(
    ctx: OrgContext,
    userId: string,
    input?: ProtectedHolderInput,
  ): Promise<boolean>;
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
    revision: row.revision,
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

type LooseDatabase = Record<string, Record<string, unknown>>;

const loose = db as unknown as Kysely<LooseDatabase>;

function requireNonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function expectedRevision(fence: MutationFence): number {
  const expected = fence.expected['grant'];
  if (expected === undefined) throw new TypeError('fence must carry an expected grant revision');
  return expected;
}

interface GrantAuthority {
  /** Acting user, live session and `org:grants:write`; the head of the fenced batch. */
  readonly live: Guard;
  /** Admin-only protected roles and, where wanted, the permission subset. */
  readonly reach: Guard;
}

interface ReachScope {
  readonly roleId?: string;
  readonly grantId?: string;
  readonly subset: boolean;
}

interface ActorEvidence {
  readonly isAdmin: Guard;
  readonly livePermissions: Compilable;
  readonly live: (permission: string) => Guard;
}

function actorEvidence(
  ctx: OrgContext,
  fence: MutationFence,
  providers: readonly ProtectedHolderProvider[],
): ActorEvidence {
  const org = ctx.orgId;
  const localAdmin = sql<SqlBool>`exists ${loose
    .selectFrom('session as la_session')
    .select(sql.lit(1).as('one'))
    .where('la_session.org_id', '=', org)
    .where('la_session.id', '=', fence.sessionId)
    .where('la_session.revoked_at', 'is', null)
    .where('la_session.identity_id', 'is', null)}`;
  const rows = () =>
    loose.selectFrom(
      permissionRows(ctx, fence.userId, null, providers, { localAdmin }).as('lr') as never,
    );
  return {
    isAdmin: sql<SqlBool>`exists ${rows()
      .select(sql.lit(1).as('one'))
      .where(sql<SqlBool>`lr.protects = 1`)}`,
    livePermissions: rows().select(sql<string>`lr.permission`.as('permission')),
    live: (permission) => sql<SqlBool>`(
    exists (
      select 1 from user_account au
      join session s on s.org_id = au.org_id and s.user_id = au.id
      where au.org_id = ${org} and au.id = ${fence.userId} and au.status = 'active'
        and s.id = ${fence.sessionId}
        and ${liveSessionCondition('s', SESSION_IDLE_MS / 1000)})
    and ${holdsPermission(ctx, {
      userId: fence.userId,
      permission,
      projectId: null,
      providerAnchors: providers,
      projectState: 'any',
      session: fence.sessionId,
    })})`,
  };
}

function grantAuthority(
  ctx: OrgContext,
  fence: MutationFence,
  providers: readonly ProtectedHolderProvider[],
  scope: ReachScope,
): GrantAuthority {
  const org = ctx.orgId;
  const { isAdmin, livePermissions, live } = actorEvidence(ctx, fence, providers);
  const grantRole = sql`(select g.role_id from access_grant g where g.org_id = ${org} and g.id = ${scope.grantId ?? null})`;
  const involved = sql`(${sql.join(
    [
      ...(scope.roleId === undefined ? [] : [sql`r.id = ${scope.roleId}`]),
      ...(scope.grantId === undefined ? [] : [sql`r.id = ${grantRole}`]),
    ],
    sql` or `,
  )})`;
  const touchesProtected = sql<SqlBool>`exists (
    select 1 from role r where r.org_id = ${org} and r.protects_last_holder = 1 and ${involved})`;
  const wanted = sql`select rp.permission from role_permission rp where rp.org_id = ${org} and ${sql`(${sql.join(
    [
      ...(scope.roleId === undefined ? [] : [sql`rp.role_id = ${scope.roleId}`]),
      ...(scope.grantId === undefined || !scope.subset ? [] : [sql`rp.role_id = ${grantRole}`]),
    ],
    sql` or `,
  )})`}`;
  const withinActor = scope.subset
    ? sql<SqlBool>`not exists (select 1 from (${wanted}) wanted where wanted.permission not in ${livePermissions})`
    : sql<SqlBool>`1`;
  return {
    live: live('org:grants:write'),
    reach: sql<SqlBool>`(${isAdmin} or (not ${touchesProtected} and ${withinActor}))`,
  };
}

function probe(condition: Guard): ScalarStatement {
  return scalar(db.selectNoFrom(sql<number>`${condition}`.as('holds')));
}

function probesFor(
  authority: GrantAuthority,
  collision: readonly Guard[],
  revision?: { readonly ctx: OrgContext; readonly id: string; readonly expected: number },
): FailureProbes {
  return {
    authority: probe(sql<SqlBool>`(${authority.live} and ${authority.reach}) is not 1`),
    ...(revision === undefined
      ? {}
      : {
          conflict: probe(
            sql<SqlBool>`exists (select 1 from access_grant where org_id = ${revision.ctx.orgId} and id = ${revision.id} and scope = 'organization' and revision <> ${revision.expected})`,
          ),
        }),
    collision: probe(sql<SqlBool>`(${sql.join(collision, sql` and `)}) is not 1`),
  };
}

type RefusedBy = 'authority' | 'conflict' | 'indeterminate' | 'collision';

function refusedBy(outcome: { readonly reason: string }, label: string): RefusedBy {
  if (
    outcome.reason === 'authority' ||
    outcome.reason === 'conflict' ||
    outcome.reason === 'indeterminate' ||
    outcome.reason === 'collision'
  ) {
    return outcome.reason;
  }
  throw new Error(`${label} failed unclassified (${outcome.reason})`);
}

function grantRevisionHolds(ctx: OrgContext, id: string, expected: number): Guard {
  return sql<SqlBool>`exists (select 1 from access_grant where org_id = ${ctx.orgId} and id = ${id} and scope = 'organization' and revision = ${expected})`;
}

function targetRoleHolds(ctx: OrgContext, roleId: string): Guard {
  return sql<SqlBool>`exists (select 1 from role where org_id = ${ctx.orgId} and id = ${roleId} and scope = 'organization')`;
}

function grantOnProtectedRole(ctx: OrgContext, id: string): Guard {
  return existsGuard((database) =>
    database
      .selectFrom('access_grant as pg')
      .innerJoin('role as current_role', (join) =>
        join
          .onRef('current_role.id', '=', 'pg.role_id')
          .onRef('current_role.org_id', '=', 'pg.org_id'),
      )
      .select(sql.lit(1).as('one'))
      .where('pg.id', '=', id)
      .where('pg.org_id', '=', ctx.orgId)
      .where('pg.scope', '=', 'organization')
      .where('current_role.protects_last_holder', '=', 1),
  );
}

function roleProtects(ctx: OrgContext, roleId: string): Guard {
  return existsGuard((database) =>
    database
      .selectFrom('role as next_role')
      .select(sql.lit(1).as('one'))
      .where('next_role.id', '=', roleId)
      .where('next_role.org_id', '=', ctx.orgId)
      .where('next_role.protects_last_holder', '=', 1),
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

function userHasStatus(ctx: OrgContext, userId: string, status: 'active' | 'suspended'): Guard {
  return existsGuard((database) =>
    database
      .selectFrom('user_account')
      .select(sql.lit(1).as('one'))
      .where('user_account.id', '=', userId)
      .where('user_account.org_id', '=', ctx.orgId)
      .where('user_account.status', '=', status),
  );
}

function holdsProtectedRole(
  ctx: OrgContext,
  userId: string,
  input: ProtectedHolderInput,
  options: { readonly includeSuspended?: boolean } = {},
): Guard {
  return existsGuard((database) =>
    database
      .selectFrom('user_account as target')
      .select(sql.lit(1).as('one'))
      .where('target.id', '=', userId)
      .where('target.org_id', '=', ctx.orgId)
      .where((eb) => protectedHolder(ctx, eb.ref('target.id'), input, options)),
  );
}

async function statusOfUser(
  executor: ScalarSqlExecutor,
  ctx: OrgContext,
  userId: string,
): Promise<string | undefined> {
  const found = await executor.all<StatusRow>(
    scalar(
      db
        .selectFrom('user_account')
        .select('user_account.status')
        .where('user_account.id', '=', userId)
        .where('user_account.org_id', '=', ctx.orgId),
    ),
  );
  return found[0]?.status;
}

function observingErrors(executor: ScalarSqlExecutor) {
  let last: DbError | undefined;
  const observed: ScalarSqlExecutor = {
    driver: executor.driver,
    all: (statement) => executor.all(statement),
    batch: async (statements) => {
      try {
        return await executor.batch(statements);
      } catch (error) {
        if (error instanceof DbError) last = error;
        throw error;
      }
    },
  };
  return { observed, failure: () => last };
}

function statusRefusal(
  outcome: { readonly reason: string },
  label: string,
  failure: DbError | undefined,
): RefusedBy {
  if (outcome.reason !== 'unclassified') return refusedBy(outcome, label);
  if (failure?.kind === 'too_big') throw failure;
  return 'conflict';
}

export function createGrantRepository(
  executor: ScalarSqlExecutor,
  options: GrantRepositoryOptions,
): ProtectedGrantRepository {
  if (!Array.isArray(options?.providerAnchors)) {
    throw new TypeError('providerAnchors must be supplied explicitly');
  }
  const providers = options.providerAnchors;
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
              'access_grant.revision',
            ])
            .where('access_grant.org_id', '=', ctx.orgId)
            .where('access_grant.scope', '=', 'organization')
            .orderBy('access_grant.created_at')
            .orderBy('access_grant.id'),
        ),
      );
      return rows.map(toGrant);
    },

    async createOrganization(ctx, fence, input) {
      requireSubject(input.subject);
      const now = timestamp(input.now);
      requireNonEmpty(input.opId, 'opId');
      const subject = input.subject;
      const provider = subject.type === 'group' ? subject.provider : null;
      const createdBy = input.createdBy;
      const source = db
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
          eb.val(input.opId).as('last_op_id'),
        ])
        .where('role.id', '=', input.roleId)
        .where('role.org_id', '=', ctx.orgId)
        .where('role.scope', '=', 'organization');
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
            'last_op_id',
          ])
          .expression(source)
          .returning('id'),
      );

      const holders = await options.holderInput(ctx);
      const authority = grantAuthority(
        ctx,
        fence,
        holders.kind === 'local_recovery' ? [] : providers,
        {
          roleId: input.roleId,
          subset: true,
        },
      );
      const roleHolds = targetRoleHolds(ctx, input.roleId);
      const creatorHolds =
        createdBy === null
          ? sql<SqlBool>`1`
          : sql<SqlBool>`exists (select 1 from user_account where org_id = ${ctx.orgId} and id = ${createdBy})`;
      const unused = sql<SqlBool>`(not exists (select 1 from access_grant where id = ${input.id})
        and not exists (
          select 1 from access_grant where org_id = ${ctx.orgId} and scope = 'organization'
            and subject_type = ${subject.type} and subject_value = ${subject.value}
            and coalesce(subject_provider, '') = ${provider ?? ''}))`;
      const outcome = await runOrgFenced(
        executor,
        ctx,
        fence,
        assertGuard(authority.live, ctx),
        [
          ...assertCheck(authority.reach),
          ...assertCheck(roleHolds),
          ...assertCheck(creatorHolds),
          ...assertCheck(unused),
          insert,
        ],
        probesFor(authority, [roleHolds, creatorHolds, unused]),
      );
      if (!outcome.ok) {
        const reason = refusedBy(outcome, 'grant create');
        if (reason === 'conflict') throw new Error('grant create has no revision to conflict with');
        if (reason !== 'collision') return reason;
        const found = await executor.all<{ role_ok: number; creator_ok: number }>(
          scalar(
            db.selectNoFrom([
              sql<number>`${roleHolds}`.as('role_ok'),
              sql<number>`${creatorHolds}`.as('creator_ok'),
            ]),
          ),
        );
        if (found[0]?.role_ok !== 1) return 'role_scope_mismatch';
        if (found[0]?.creator_ok !== 1) {
          throw new TypeError('createdBy must be a user of the organization');
        }
        return 'duplicate';
      }
      const inserted = outcome.results[outcome.results.length - 1];
      if ((inserted?.rows.length ?? 0) > 0) return 'created';
      throw new Error('grant create inserted no row after its guards held');
    },

    async deleteOrganization(ctx, fence, id, opId) {
      requireNonEmpty(id, 'id');
      requireNonEmpty(opId, 'opId');
      const expected = expectedRevision(fence);
      const holders = await options.holderInput(ctx);
      const authority = grantAuthority(
        ctx,
        fence,
        holders.kind === 'local_recovery' ? [] : providers,
        {
          grantId: id,
          subset: false,
        },
      );
      const revision = grantRevisionHolds(ctx, id, expected);
      const lastHolder = sql<SqlBool>`(not ${grantOnProtectedRole(ctx, id)} or ${anotherHolder(ctx, holders, { grantId: id })})`;
      const offboarded = scalar(
        db.selectNoFrom(
          sql<string | null>`(
            select subject.id from user_account as subject
            join access_grant as removed on removed.org_id = subject.org_id
              and removed.subject_type = 'email' and removed.subject_value = subject.email
            where removed.id = ${id} and removed.org_id = ${ctx.orgId}
              and removed.scope = 'organization' and removed.revision = ${expected}
              and not exists (
                select 1 from access_grant as remaining
                where remaining.org_id = subject.org_id and remaining.id <> removed.id
                  and remaining.scope = 'organization'
                  and (
                    (remaining.subject_type = 'email' and remaining.subject_value = subject.email)
                    or (remaining.subject_type = 'group' and exists (
                      select 1 from user_group as membership
                      where membership.org_id = subject.org_id and membership.user_id = subject.id
                        and membership.provider = remaining.subject_provider
                        and membership.group_name = remaining.subject_value
                    ))
                  )
              )
          )`.as('offboarded_user_id'),
        ),
      );
      const outcome = await runOrgFenced(
        executor,
        ctx,
        fence,
        assertGuard(authority.live, ctx),
        [
          ...assertCheck(authority.reach),
          ...assertCheck(revision),
          ...assertCheck(lastHolder),
          offboarded,
          scalar(
            db
              .deleteFrom('access_grant')
              .where('access_grant.id', '=', id)
              .where('access_grant.org_id', '=', ctx.orgId)
              .where('access_grant.scope', '=', 'organization')
              .where('access_grant.revision', '=', expected)
              .returning('id'),
          ),
        ],
        probesFor(authority, [revision, lastHolder], { ctx, id, expected }),
      );
      if (outcome.ok) {
        const deleted = outcome.results[outcome.results.length - 1];
        if ((deleted?.rows.length ?? 0) === 0) {
          throw new Error('grant delete matched no row after its guards held');
        }
        const row = outcome.results.at(-2)?.rows[0] as
          { offboarded_user_id: string | null } | undefined;
        return { outcome: 'deleted', offboardedUserId: row?.offboarded_user_id ?? null };
      }
      const reason = refusedBy(outcome, 'grant delete');
      if (reason !== 'collision') return reason;
      const remaining = await executor.all<IdRow>(scalar(organizationGrantExists(ctx, id)));
      return remaining.length > 0 ? 'last_holder' : 'not_found';
    },

    async changeRole(ctx, fence, id, roleId, now, opId) {
      const stamp = timestamp(now);
      requireNonEmpty(id, 'id');
      requireNonEmpty(roleId, 'roleId');
      requireNonEmpty(opId, 'opId');
      const expected = expectedRevision(fence);
      const holders = await options.holderInput(ctx);
      const authority = grantAuthority(
        ctx,
        fence,
        holders.kind === 'local_recovery' ? [] : providers,
        {
          grantId: id,
          roleId,
          subset: true,
        },
      );
      const revision = grantRevisionHolds(ctx, id, expected);
      const roleHolds = targetRoleHolds(ctx, roleId);
      const lastHolder = sql<SqlBool>`(not ${grantOnProtectedRole(ctx, id)} or ${roleProtects(ctx, roleId)} or ${anotherHolder(ctx, holders, { grantId: id })})`;
      const outcome = await runOrgFenced(
        executor,
        ctx,
        fence,
        assertGuard(authority.live, ctx),
        [
          ...assertCheck(authority.reach),
          ...assertCheck(revision),
          ...assertCheck(roleHolds),
          ...assertCheck(lastHolder),
          scalar(
            db
              .updateTable('access_grant')
              .set({
                role_id: roleId,
                updated_at: stamp,
                revision: sql`revision + 1`,
                last_op_id: opId,
              })
              .where('access_grant.id', '=', id)
              .where('access_grant.org_id', '=', ctx.orgId)
              .where('access_grant.scope', '=', 'organization')
              .where('access_grant.revision', '=', expected)
              .returning('id'),
          ),
        ],
        probesFor(authority, [revision, roleHolds, lastHolder], { ctx, id, expected }),
      );
      if (outcome.ok) {
        const updated = outcome.results[outcome.results.length - 1];
        if ((updated?.rows.length ?? 0) > 0) return 'updated';
        throw new Error('grant change matched no row after its guards held');
      }
      const reason = refusedBy(outcome, 'grant change');
      if (reason !== 'collision') return reason;
      const rows = await executor.all<RoleCheckRow>(
        scalar(
          organizationGrantExists(ctx, id).select((eb) =>
            organizationRoleExists(ctx, roleId)(eb).as('role_ok'),
          ),
        ),
      );
      const row = rows[0];
      if (row === undefined) return 'not_found';
      return row.role_ok === 1 ? 'last_holder' : 'role_scope_mismatch';
    },

    async suspendUser(ctx, fence, userId, now) {
      const stamp = timestamp(now);
      requireNonEmpty(userId, 'userId');
      const holders = await options.holderInput(ctx);
      const evidence = actorEvidence(
        ctx,
        fence,
        holders.kind === 'local_recovery' ? [] : providers,
      );
      const live = evidence.live('org:users:write');
      const targetHolds = holdsProtectedRole(ctx, userId, holders);
      const reach = sql<SqlBool>`(${evidence.isAdmin} or not ${targetHolds})`;
      const active = userHasStatus(ctx, userId, 'active');
      const lastHolder = sql<SqlBool>`(not ${targetHolds} or ${anotherHolder(ctx, holders, { userId })})`;
      const guard = assertGuard(live, ctx);
      const { observed, failure } = observingErrors(executor);
      const checks = [...assertCheck(reach), ...assertCheck(active)];
      const update = scalar(
        db
          .updateTable('user_account')
          .set({ status: 'suspended', updated_at: stamp })
          .where('user_account.id', '=', userId)
          .where('user_account.org_id', '=', ctx.orgId)
          .where('user_account.status', '=', 'active')
          .where(lastHolder)
          .returning('id'),
      );
      const updateAt = guard.length + checks.length;
      const outcome = await runOrgFenced(
        observed,
        ctx,
        fence,
        guard,
        [
          ...checks,
          update,
          ...assertCheck(sql<SqlBool>`changes() = 1`),
          revokeAllForUserStatement(ctx, userId, stamp, [userHasStatus(ctx, userId, 'suspended')]),
        ],
        {
          authority: probe(sql<SqlBool>`(${live} and ${reach}) is not 1`),
          collision: probe(sql<SqlBool>`(${active} and ${lastHolder}) is not 1`),
        },
      );
      if (outcome.ok) {
        if ((outcome.results[updateAt]?.rows.length ?? 0) > 0) return 'suspended';
        throw new Error('user suspension matched no row after its guards held');
      }
      const reason = statusRefusal(outcome, 'user suspension', failure());
      if (reason !== 'collision') return reason;
      const current = await statusOfUser(executor, ctx, userId);
      if (current === undefined) return 'not_found';
      return current === 'suspended' ? 'unchanged' : 'last_holder';
    },

    async reactivateUser(ctx, fence, userId, now) {
      const stamp = timestamp(now);
      requireNonEmpty(userId, 'userId');
      const holders = await options.holderInput(ctx);
      const evidence = actorEvidence(
        ctx,
        fence,
        holders.kind === 'local_recovery' ? [] : providers,
      );
      const live = evidence.live('org:users:write');
      const wouldHold = holdsProtectedRole(ctx, userId, holders, { includeSuspended: true });
      const reach = sql<SqlBool>`(${evidence.isAdmin} or not ${wouldHold})`;
      const suspended = userHasStatus(ctx, userId, 'suspended');
      const guard = assertGuard(live, ctx);
      const { observed, failure } = observingErrors(executor);
      const checks = [...assertCheck(reach), ...assertCheck(suspended)];
      const updateAt = guard.length + checks.length;
      const outcome = await runOrgFenced(
        observed,
        ctx,
        fence,
        guard,
        [
          ...checks,
          scalar(
            db
              .updateTable('user_account')
              .set({ status: 'active', updated_at: stamp })
              .where('user_account.id', '=', userId)
              .where('user_account.org_id', '=', ctx.orgId)
              .where('user_account.status', '=', 'suspended')
              .returning('id'),
          ),
        ],
        {
          authority: probe(sql<SqlBool>`(${live} and ${reach}) is not 1`),
          collision: probe(sql<SqlBool>`${suspended} is not 1`),
        },
      );
      if (outcome.ok) {
        if ((outcome.results[updateAt]?.rows.length ?? 0) > 0) return 'reactivated';
        throw new Error('user reactivation matched no row after its guards held');
      }
      const reason = statusRefusal(outcome, 'user reactivation', failure());
      if (reason !== 'collision') return reason;
      const current = await statusOfUser(executor, ctx, userId);
      if (current === undefined) return 'not_found';
      return current === 'active' ? 'unchanged' : 'conflict';
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
      const holder = protectedHolder(
        ctx,
        sql.ref('holder.id'),
        input ?? {
          kind: 'fresh',
          now: '1970-01-01T00:00:00.000Z',
          providers,
        },
        input === undefined ? { now: databaseTimeMs } : {},
      );
      const rows = await executor.all<IdRow>(
        scalar(
          db
            .selectFrom('user_account as holder')
            .select('holder.id')
            .where('holder.org_id', '=', ctx.orgId)
            .where('holder.id', '=', userId)
            .where(holder),
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
