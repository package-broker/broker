import { sql, type Compilable, type ExpressionBuilder } from 'kysely';
import {
  DEFAULT_ROLES,
  isPermission,
  type DefaultRoleKey,
} from '@package-broker/core/authz/permissions';
import { DbError } from '@package-broker/core/db/errors';
import type { OrgContext, ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import {
  ROLE_KEY_PATTERN,
  ROLE_NAME_MAX_LENGTH,
  type Role,
  type RoleRepository,
} from '@package-broker/core/db/roles';
import { compile, db, type Database } from '../kysely.js';

interface RoleRow {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly scope: string;
  readonly is_system: number;
  readonly protects_last_holder: number;
  readonly permission: string | null;
}

interface IdRow {
  readonly id: string;
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
    })
    .onConflict((conflict) =>
      target === 'key' ? conflict.columns(['org_id', 'key']).doNothing() : conflict.doNothing(),
    );
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
      'role_permission.permission',
    ])
    .where('role.org_id', '=', ctx.orgId)
    .orderBy('role.key')
    .orderBy('role_permission.permission');
}

export function createRoleRepository(executor: ScalarSqlExecutor): RoleRepository {
  return {
    async list(ctx) {
      return toRoles(await run<RoleRow>(executor, selectRoles(ctx)));
    },

    async get(ctx, id) {
      const rows = await run<RoleRow>(executor, selectRoles(ctx).where('role.id', '=', id));
      return toRoles(rows)[0] ?? null;
    },

    async create(ctx, input) {
      if (!ROLE_KEY_PATTERN.test(input.key)) {
        throw new TypeError(`invalid role key ${JSON.stringify(input.key)}`);
      }
      requireName(input.name);
      if (DEFAULT_KEYS.has(input.key)) return 'duplicate_key';
      if (!acceptable(input.scope, input.permissions)) return 'invalid_permissions';

      const [inserted] = await executor.batch([
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
            },
            'any',
          ).returning('id'),
        ),
        insertPermissions(ctx, input.id, input.permissions, {
          freshRole: { key: input.key, name: input.name, scope: input.scope, now: input.now },
        }),
      ]);
      return inserted !== undefined && inserted.rows.length > 0 ? 'created' : 'duplicate_key';
    },

    async rename(ctx, id, name, now) {
      requireName(name);
      const results = await executor.batch([
        scalar(
          db
            .updateTable('role')
            .set({ name, updated_at: now })
            .where('org_id', '=', ctx.orgId)
            .where('id', '=', id)
            .where('protects_last_holder', '=', 0),
        ),
        scalar(
          db
            .selectFrom('role')
            .select('protects_last_holder')
            .where('org_id', '=', ctx.orgId)
            .where('id', '=', id),
        ),
      ]);
      const state = results[1]?.rows[0] as { protects_last_holder: number } | undefined;
      if (state === undefined) return 'not_found';
      return state.protects_last_holder === 1 ? 'locked' : 'renamed';
    },

    async setPermissions(ctx, id, permissions, now) {
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
      let touch = db
        .updateTable('role')
        .set({ updated_at: now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', id)
        .where('protects_last_holder', '=', 0);
      if (hasOrganizationPermission) touch = touch.where('scope', '=', 'organization');

      const results = await executor.batch([
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
        scalar(touch),
        scalar(
          db
            .selectFrom('role')
            .select(['protects_last_holder', 'scope'])
            .where('org_id', '=', ctx.orgId)
            .where('id', '=', id),
        ),
      ]);
      const state = results[3]?.rows[0] as
        { protects_last_holder: number; scope: string } | undefined;
      if (state === undefined) return 'not_found';
      if (state.protects_last_holder === 1) return 'locked';
      if (hasOrganizationPermission && state.scope === 'project') return 'invalid_permissions';
      return 'updated';
    },

    async delete(ctx, id) {
      try {
        const deleted = await run<IdRow>(
          executor,
          db
            .deleteFrom('role')
            .where('org_id', '=', ctx.orgId)
            .where('id', '=', id)
            .where('is_system', '=', 0)
            .returning('id'),
        );
        if (deleted.length > 0) return 'deleted';
      } catch (error) {
        if (error instanceof DbError && error.kind === 'foreign_key') return 'in_use';
        throw error;
      }
      const rows = await run<{ is_system: number }>(
        executor,
        db
          .selectFrom('role')
          .select('is_system')
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', id),
      );
      return rows[0] === undefined ? 'not_found' : 'system';
    },
  };
}
