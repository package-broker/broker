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
  type QueryCreator,
  type SelectQueryBuilder,
  type SqlBool,
} from 'kysely';
import type { OrgContext, SqlExecutor, SqlValue, Statement } from '@package-broker/core/db/port';
import {
  fenceGuard,
  runFenced,
  type FailureProbes,
  type FencedOutcome,
  type FenceGuard,
  type MutationFence,
  type TokenMutationFence,
} from '@package-broker/core/authz/fence';
import { ulid } from '@package-broker/core/ids';
import { isValidDomain } from '@package-broker/core/identity/policy';
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
  /**
   * Required and non-empty when `emailAuthoritative`: an identity's e-mail counts for e-mail
   * grants only when its domain equals one of these lowercase domains.
   */
  readonly emailAuthoritativeDomains?: readonly string[];
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
      /** Legacy timestamp, validated when supplied but never used for freshness. */
      readonly now?: string;
      readonly providers: readonly ProtectedHolderProvider[];
    })
  | (ProtectedHolderCommon & { readonly kind: 'local_recovery' });

export const EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const EVIDENCE_FUTURE_SKEW_MS = 60 * 1000;

export type DatabaseTime = Expression<number>;

/** The database clock in epoch milliseconds, stable within one statement. */
export const databaseTimeMs: DatabaseTime = sql<number>`cast(round(unixepoch('now', 'subsec') * 1000) as integer)`;

export type HolderAlias = Record<
  'user' | 'grant' | 'role' | 'member' | 'identity' | 'binding' | 'login' | 'credential',
  string
>;

/**
 * Values a guard binds once in a leading WITH and references wherever it needs them, so a statement
 * stays under the D1 limit of 100 bound parameters however often the value is used. Provider anchors
 * travel as one JSON parameter.
 */
export interface GuardBindings {
  /** Query creator that carries the WITH; start exactly one select of the guard from it. */
  readonly creator: QueryCreator<LooseDatabase>;
  readonly org: Expression<string>;
  value(column: string): Expression<string | number>;
  /** A select of `(provider, anchor)`, all anchors or the e-mail authoritative ones only. */
  anchors(authoritativeOnly: boolean): Expression<unknown>;
  /** A select of `(provider, domain)` for every e-mail authoritative domain. */
  authoritativeDomains(): Expression<unknown>;
}

const BOUND_COLUMN = /^[a-z][a-z_]*$/;
const BOUND_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function guardBindings(
  names: { readonly values: string; readonly anchors: string },
  values: Readonly<Record<string, string | number>>,
  providers: readonly ProtectedHolderProvider[],
): GuardBindings {
  requireProviders(providers);
  if (!BOUND_NAME.test(names.values) || !BOUND_NAME.test(names.anchors)) {
    throw new TypeError('guard binding names must be SQL identifiers');
  }
  const columns = Object.keys(values);
  if (!columns.includes('org_id') || !columns.every((column) => BOUND_COLUMN.test(column))) {
    throw new TypeError('guard bindings need org_id and lowercase column names');
  }
  let creator = loose.with(`${names.values}(${columns.join(', ')})`, (qb) =>
    qb.selectNoFrom(columns.map((column) => sql.val(values[column]).as(column))),
  ) as unknown as QueryCreator<LooseDatabase>;
  if (providers.length > 0) {
    creator = creator.with(
      `${names.anchors}(provider, anchor, email_authoritative, domains)`,
      () =>
        sql`(select json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]') from json_each(${JSON.stringify(
          providers.map((entry) => [
            entry.provider,
            entry.anchor,
            entry.emailAuthoritative ? 1 : 0,
            authoritativeDomainsOf(entry),
          ]),
        )}))`,
    ) as unknown as QueryCreator<LooseDatabase>;
  }
  const value = (column: string) => {
    if (!columns.includes(column)) throw new TypeError(`guard binding ${column} is not bound`);
    return sql<
      string | number
    >`(select ${sql.ref(`${names.values}.${column}`)} from ${sql.table(names.values)})`;
  };
  return {
    creator,
    org: value('org_id') as Expression<string>,
    value,
    anchors: (authoritativeOnly) =>
      providers.length === 0
        ? sql`select null, null where 0`
        : sql`select provider, anchor from ${sql.table(names.anchors)}${
            authoritativeOnly ? sql` where email_authoritative = 1` : sql``
          }`,
    authoritativeDomains: () =>
      providers.length === 0
        ? sql`select null, null where 0`
        : sql`select ${sql.ref(`${names.anchors}.provider`)}, json_each.value from ${sql.table(
            names.anchors,
          )}, json_each(${sql.ref(`${names.anchors}.domains`)}) where ${sql.ref(
            `${names.anchors}.email_authoritative`,
          )} = 1`,
  };
}

function authoritativeDomainsOf(entry: ProtectedHolderProvider): readonly string[] {
  return entry.emailAuthoritative ? (entry.emailAuthoritativeDomains ?? []) : [];
}

function jsonAuthoritativeDomains(
  providers: readonly ProtectedHolderProvider[],
): Expression<unknown> {
  return sql`select json_extract(value, '$[0]'), json_extract(value, '$[1]') from json_each(${JSON.stringify(
    providers.flatMap((entry) =>
      authoritativeDomainsOf(entry).map((domain) => [entry.provider, domain]),
    ),
  )})`;
}

function jsonAnchors(providers: readonly ProtectedHolderProvider[]): Expression<unknown> {
  return sql`select json_extract(value, '$[0]'), json_extract(value, '$[1]') from json_each(${JSON.stringify(
    providers.map((entry) => [entry.provider, entry.anchor]),
  )})`;
}

type OrgOperand = Expression<string> | string;

function localLogin(org: OrgOperand, alias: HolderAlias) {
  return loose
    .selectFrom(`local_login as ${alias.login}`)
    .select(sql.lit(1).as('one'))
    .where(`${alias.login}.org_id`, '=', org)
    .whereRef(`${alias.login}.user_id`, '=', `${alias.user}.id`)
    .where(`${alias.login}.password_hash`, 'is not', null)
    .where(`${alias.login}.totp_enabled_at`, 'is not', null)
    .where((eb) =>
      eb.exists(
        loose
          .selectFrom(`credential as ${alias.credential}`)
          .select(sql.lit(1).as('one'))
          .where(`${alias.credential}.org_id`, '=', org)
          .whereRef(`${alias.credential}.id`, '=', `${alias.login}.totp_credential_id`),
      ),
    );
}

export function usableLocalLogin(ctx: OrgContext | GuardBindings, alias: HolderAlias) {
  return localLogin('orgId' in ctx ? ctx.orgId : ctx.org, alias);
}

function identityWithAnchor(
  org: OrgOperand,
  alias: HolderAlias,
  anchors: Expression<unknown>,
  exclude: ProtectedHolderExclusion | undefined,
  authoritativeDomains?: Expression<unknown>,
) {
  let query = loose
    .selectFrom(`identity as ${alias.identity}`)
    .select(sql.lit(1).as('one'))
    .where(`${alias.identity}.org_id`, '=', org)
    .whereRef(`${alias.identity}.user_id`, '=', `${alias.user}.id`)
    .whereRef(`${alias.identity}.email`, '=', `${alias.user}.email`)
    .where(`${alias.identity}.email_verified`, '=', sql.lit(1))
    .where((eb) =>
      eb.exists(
        loose
          .selectFrom(`identity_provider_binding as ${alias.binding}`)
          .select(sql.lit(1).as('one'))
          .where(`${alias.binding}.org_id`, '=', org)
          .whereRef(`${alias.binding}.provider`, '=', `${alias.identity}.provider`)
          .where(
            sql<SqlBool>`(${sql.ref(`${alias.binding}.provider`)}, ${sql.ref(`${alias.binding}.anchor`)}) in (${anchors})`,
          ),
      ),
    );
  if (authoritativeDomains !== undefined) {
    const email = sql.ref(`${alias.identity}.email`);
    query = query.where(
      sql<SqlBool>`(${sql.ref(`${alias.identity}.provider`)}, substr(${email}, instr(${email}, '@') + 1)) in (${authoritativeDomains})`,
    );
  }
  if (exclude?.identityId !== undefined) {
    query = query.where(`${alias.identity}.id`, '<>', exclude.identityId);
  }
  return query;
}

/** The anchors bind as one JSON parameter whatever their number. */
export function verifiedIdentity(
  ctx: OrgContext,
  alias: HolderAlias,
  providers: readonly ProtectedHolderProvider[],
  exclude: ProtectedHolderExclusion | undefined,
) {
  return identityWithAnchor(ctx.orgId, alias, jsonAnchors(providers), exclude);
}

/** `verifiedIdentity` at an e-mail authoritative provider whose domains include the e-mail's. */
export function authoritativeVerifiedIdentity(
  ctx: OrgContext,
  alias: HolderAlias,
  providers: readonly ProtectedHolderProvider[],
) {
  const authoritative = providers.filter((entry) => entry.emailAuthoritative);
  return identityWithAnchor(
    ctx.orgId,
    alias,
    jsonAnchors(authoritative),
    undefined,
    jsonAuthoritativeDomains(authoritative),
  );
}

/** `verifiedIdentity` against anchors and organization already bound by `guardBindings`. */
export function boundVerifiedIdentity(
  bindings: GuardBindings,
  alias: HolderAlias,
  authoritativeOnly: boolean,
) {
  return identityWithAnchor(
    bindings.org,
    alias,
    bindings.anchors(authoritativeOnly),
    undefined,
    authoritativeOnly ? bindings.authoritativeDomains() : undefined,
  );
}

function evidenceWithin(column: string, bindings?: GuardBindings, now?: DatabaseTime) {
  const ms = sql`cast(round(unixepoch(${sql.ref(column)}, 'subsec') * 1000) as integer)`;
  if (now !== undefined) {
    return sql<SqlBool>`(${ms} >= ${now} - ${sql.lit(EVIDENCE_MAX_AGE_MS)} and ${ms} <= ${now} + ${sql.lit(EVIDENCE_FUTURE_SKEW_MS)})`;
  }
  if (bindings !== undefined) {
    return sql<SqlBool>`(${ms} >= ${bindings.value('lower_ms')} and ${ms} <= ${bindings.value('upper_ms')})`;
  }
  return sql<SqlBool>`${ms} between ${databaseTimeMs} - ${sql.lit(EVIDENCE_MAX_AGE_MS)} and ${databaseTimeMs} + ${sql.lit(EVIDENCE_FUTURE_SKEW_MS)}`;
}

/**
 * Fresh membership backed by a verified identity of the same provider and a current anchor.
 * Uses the database clock by default; `boundWindow` uses the bindings' lower_ms and upper_ms,
 * and `now` overrides either window. `excludeIdentity` uses the bindings' excluded_identity.
 */
export function freshGroupMembership(
  bindings: GuardBindings,
  alias: HolderAlias,
  options: {
    readonly excludeIdentity?: boolean;
    readonly boundWindow?: boolean;
    readonly now?: DatabaseTime;
  } = {},
): Expression<SqlBool> {
  const window = options.boundWindow === true ? bindings : undefined;
  let identity = boundVerifiedIdentity(bindings, alias, false)
    .whereRef(`${alias.identity}.provider`, '=', `${alias.member}.provider`)
    .where(evidenceWithin(`${alias.identity}.validated_at`, window, options.now));
  if (options.excludeIdentity === true) {
    identity = identity.where(`${alias.identity}.id`, '<>', bindings.value('excluded_identity'));
  }
  return sql<SqlBool>`(${sql.ref(`${alias.member}.org_id`)} = ${bindings.org} and ${evidenceWithin(`${alias.member}.refreshed_at`, window, options.now)} and exists ${identity})`;
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
    const domains: unknown = entry.emailAuthoritativeDomains;
    if (
      (domains !== undefined &&
        (!Array.isArray(domains) ||
          !domains.every((domain) => typeof domain === 'string' && isValidDomain(domain)))) ||
      (entry.emailAuthoritative && (!Array.isArray(domains) || domains.length === 0))
    ) {
      throw new TypeError(
        'an e-mail authoritative provider needs a non-empty list of lowercase domains',
      );
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
  if (input.now === undefined) {
    requireProviders(input.providers);
    return;
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
 * Every input value binds once, so the bound parameter count does not depend on the anchors.
 */
export function protectedHolder(
  ctx: OrgContext,
  userIdColumn: Expression<string>,
  input: ProtectedHolderInput,
  options: { readonly includeSuspended?: boolean } = {},
): Guard {
  requireProtectedHolderInput(input);
  const outer = referencedTable(userIdColumn);
  const alias = guardAliases(
    [
      'user',
      'grant',
      'role',
      'member',
      'identity',
      'binding',
      'login',
      'credential',
      'values',
      'anchors',
    ],
    outer,
  );
  const exclude = input.exclude;
  const fresh = input.kind === 'fresh';
  const values: Record<string, string | number> = { org_id: ctx.orgId };
  if (exclude?.grantId !== undefined) values.excluded_grant = exclude.grantId;
  if (exclude?.userId !== undefined) values.excluded_user = exclude.userId;
  if (exclude?.identityId !== undefined) values.excluded_identity = exclude.identityId;
  const membership = exclude?.membership;
  if (membership !== undefined) {
    values.excluded_member_user = membership.userId;
    values.excluded_member_provider = membership.provider;
    values.excluded_member_group = membership.groupName;
  }
  const bindings = guardBindings(
    { values: alias.values, anchors: alias.anchors },
    values,
    fresh ? input.providers : [],
  );
  const org = bindings.org;

  const verified = (authoritativeOnly: boolean) => {
    const query = boundVerifiedIdentity(bindings, alias, authoritativeOnly);
    return exclude?.identityId === undefined
      ? query
      : query.where(`${alias.identity}.id`, '<>', bindings.value('excluded_identity'));
  };

  const emailGrants = (creator: QueryCreator<LooseDatabase>) => {
    let query = creator
      .selectFrom(`user_account as ${alias.user}`)
      .innerJoin(`access_grant as ${alias.grant}`, (join) =>
        join
          .onRef(`${alias.grant}.org_id`, '=', `${alias.user}.org_id`)
          .on(`${alias.grant}.subject_type`, '=', sql.lit('email'))
          .onRef(`${alias.grant}.subject_value`, '=', `${alias.user}.email`)
          .on(`${alias.grant}.scope`, '=', sql.lit('organization')),
      )
      .innerJoin(`role as ${alias.role}`, (join) =>
        join
          .onRef(`${alias.role}.id`, '=', `${alias.grant}.role_id`)
          .onRef(`${alias.role}.org_id`, '=', `${alias.grant}.org_id`)
          .on(`${alias.role}.protects_last_holder`, '=', sql.lit(1)),
      )
      .select(sql.lit(1).as('one'))
      .where(`${alias.user}.org_id`, '=', org)
      .where(`${alias.user}.id`, '=', userIdColumn)
      .$if(options.includeSuspended !== true, (qb) =>
        qb.where(`${alias.user}.status`, '=', sql.lit('active')),
      );
    if (exclude?.grantId !== undefined) {
      query = query.where(`${alias.grant}.id`, '<>', bindings.value('excluded_grant'));
    }
    if (exclude?.userId !== undefined) {
      query = query.where(`${alias.user}.id`, '<>', bindings.value('excluded_user'));
    }
    return query;
  };

  const localAdmin = emailGrants(bindings.creator).where((eb) =>
    eb.exists(usableLocalLogin(bindings, alias)),
  );
  if (input.kind === 'local_recovery') return existsOf(localAdmin);

  const branches: (typeof localAdmin)[] = [];

  if (input.providers.some((entry) => entry.emailAuthoritative)) {
    branches.push(emailGrants(loose).where((eb) => eb.exists(verified(true))));
  }

  if (input.providers.length > 0) {
    let byGroup = loose
      .selectFrom(`user_group as ${alias.member}`)
      .innerJoin(`user_account as ${alias.user}`, `${alias.user}.id`, `${alias.member}.user_id`)
      .innerJoin(`access_grant as ${alias.grant}`, (join) =>
        join
          .onRef(`${alias.grant}.org_id`, '=', `${alias.member}.org_id`)
          .on(`${alias.grant}.subject_type`, '=', sql.lit('group'))
          .onRef(`${alias.grant}.subject_provider`, '=', `${alias.member}.provider`)
          .onRef(`${alias.grant}.subject_value`, '=', `${alias.member}.group_name`)
          .on(`${alias.grant}.scope`, '=', sql.lit('organization')),
      )
      .innerJoin(`role as ${alias.role}`, (join) =>
        join
          .onRef(`${alias.role}.id`, '=', `${alias.grant}.role_id`)
          .onRef(`${alias.role}.org_id`, '=', `${alias.grant}.org_id`)
          .on(`${alias.role}.protects_last_holder`, '=', sql.lit(1)),
      )
      .select(sql.lit(1).as('one'))
      .where(`${alias.user}.org_id`, '=', org)
      .where(`${alias.user}.id`, '=', userIdColumn)
      .$if(options.includeSuspended !== true, (qb) =>
        qb.where(`${alias.user}.status`, '=', sql.lit('active')),
      )
      .where(
        freshGroupMembership(bindings, alias, {
          excludeIdentity: exclude?.identityId !== undefined,
        }),
      );
    if (exclude?.grantId !== undefined) {
      byGroup = byGroup.where(`${alias.grant}.id`, '<>', bindings.value('excluded_grant'));
    }
    if (exclude?.userId !== undefined) {
      byGroup = byGroup.where(`${alias.user}.id`, '<>', bindings.value('excluded_user'));
    }
    if (membership !== undefined) {
      byGroup = byGroup.where((eb) =>
        eb.not(
          eb.and([
            eb(`${alias.member}.user_id`, '=', bindings.value('excluded_member_user')),
            eb(`${alias.member}.provider`, '=', bindings.value('excluded_member_provider')),
            eb(`${alias.member}.group_name`, '=', bindings.value('excluded_member_group')),
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
 * One statement that fails the batch with a UNIQUE error unless the condition evaluates to integer
 * 1; any other value (NULL, 2, '1') fails closed. Conditions should be exists/comparisons. Never
 * bumps the epoch: use it for CAS and postconditions placed among the mutations.
 *
 * D1 refuses a statement with more than 100 bound parameters. When the conditions of one fence do
 * not fit one statement, keep one in `assertGuard` and give each further condition its own
 * `assertCheck` placed first among the mutations; the batch fails as a whole on any of them.
 */
export function assertCheck(condition: Guard): readonly Statement[] {
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
  return [compile(insert)];
}

export { ACCESS_MUTATION_GUARD_CONSTRAINT } from '@package-broker/core/db/errors';

const guardOrgs = new WeakMap<object, string>();

/** Replaces the organization's epoch when changed is true; requires exactly one matching epoch row. */
export function cacheEpochBumpStatements(ctx: OrgContext, changed?: Guard): readonly Statement[] {
  const ctes = db as unknown as Kysely<GuardCtes & Database>;
  const bump = ctes
    .updateTable('cache_epoch')
    .set({
      version:
        changed === undefined
          ? sql<string>`hex(randomblob(16))`
          : sql<string>`case when ${changed} then hex(randomblob(16)) else version end`,
    })
    .where('org_id', '=', ctx.orgId);
  const bumpedOnce = ctes
    .with('guard_rows(n)', (qb) =>
      qb.selectNoFrom(sql.lit(1).as('n')).unionAll(qb.selectNoFrom(sql.lit(2).as('n'))),
    )
    .insertInto('access_mutation_guard')
    .columns(['key'])
    .expression(
      ctes
        .selectFrom(['guard_rows'])
        .select(sql<string>`${newOpId()}`.as('key'))
        .where(sql<boolean>`changes() <> 1`),
    );
  return [compile(bump), compile(bumpedOnce)];
}

/**
 * The fence guard: three statements. The check from assertCheck, then the organization's cache_epoch
 * version replaced, then a failure unless exactly one row was replaced, so a missing cache_epoch row
 * fails the whole batch. Exactly one assertGuard belongs in a batch; it is the only statement that
 * bumps the epoch. An optional changed condition preserves the epoch for no-op writes.
 */
export function assertGuard(condition: Guard, ctx: OrgContext, changed?: Guard): FenceGuard {
  const guard = fenceGuard([...assertCheck(condition), ...cacheEpochBumpStatements(ctx, changed)]);
  guardOrgs.set(guard, ctx.orgId);
  return guard;
}

/**
 * The entry point for fenced writes. Refuses a guard that assertGuard did not build for ctx, and
 * mutations that touch cache_epoch (only the guard bumps it); a missing cache_epoch row after a
 * failed batch is a deployment fault and throws instead of being classified.
 */
export async function runOrgFenced(
  executor: SqlExecutor,
  ctx: OrgContext,
  fence: MutationFence | TokenMutationFence,
  guard: FenceGuard,
  mutations: readonly Statement[],
  probes: FailureProbes,
): Promise<FencedOutcome> {
  if (guardOrgs.get(guard) !== ctx.orgId) {
    throw new TypeError('the fence guard was not built by assertGuard for this organization');
  }
  if (mutations.some((statement) => /cache_epoch/i.test(statement.sql))) {
    throw new TypeError('fenced mutations must not touch cache_epoch; the guard bumps it');
  }
  const outcome = await runFenced(executor, fence, guard, mutations, probes);
  if (!outcome.ok && outcome.reason !== 'indeterminate') {
    const epoch = await executor.all(
      compile(db.selectFrom('cache_epoch').select('org_id').where('org_id', '=', ctx.orgId)),
    );
    if (epoch.length === 0) {
      throw new Error('cache_epoch row is missing for the organization');
    }
  }
  return outcome;
}
