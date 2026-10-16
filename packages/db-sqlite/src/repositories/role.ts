import { sql, type Compilable, type ExpressionBuilder, type Kysely, type SqlBool } from 'kysely';
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from '@package-broker/core/auth/session';
import type { FailureProbes, MutationFence } from '@package-broker/core/authz/fence';
import {
  DEFAULT_ROLES,
  isPermission,
  type DefaultRoleKey,
} from '@package-broker/core/authz/permissions';
import type {
  OrgContext,
  ScalarSqlExecutor,
  ScalarStatement,
  Statement,
} from '@package-broker/core/db/port';
import {
  ROLE_KEY_PATTERN,
  ROLE_NAME_MAX_LENGTH,
  type Role,
  type RoleRepository,
} from '@package-broker/core/db/roles';
import {
  assertCheck,
  assertGuard,
  compile,
  db,
  runOrgFenced,
  type Database,
  type Guard,
} from '../kysely.js';
import { holdsPermission, permissionRows, type ProtectedHolderProvider } from './access.js';

interface RoleRow {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly scope: string;
  readonly is_system: number;
  readonly protects_last_holder: number;
  readonly revision: number;
  readonly permission: string | null;
}

function scalar(query: Compilable): ScalarStatement {
  return compile(query) as ScalarStatement;
}

function run<R>(executor: ScalarSqlExecutor, query: Compilable): Promise<R[]> {
  return executor.all<R>(scalar(query));
}

const FORBIDDEN_NAME_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;
const DEFAULT_KEYS: ReadonlySet<string> = new Set(DEFAULT_ROLES.map(({ key }) => key));

function requireName(name: string): void {
  const length = [...name].length;
  if (length < 1 || length > ROLE_NAME_MAX_LENGTH || FORBIDDEN_NAME_CHARACTERS.test(name)) {
    throw new TypeError(`role name must be 1 to ${ROLE_NAME_MAX_LENGTH} printable characters`);
  }
}

function acceptable(scope: Role['scope'], permissions: readonly string[]): boolean {
  return permissions.every(
    (name) => isPermission(name) && (scope === 'organization' || !name.startsWith('org:')),
  );
}

function insertRole(
  ctx: OrgContext,
  row: {
    readonly id: string;
    readonly key: string;
    readonly name: string;
    readonly scope: 'organization' | 'project';
    readonly isSystem: boolean;
    readonly protectsLastHolder: boolean;
    readonly now: string;
    readonly opId?: string;
  },
  target: 'key' | 'any',
) {
  return db
    .insertInto('role')
    .values({
      id: row.id,
      org_id: ctx.orgId,
      key: row.key,
      name: row.name,
      scope: row.scope,
      is_system: row.isSystem ? 1 : 0,
      protects_last_holder: row.protectsLastHolder ? 1 : 0,
      created_at: row.now,
      updated_at: row.now,
      ...(row.opId === undefined ? {} : { last_op_id: row.opId }),
    })
    .onConflict((conflict) =>
      target === 'key' ? conflict.columns(['org_id', 'key']).doNothing() : conflict.doNothing(),
    );
}

const DB_TIME = sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

function dbTimeAgo(ms: number) {
  return sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ${`-${ms / 1000} seconds`})`;
}

type LooseDatabase = Record<string, Record<string, unknown>>;

const loose = db as unknown as Kysely<LooseDatabase>;

export interface RoleRepositoryOptions {
  /** Trust anchors the actor's e-mail and group evidence is checked against; none means local administrators only. */
  readonly providerAnchors?: readonly ProtectedHolderProvider[];
}

interface AuthorityScope {
  readonly oldRoleId?: string;
  readonly requested?: readonly string[];
}

function actorAuthority(
  ctx: OrgContext,
  fence: MutationFence,
  providers: readonly ProtectedHolderProvider[],
  scope: AuthorityScope,
): Guard {
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
  const livePermissions = () => rows().select(sql<string>`lr.permission`.as('permission'));
  const isAdmin = sql<SqlBool>`exists ${rows()
    .select(sql.lit(1).as('one'))
    .where(sql<SqlBool>`lr.protects = 1`)}`;
  const within = (wanted: ReturnType<typeof sql>) =>
    sql<SqlBool>`(${isAdmin} or not exists (
      select 1 from (${wanted}) wanted where wanted.permission not in ${livePermissions()}))`;

  const roleWrite = holdsPermission(ctx, {
    userId: fence.userId,
    permission: 'org:roles:write',
    projectId: null,
    providerAnchors: providers,
    projectState: 'any',
    session: fence.sessionId,
  });
  const requested = within(
    sql`select j.value as permission from json_each(${JSON.stringify(scope.requested ?? [])}) j`,
  );
  const old = within(
    sql`select op.permission from role_permission op
        where op.org_id = ${org} and op.role_id = ${scope.oldRoleId ?? null}`,
  );
  return sql<SqlBool>`(
    exists (
      select 1 from user_account au
      join session s on s.org_id = au.org_id and s.user_id = au.id
      where au.org_id = ${org} and au.id = ${fence.userId} and au.status = 'active'
        and s.id = ${fence.sessionId} and s.revoked_at is null
        and s.expires_at > ${DB_TIME}
        and s.created_at > ${dbTimeAgo(SESSION_ABSOLUTE_MS)}
        and coalesce(s.last_seen_at, s.created_at) > ${dbTimeAgo(SESSION_IDLE_MS)})
    and ${roleWrite} and ${old} and ${requested})`;
}

function expectedRevision(fence: MutationFence): number {
  const expected = fence.expected['role'];
  if (expected === undefined) throw new TypeError('fence must carry an expected role revision');
  return expected;
}

function requireNonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function revisionHolds(ctx: OrgContext, id: string, expected: number): Guard {
  return sql<SqlBool>`exists (select 1 from role where org_id = ${ctx.orgId} and id = ${id} and revision = ${expected})`;
}

function allHold(conditions: readonly Guard[]): Guard {
  return sql<SqlBool>`(${sql.join(conditions, sql` and `)})`;
}

function probesFor(
  ctx: OrgContext,
  authority: Guard,
  conditions: readonly Guard[],
  revision?: { readonly id: string; readonly expected: number },
): FailureProbes {
  const probe = (condition: Guard) =>
    scalar(db.selectNoFrom(sql<number>`${condition}`.as('holds')));
  return {
    authority: probe(sql<SqlBool>`${authority} is not 1`),
    ...(revision === undefined
      ? {}
      : {
          conflict: probe(
            sql<SqlBool>`exists (select 1 from role where org_id = ${ctx.orgId} and id = ${revision.id} and revision <> ${revision.expected})`,
          ),
        }),
    collision: probe(sql<SqlBool>`${allHold(conditions)} is not 1`),
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

function roleBump(ctx: OrgContext, id: string, stamp: string, opId: string) {
  return db
    .updateTable('role')
    .set({ revision: sql`revision + 1`, updated_at: stamp, last_op_id: opId })
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', id);
}

function roleIs(ctx: OrgContext, id: string, ...extra: readonly Guard[]): Guard {
  return sql<SqlBool>`exists (select 1 from role where org_id = ${ctx.orgId} and id = ${id}${sql.join(
    extra.map((condition) => sql` and ${condition}`),
    sql``,
  )})`;
}

interface PermissionGuards {
  readonly matchByKey?: string;
  readonly unprotectedOnly?: boolean;
  readonly organizationScopeOnly?: boolean;
  readonly freshRole?: {
    readonly key: string;
    readonly name: string;
    readonly scope: Role['scope'];
    readonly now: string;
  };
}

function insertPermissions(
  ctx: OrgContext,
  roleId: string,
  permissions: readonly string[],
  guards: PermissionGuards,
): ScalarStatement {
  let source = db
    .selectFrom('role as r')
    .innerJoin(sql`json_each(${JSON.stringify(permissions)})`.as('j'), (join) => join.onTrue())
    .where('r.org_id', '=', ctx.orgId);
  source =
    guards.matchByKey === undefined
      ? source.where('r.id', '=', roleId)
      : source
          .where('r.key', '=', guards.matchByKey)
          .where('r.is_system', '=', 1)
          .where('r.protects_last_holder', '=', 1);
  if (guards.unprotectedOnly === true) source = source.where('r.protects_last_holder', '=', 0);
  if (guards.organizationScopeOnly === true) source = source.where('r.scope', '=', 'organization');
  const fresh = guards.freshRole;
  if (fresh !== undefined) {
    source = source
      .where('r.is_system', '=', 0)
      .where('r.protects_last_holder', '=', 0)
      .where('r.key', '=', fresh.key)
      .where('r.name', '=', fresh.name)
      .where('r.scope', '=', fresh.scope)
      .where('r.created_at', '=', fresh.now)
      .where('r.updated_at', '=', fresh.now)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('role_permission as p')
              .select(sql.lit(1).as('one'))
              .whereRef('p.role_id', '=', 'r.id'),
          ),
        ),
      );
  }

  return scalar(
    db
      .insertInto('role_permission')
      .columns(['org_id', 'role_id', 'permission'])
      .expression(
        source.select((eb) => [
          eb.val(ctx.orgId).as('org_id'),
          'r.id as role_id',
          sql<string>`j.value`.as('permission'),
        ]),
      )
      .onConflict((conflict) => conflict.doNothing()),
  );
}

/** The statements must run in one batch: the permission insert matches the role insert of the same batch. */
export function seedDefaultsStatements(
  ctx: OrgContext,
  input: { readonly now: string; readonly ids: Readonly<Record<DefaultRoleKey, string>> },
): ScalarStatement[] {
  return DEFAULT_ROLES.flatMap((role) => {
    const id = input.ids[role.key];
    return [
      scalar(
        insertRole(
          ctx,
          {
            id,
            key: role.key,
            name: role.name,
            scope: role.scope,
            isSystem: true,
            protectsLastHolder: role.protectsLastHolder,
            now: input.now,
          },
          'key',
        ),
      ),
      insertPermissions(
        ctx,
        id,
        role.permissions,
        role.protectsLastHolder ? { matchByKey: role.key } : {},
      ),
    ];
  });
}

function toRoles(rows: readonly RoleRow[]): Role[] {
  const roles = new Map<string, Role & { permissions: string[] }>();
  for (const row of rows) {
    let role = roles.get(row.id);
    if (role === undefined) {
      role = {
        id: row.id,
        key: row.key,
        name: row.name,
        scope: row.scope as Role['scope'],
        isSystem: row.is_system === 1,
        protectsLastHolder: row.protects_last_holder === 1,
        revision: row.revision,
        permissions: [],
      };
      roles.set(row.id, role);
    }
    if (row.permission !== null) role.permissions.push(row.permission);
  }
  return [...roles.values()];
}

function selectRoles(ctx: OrgContext) {
  return db
    .selectFrom('role')
    .leftJoin('role_permission', (join) =>
      join
        .onRef('role_permission.role_id', '=', 'role.id')
        .onRef('role_permission.org_id', '=', 'role.org_id'),
    )
    .select([
      'role.id',
      'role.key',
      'role.name',
      'role.scope',
      'role.is_system',
      'role.protects_last_holder',
      'role.revision',
      'role_permission.permission',
    ])
    .where('role.org_id', '=', ctx.orgId)
    .orderBy('role.key')
    .orderBy('role_permission.permission');
}

interface RoleFacts {
  readonly is_system: number;
  readonly protects_last_holder: number;
  readonly referenced: number;
}

export function createRoleRepository(
  executor: ScalarSqlExecutor,
  options: RoleRepositoryOptions = {},
): RoleRepository {
  const providers = options.providerAnchors ?? [];

  async function facts(ctx: OrgContext, id: string): Promise<RoleFacts | null> {
    const rows = await run<RoleFacts>(
      executor,
      db
        .selectFrom('role')
        .select([
          'is_system',
          'protects_last_holder',
          sql<number>`exists (select 1 from access_grant g where g.role_id = role.id)`.as(
            'referenced',
          ),
        ])
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', id),
    );
    return rows[0] ?? null;
  }

  async function fenced(
    ctx: OrgContext,
    fence: MutationFence,
    authority: Guard,
    checks: readonly Statement[],
    mutations: readonly Statement[],
    probes: FailureProbes,
  ) {
    const guard = assertGuard(authority, ctx);
    const outcome = await runOrgFenced(
      executor,
      ctx,
      fence,
      guard,
      [...checks, ...mutations],
      probes,
    );
    return outcome.ok
      ? { ok: true as const, results: outcome.results.slice(guard.length + checks.length) }
      : outcome;
  }

  return {
    async list(ctx) {
      return toRoles(await run<RoleRow>(executor, selectRoles(ctx)));
    },

    async get(ctx, id) {
      const rows = await run<RoleRow>(executor, selectRoles(ctx).where('role.id', '=', id));
      return toRoles(rows)[0] ?? null;
    },

    async create(ctx, fence, input) {
      if (!ROLE_KEY_PATTERN.test(input.key)) {
        throw new TypeError(`invalid role key ${JSON.stringify(input.key)}`);
      }
      requireName(input.name);
      requireNonEmpty(input.opId, 'opId');
      if (DEFAULT_KEYS.has(input.key)) return 'duplicate_key';
      if (!acceptable(input.scope, input.permissions)) return 'invalid_permissions';

      const unused = sql<SqlBool>`(not exists (
          select 1 from role where org_id = ${ctx.orgId} and (id = ${input.id} or key = ${input.key}))
        or exists (
          select 1 from role r
          where r.org_id = ${ctx.orgId} and r.id = ${input.id} and r.key = ${input.key}
            and r.name = ${input.name} and r.scope = ${input.scope}
            and r.is_system = 0 and r.protects_last_holder = 0
            and r.created_at = ${input.now} and r.updated_at = ${input.now}
            and not exists (select 1 from role_permission p where p.role_id = r.id)))`;
      const authority = actorAuthority(ctx, fence, providers, { requested: input.permissions });
      const outcome = await fenced(
        ctx,
        fence,
        authority,
        assertCheck(unused),
        [
          scalar(
            insertRole(
              ctx,
              {
                id: input.id,
                key: input.key,
                name: input.name,
                scope: input.scope,
                isSystem: false,
                protectsLastHolder: false,
                now: input.now,
                opId: input.opId,
              },
              'any',
            ).returning('id'),
          ),
          insertPermissions(ctx, input.id, input.permissions, {
            freshRole: { key: input.key, name: input.name, scope: input.scope, now: input.now },
          }),
          scalar(
            roleBump(ctx, input.id, input.now, input.opId)
              .where(sql<SqlBool>`(last_op_id is null or last_op_id <> ${input.opId})`)
              .where(sql<SqlBool>`changes() > 0`),
          ),
        ],
        probesFor(ctx, authority, [unused]),
      );
      if (!outcome.ok) {
        const reason = refusedBy(outcome, 'role create');
        if (reason === 'collision') return 'duplicate_key';
        if (reason === 'conflict') throw new Error('role create has no revision to conflict with');
        return reason;
      }
      const inserted = outcome.results[0];
      return inserted !== undefined && inserted.rows.length > 0 ? 'created' : 'duplicate_key';
    },

    async rename(ctx, fence, id, name, now, opId) {
      requireName(name);
      requireNonEmpty(id, 'id');
      requireNonEmpty(opId, 'opId');
      const expected = expectedRevision(fence);

      const open = roleIs(ctx, id, sql<SqlBool>`protects_last_holder = 0`);
      const conditions = [revisionHolds(ctx, id, expected), open];
      const authority = actorAuthority(ctx, fence, providers, { oldRoleId: id });
      const outcome = await fenced(
        ctx,
        fence,
        authority,
        conditions.flatMap((condition) => assertCheck(condition)),
        [scalar(roleBump(ctx, id, now, opId).set({ name }))],
        probesFor(ctx, authority, [open], { id, expected }),
      );
      if (outcome.ok) return 'renamed';
      const reason = refusedBy(outcome, 'role rename');
      if (reason !== 'collision') return reason;
      const found = await facts(ctx, id);
      if (found === null) return 'not_found';
      if (found.protects_last_holder === 1) return 'locked';
      throw new Error('role rename refused for an unknown reason');
    },

    async setPermissions(ctx, fence, id, permissions, now, opId) {
      requireNonEmpty(id, 'id');
      requireNonEmpty(opId, 'opId');
      const expected = expectedRevision(fence);
      if (!permissions.every(isPermission)) return 'invalid_permissions';
      const hasOrganizationPermission = permissions.some((name) => name.startsWith('org:'));
      const roleIds = (eb: ExpressionBuilder<Database, 'role_permission'>) => {
        let roles = eb
          .selectFrom('role')
          .select('id')
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', id)
          .where('protects_last_holder', '=', 0);
        if (hasOrganizationPermission) roles = roles.where('scope', '=', 'organization');
        return roles;
      };
      const open = roleIs(
        ctx,
        id,
        sql<SqlBool>`protects_last_holder = 0`,
        ...(hasOrganizationPermission ? [sql<SqlBool>`scope = 'organization'`] : []),
      );
      const conditions = [revisionHolds(ctx, id, expected), open];

      const authority = actorAuthority(ctx, fence, providers, {
        oldRoleId: id,
        requested: permissions,
      });
      const outcome = await fenced(
        ctx,
        fence,
        authority,
        conditions.flatMap((condition) => assertCheck(condition)),
        [
          scalar(
            db
              .deleteFrom('role_permission')
              .where('org_id', '=', ctx.orgId)
              .where('role_id', '=', id)
              .where('role_id', 'in', roleIds),
          ),
          insertPermissions(ctx, id, permissions, {
            unprotectedOnly: true,
            organizationScopeOnly: hasOrganizationPermission,
          }),
          scalar(roleBump(ctx, id, now, opId)),
        ],
        probesFor(ctx, authority, [open], { id, expected }),
      );
      if (outcome.ok) return 'updated';
      const reason = refusedBy(outcome, 'role permission change');
      if (reason !== 'collision') return reason;
      const found = await facts(ctx, id);
      if (found === null) return 'not_found';
      return found.protects_last_holder === 1 ? 'locked' : 'invalid_permissions';
    },

    async delete(ctx, fence, id, opId) {
      requireNonEmpty(id, 'id');
      requireNonEmpty(opId, 'opId');
      const expected = expectedRevision(fence);

      const removable = roleIs(
        ctx,
        id,
        sql<SqlBool>`is_system = 0`,
        sql<SqlBool>`not exists (select 1 from access_grant g where g.role_id = role.id)`,
      );
      const conditions = [revisionHolds(ctx, id, expected), removable];
      const authority = actorAuthority(ctx, fence, providers, { oldRoleId: id });
      const outcome = await fenced(
        ctx,
        fence,
        authority,
        conditions.flatMap((condition) => assertCheck(condition)),
        [
          scalar(
            db
              .deleteFrom('role')
              .where('org_id', '=', ctx.orgId)
              .where('id', '=', id)
              .where('is_system', '=', 0),
          ),
        ],
        probesFor(ctx, authority, [removable], { id, expected }),
      );
      if (outcome.ok) return 'deleted';
      const reason = refusedBy(outcome, 'role delete');
      if (reason !== 'collision') return reason;
      const found = await facts(ctx, id);
      if (found === null) return 'not_found';
      if (found.is_system === 1) return 'system';
      if (found.referenced === 1) return 'in_use';
      throw new Error('role delete refused for an unknown reason');
    },
  };
}
