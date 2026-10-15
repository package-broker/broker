import {
  DummyDriver,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  expressionBuilder,
  sql,
  type Compilable,
  type Expression,
  type OperationNode,
  type SelectQueryBuilder,
  type SqlBool,
} from 'kysely';
import type { OrgContext, SqlValue, Statement } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import type { Database } from './schema.js';

export type { Database } from './schema.js';

export const db = new Kysely<Database>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (kysely) => new SqliteIntrospector(kysely),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  },
});

function isSqlValue(value: unknown): value is SqlValue {
  if (value === null || typeof value === 'string' || value instanceof Uint8Array) {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
  }
  return false;
}

export function compile(query: Compilable): Statement {
  const { sql, parameters } = query.compile();
  const params = parameters.map((parameter): SqlValue => {
    if (!isSqlValue(parameter)) {
      throw new TypeError('SQL parameter is not a valid SqlValue');
    }
    return parameter;
  });
  return { sql, params };
}

export const newOpId = ulid;

export type Guard = Expression<SqlBool>;

/** An expression must be a column reference qualified with a table; anything else throws TypeError. */
export type UserIdOperand = Expression<string> | string;

const eb = expressionBuilder<Database>();

function unwrapReference(node: OperationNode): OperationNode {
  if (
    node.kind === 'RawNode' &&
    'sqlFragments' in node &&
    'parameters' in node &&
    Array.isArray(node.parameters) &&
    node.parameters.length === 1 &&
    Array.isArray(node.sqlFragments) &&
    node.sqlFragments.every((fragment) => fragment === '')
  ) {
    return node.parameters[0] as OperationNode;
  }
  return node;
}

function referencedTable(value: UserIdOperand): string | null {
  if (typeof value === 'string') return null;
  const node = unwrapReference(value.toOperationNode());
  if (node.kind !== 'ReferenceNode') {
    throw new TypeError('user id must be a string or a table-qualified column reference');
  }
  const table = (node as { table?: { table: { identifier: { name: string } } } }).table;
  if (table === undefined) {
    throw new TypeError('user id reference must be qualified with a table');
  }
  return table.table.identifier.name;
}

function guardAliases<K extends string>(
  names: readonly K[],
  outer: string | null,
): Record<K, string> {
  const outerName = outer?.toLowerCase();
  for (let attempt = 1; ; attempt += 1) {
    const suffix = attempt === 1 ? '' : `_${attempt}`;
    const aliases = Object.fromEntries(
      names.map((name) => [name, `guard_${name}${suffix}`]),
    ) as Record<K, string>;
    if (
      outerName === undefined ||
      !Object.values<string>(aliases).some((alias) => alias === outerName)
    ) {
      return aliases;
    }
  }
}

type LooseDatabase = Record<string, Record<string, unknown>>;

const loose = db as unknown as Kysely<LooseDatabase>;

function existsOf(query: Expression<unknown>): Guard {
  return sql<SqlBool>`exists ${query}`;
}

export function existsGuard<DB extends Database, TB extends keyof DB, O>(
  build: (database: Kysely<Database>) => SelectQueryBuilder<DB, TB, O>,
): Guard {
  return eb.exists(build(db));
}

export function opGuard(
  ctx: OrgContext,
  table: 'local_login',
  key: { readonly userId: string },
  opId: string,
): Guard {
  if (opId === '') {
    throw new TypeError('opId must be a non-empty string');
  }
  const { op } = guardAliases(['op'], null);
  return existsOf(
    loose
      .selectFrom(`${table} as ${op}`)
      .select(sql.lit(1).as('one'))
      .where(`${op}.org_id`, '=', ctx.orgId)
      .where(`${op}.user_id`, '=', key.userId)
      .where(`${op}.last_op_id`, '=', opId),
  );
}

export function ownsIdentity(
  ctx: OrgContext,
  input: { readonly provider: string; readonly subject: string; readonly userId: UserIdOperand },
): Guard {
  const outer = referencedTable(input.userId);
  const { identity } = guardAliases(['identity'], outer);
  return existsOf(
    loose
      .selectFrom(`identity as ${identity}`)
      .select(sql.lit(1).as('one'))
      .where(`${identity}.org_id`, '=', ctx.orgId)
      .where(`${identity}.provider`, '=', input.provider)
      .where(`${identity}.subject`, '=', input.subject)
      .where(`${identity}.user_id`, '=', input.userId),
  );
}

export function anchorMatches(ctx: OrgContext, provider: string, anchor: string): Guard {
  const { binding } = guardAliases(['binding'], null);
  return existsOf(
    loose
      .selectFrom(`identity_provider_binding as ${binding}`)
      .select(sql.lit(1).as('one'))
      .where(`${binding}.org_id`, '=', ctx.orgId)
      .where(`${binding}.provider`, '=', provider)
      .where(`${binding}.anchor`, '=', anchor),
  );
}

function emailBranch(
  database: Kysely<LooseDatabase>,
  ctx: OrgContext,
  userId: UserIdOperand,
  alias: { readonly user: string; readonly grant: string; readonly role: string },
) {
  return database
    .selectFrom(`user_account as ${alias.user}`)
    .innerJoin(`access_grant as ${alias.grant}`, (join) =>
      join
        .onRef(`${alias.grant}.org_id`, '=', `${alias.user}.org_id`)
        .on(`${alias.grant}.subject_type`, '=', 'email')
        .onRef(`${alias.grant}.subject_value`, '=', `${alias.user}.email`)
        .on(`${alias.grant}.scope`, '=', 'organization'),
    )
    .innerJoin(`role as ${alias.role}`, (join) =>
      join
        .onRef(`${alias.role}.id`, '=', `${alias.grant}.role_id`)
        .onRef(`${alias.role}.org_id`, '=', `${alias.grant}.org_id`)
        .on(`${alias.role}.protects_last_holder`, '=', 1),
    )
    .select(sql.lit(1).as('one'))
    .where(`${alias.user}.org_id`, '=', ctx.orgId)
    .where(`${alias.user}.id`, '=', userId)
    .where(`${alias.user}.status`, '=', 'active');
}

export function adminEligibility(ctx: OrgContext, userId: UserIdOperand): Guard {
  const outer = referencedTable(userId);
  const alias = guardAliases(['user', 'grant', 'role'], outer);
  return existsOf(emailBranch(loose, ctx, userId, alias));
}

/** `userIdColumn` follows the same rule as `UserIdOperand`: a table-qualified column reference. */
export function protectedHolder(
  ctx: OrgContext,
  userIdColumn: Expression<string>,
  exclude?: { readonly grantId?: string; readonly userId?: string },
): Guard {
  const outer = referencedTable(userIdColumn);
  const alias = guardAliases(['user', 'grant', 'role', 'member'], outer);
  const excludedGrant = exclude?.grantId;
  const excludedUser = exclude?.userId;

  let byEmail = emailBranch(loose, ctx, userIdColumn, alias);

  let byGroup = loose
    .selectFrom(`user_group as ${alias.member}`)
    .innerJoin(`user_account as ${alias.user}`, `${alias.user}.id`, `${alias.member}.user_id`)
    .innerJoin(`access_grant as ${alias.grant}`, (join) =>
      join
        .onRef(`${alias.grant}.org_id`, '=', `${alias.member}.org_id`)
        .on(`${alias.grant}.subject_type`, '=', 'group')
        .onRef(`${alias.grant}.subject_provider`, '=', `${alias.member}.provider`)
        .onRef(`${alias.grant}.subject_value`, '=', `${alias.member}.group_name`)
        .on(`${alias.grant}.scope`, '=', 'organization'),
    )
    .innerJoin(`role as ${alias.role}`, (join) =>
      join
        .onRef(`${alias.role}.id`, '=', `${alias.grant}.role_id`)
        .onRef(`${alias.role}.org_id`, '=', `${alias.grant}.org_id`)
        .on(`${alias.role}.protects_last_holder`, '=', 1),
    )
    .select(sql.lit(1).as('one'))
    .where(`${alias.member}.org_id`, '=', ctx.orgId)
    .where(`${alias.user}.org_id`, '=', ctx.orgId)
    .where(`${alias.user}.id`, '=', userIdColumn)
    .where(`${alias.user}.status`, '=', 'active');

  if (excludedGrant !== undefined) {
    byEmail = byEmail.where(`${alias.grant}.id`, '<>', excludedGrant);
    byGroup = byGroup.where(`${alias.grant}.id`, '<>', excludedGrant);
  }
  if (excludedUser !== undefined) {
    byEmail = byEmail.where(`${alias.user}.id`, '<>', excludedUser);
    byGroup = byGroup.where(`${alias.user}.id`, '<>', excludedUser);
  }

  return existsOf(byEmail.unionAll(byGroup));
}
