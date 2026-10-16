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
import { fenceGuard, type FenceGuard } from '@package-broker/core/authz/fence';
import { ulid } from '@package-broker/core/ids';
import { isValidProviderId } from '@package-broker/core/identity/port';
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

export function referencedTable(value: UserIdOperand): string | null {
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

export function guardAliases<K extends string>(
  names: readonly K[],
  outer: string | null | readonly (string | null)[],
): Record<K, string> {
  const outerNames = (Array.isArray(outer) ? outer : [outer]).flatMap((name) =>
    typeof name === 'string' ? [name.toLowerCase()] : [],
  );
  for (let attempt = 1; ; attempt += 1) {
    const suffix = attempt === 1 ? '' : `_${attempt}`;
    const aliases = Object.fromEntries(
      names.map((name) => [name, `guard_${name}${suffix}`]),
    ) as Record<K, string>;
    if (!Object.values<string>(aliases).some((alias) => outerNames.includes(alias))) {
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

export interface ProtectedHolderProvider {
  readonly provider: string;
  readonly anchor: string;
  readonly emailAuthoritative: boolean;
}

export interface ProtectedHolderExclusion {
  readonly grantId?: string;
  readonly userId?: string;
  readonly identityId?: string;
  readonly membership?: {
    readonly userId: string;
    readonly provider: string;
    readonly groupName: string;
  };
}

interface ProtectedHolderCommon {
  readonly exclude?: ProtectedHolderExclusion;
}

export type ProtectedHolderInput =
  | (ProtectedHolderCommon & {
      readonly kind: 'fresh';
      readonly now: string;
      readonly providers: readonly ProtectedHolderProvider[];
    })
  | (ProtectedHolderCommon & { readonly kind: 'local_recovery' });

export const EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const EVIDENCE_FUTURE_SKEW_MS = 60 * 1000;

function evidenceWithin(column: string, lowerMs: number, upperMs: number) {
  const ms = sql`cast(round(unixepoch(${sql.ref(column)}, 'subsec') * 1000) as integer)`;
  return sql<SqlBool>`${ms} >= ${lowerMs} and ${ms} <= ${upperMs}`;
}

export type HolderAlias = Record<
  'user' | 'grant' | 'role' | 'member' | 'identity' | 'binding' | 'login' | 'credential',
  string
>;

export function usableLocalLogin(ctx: OrgContext, alias: HolderAlias) {
  return loose
    .selectFrom(`local_login as ${alias.login}`)
    .select(sql.lit(1).as('one'))
    .where(`${alias.login}.org_id`, '=', ctx.orgId)
    .whereRef(`${alias.login}.user_id`, '=', `${alias.user}.id`)
    .where(`${alias.login}.password_hash`, 'is not', null)
    .where(`${alias.login}.totp_enabled_at`, 'is not', null)
    .where((eb) =>
      eb.exists(
        loose
          .selectFrom(`credential as ${alias.credential}`)
          .select(sql.lit(1).as('one'))
          .where(`${alias.credential}.org_id`, '=', ctx.orgId)
          .whereRef(`${alias.credential}.id`, '=', `${alias.login}.totp_credential_id`),
      ),
    );
}

export function verifiedIdentity(
  ctx: OrgContext,
  alias: HolderAlias,
  providers: readonly ProtectedHolderProvider[],
  exclude: ProtectedHolderExclusion | undefined,
) {
  let query = loose
    .selectFrom(`identity as ${alias.identity}`)
    .select(sql.lit(1).as('one'))
    .where(`${alias.identity}.org_id`, '=', ctx.orgId)
    .whereRef(`${alias.identity}.user_id`, '=', `${alias.user}.id`)
    .whereRef(`${alias.identity}.email`, '=', `${alias.user}.email`)
    .where(`${alias.identity}.email_verified`, '=', 1)
    .where((eb) =>
      eb.exists(
        loose
          .selectFrom(`identity_provider_binding as ${alias.binding}`)
          .select(sql.lit(1).as('one'))
          .where(`${alias.binding}.org_id`, '=', ctx.orgId)
          .whereRef(`${alias.binding}.provider`, '=', `${alias.identity}.provider`)
          .where((inner) =>
            inner(
              inner.refTuple(`${alias.binding}.provider`, `${alias.binding}.anchor`),
              'in',
              providers.map((entry) => inner.tuple(entry.provider, entry.anchor)),
            ),
          ),
      ),
    );
  if (exclude?.identityId !== undefined) {
    query = query.where(`${alias.identity}.id`, '<>', exclude.identityId);
  }
  return query;
}

const HOLDER_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function requireProviders(providers: readonly ProtectedHolderProvider[]): void {
  for (const entry of providers) {
    if (
      typeof entry.provider !== 'string' ||
      !isValidProviderId(entry.provider) ||
      typeof entry.anchor !== 'string' ||
      entry.anchor === '' ||
      typeof entry.emailAuthoritative !== 'boolean'
    ) {
      throw new TypeError('protected holder provider must have a provider id and an anchor');
    }
  }
}

export function requireProtectedHolderInput(input: ProtectedHolderInput): void {
  if (typeof input !== 'object' || input === null) {
    throw new TypeError('protected holder input is required');
  }
  if (input.kind === 'local_recovery') return;
  if (input.kind !== 'fresh' || !Array.isArray(input.providers)) {
    throw new TypeError('protected holder input must be a freshness descriptor or LocalRecovery');
  }
  const parsed = typeof input.now === 'string' ? new Date(input.now) : new Date(Number.NaN);
  if (
    !HOLDER_TIMESTAMP.test(input.now) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString() !== input.now
  ) {
    throw new TypeError('now must be a UTC timestamp with millisecond precision');
  }
  requireProviders(input.providers);
}

/**
 * Whether the user holds a role with `protects_last_holder` through an organization-scope grant.
 * `fresh` counts an e-mail grant backed by a verified identity of an e-mail authoritative provider
 * with a current trust anchor, a group membership backed by an identity of the same provider with
 * membership and identity evidence no older than 24 h (and not dated more than 60 s ahead), and
 * local-admin eligibility. `local_recovery` counts local-admin eligibility only. Local-admin
 * eligibility is an active user with an e-mail grant and a `local_login` row holding a password
 * and an enabled TOTP.
 *
 * `userIdColumn` follows the same rule as `UserIdOperand`: a table-qualified column reference.
 */
export function protectedHolder(
  ctx: OrgContext,
  userIdColumn: Expression<string>,
  input: ProtectedHolderInput,
): Guard {
  requireProtectedHolderInput(input);
  const outer = referencedTable(userIdColumn);
  const alias = guardAliases(
    ['user', 'grant', 'role', 'member', 'identity', 'binding', 'login', 'credential'],
    outer,
  );
  const exclude = input.exclude;

  const emailGrants = () => {
    let query = loose
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
      .where(`${alias.user}.id`, '=', userIdColumn)
      .where(`${alias.user}.status`, '=', 'active');
    if (exclude?.grantId !== undefined) {
      query = query.where(`${alias.grant}.id`, '<>', exclude.grantId);
    }
    if (exclude?.userId !== undefined) {
      query = query.where(`${alias.user}.id`, '<>', exclude.userId);
    }
    return query;
  };

  const localAdmin = emailGrants().where((eb) => eb.exists(usableLocalLogin(ctx, alias)));
  if (input.kind === 'local_recovery') return existsOf(localAdmin);

  const nowMs = Date.parse(input.now);
  const lowerMs = nowMs - EVIDENCE_MAX_AGE_MS;
  const upperMs = nowMs + EVIDENCE_FUTURE_SKEW_MS;

  const branches: (typeof localAdmin)[] = [];

  const emailProviders = input.providers.filter((entry) => entry.emailAuthoritative);
  if (emailProviders.length > 0) {
    branches.push(
      emailGrants().where((eb) => eb.exists(verifiedIdentity(ctx, alias, emailProviders, exclude))),
    );
  }

  if (input.providers.length > 0) {
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
      .where(`${alias.user}.status`, '=', 'active')
      .where(evidenceWithin(`${alias.member}.refreshed_at`, lowerMs, upperMs))
      .where((eb) =>
        eb.exists(
          verifiedIdentity(ctx, alias, input.providers, exclude)
            .whereRef(`${alias.identity}.provider`, '=', `${alias.member}.provider`)
            .where(evidenceWithin(`${alias.identity}.validated_at`, lowerMs, upperMs)),
        ),
      );
    if (exclude?.grantId !== undefined) {
      byGroup = byGroup.where(`${alias.grant}.id`, '<>', exclude.grantId);
    }
    if (exclude?.userId !== undefined) {
      byGroup = byGroup.where(`${alias.user}.id`, '<>', exclude.userId);
    }
    const membership = exclude?.membership;
    if (membership !== undefined) {
      byGroup = byGroup.where((eb) =>
        eb.not(
          eb.and([
            eb(`${alias.member}.user_id`, '=', membership.userId),
            eb(`${alias.member}.provider`, '=', membership.provider),
            eb(`${alias.member}.group_name`, '=', membership.groupName),
          ]),
        ),
      );
    }
    branches.push(byGroup);
  }

  return existsOf(branches.reduce((all, branch) => all.unionAll(branch), localAdmin));
}

interface GuardCtes {
  guard_cond: { f: number };
  guard_rows: { n: number };
}

/**
 * Fails the batch with a UNIQUE error unless the condition evaluates to integer 1; any other value
 * (NULL, 2, '1') fails closed. Conditions should be exists/comparisons.
 */
export function assertGuard(condition: Guard): FenceGuard {
  const ctes = db as unknown as Kysely<GuardCtes & Database>;
  const insert = ctes
    .with(
      (cte) => cte('guard_cond(f)').materialized(),
      (qb) => qb.selectNoFrom(eb(condition, 'is not', sql.lit(1)).as('f')),
    )
    .with('guard_rows(n)', (qb) =>
      qb.selectNoFrom(sql.lit(1).as('n')).unionAll(qb.selectNoFrom(sql.lit(2).as('n'))),
    )
    .insertInto('access_mutation_guard')
    .columns(['key'])
    .expression(
      ctes
        .selectFrom(['guard_cond', 'guard_rows'])
        .select(sql<string>`${newOpId()}`.as('key'))
        .where('guard_cond.f', '=', sql.lit(1)),
    );
  return fenceGuard([compile(insert)]);
}
