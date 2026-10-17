import {
  expressionBuilder,
  sql,
  type Expression,
  type Kysely,
  type QueryCreator,
  type SelectQueryBuilder,
  type SqlBool,
} from 'kysely';
import { PERMISSIONS } from '@package-broker/core/authz/permissions';
import {
  parseScopeLevel,
  parseScopesJson,
  tokenEffectivePermissions,
  type ScopeLevel,
  type TokenProjectMode,
} from '@package-broker/core/authz/scope';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import {
  adminEligibility,
  compile,
  db,
  EVIDENCE_FUTURE_SKEW_MS,
  EVIDENCE_MAX_AGE_MS,
  boundVerifiedIdentity,
  guardAliases,
  guardBindings,
  referencedTable,
  requireProviders,
  usableLocalLogin,
  verifiedIdentity,
  type Guard,
  type GuardBindings,
  type ProtectedHolderProvider,
  type UserIdOperand,
} from '../kysely.js';
import {
  DEFAULT_IDLE_SECONDS,
  liveSessionCondition,
  requireIdleSeconds,
} from './session-liveness.js';

export type { ProtectedHolderProvider } from '../kysely.js';

export type AccessBoundary = 'organization' | 'project';

export type PermissionScopeName = 'organization' | 'project';

export interface PermissionRow {
  readonly scope: PermissionScopeName;
  readonly permission: string;
}

export interface SessionLookupInput {
  readonly secretHash: string;
  readonly boundary: AccessBoundary;
  readonly projectSlug: string | null;
  readonly providerAnchors: readonly ProtectedHolderProvider[];
}

export interface AccessProject {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: string;
  readonly tokenMaxScope: string;
  readonly requirePublishApproval: boolean;
  readonly revision: number;
}

export interface SessionAccess {
  readonly session: {
    readonly id: string;
    readonly userId: string;
    readonly identityId: string | null;
    readonly csrfHash: string;
    readonly createdAt: string;
    readonly expiresAt: string;
    readonly lastSeenAt: string | null;
    readonly reauthAt: string | null;
  };
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly displayName: string | null;
  };
  readonly identity: {
    readonly id: string;
    readonly provider: string;
    readonly emailVerified: boolean;
    readonly validatedAt: string | null;
    readonly fresh: boolean;
  } | null;
  readonly project: AccessProject | null;
  readonly organizationPermissions: readonly string[];
  readonly projectPermissions: readonly string[];
  readonly protectedHolder: boolean;
}

export interface TokenLookupInput {
  readonly selector: string;
  readonly boundary: AccessBoundary;
  readonly projectSlug: string | null;
  readonly providerAnchors: readonly ProtectedHolderProvider[];
}

export interface TokenAccess {
  readonly token: {
    readonly id: string;
    readonly kind: 'pat' | 'svc';
    readonly name: string;
    readonly userId: string | null;
    readonly servicePrincipalId: string | null;
    readonly boundProjectId: string | null;
    readonly projectMode: TokenProjectMode | null;
    readonly scope: { readonly level: ScopeLevel; readonly readOnly: boolean } | null;
    readonly expiresAt: string | null;
    readonly revokedAt: string | null;
    readonly lastUsedAt: string | null;
    readonly expired: boolean;
    readonly revoked: boolean;
  };
  readonly principalStatus: string;
  readonly validation: {
    readonly kind: 'sso' | 'local' | null;
    readonly identityId: string | null;
    readonly fresh: boolean;
    /** The stored evidence time the 24 h comparison reads, as canonical text; null when absent. */
    readonly evidenceAt: string | null;
  } | null;
  readonly project: AccessProject | null;
  readonly organizationPermissions: readonly string[];
  readonly projectPermissions: readonly string[];
  readonly protectedHolder: boolean;
  /**
   * The principal's own grants (a user's, or a service principal's stored permissions and
   * project binding) reach the requested active project, whatever the token's scope, read-only
   * flag or project selection. False on an organization boundary and for an expired, revoked,
   * inactive or stale credential.
   */
  readonly projectVisible: boolean;
  /**
   * Non-enumerable, so spreading, cloning (`{ ...access }`, `structuredClone`), logging or
   * serializing the envelope never carries the hash. Read it from the original object before any
   * copy; a copy has no verifier.
   */
  readonly verifier: { readonly secretHash: string; readonly pepperVersion: number };
}

export interface AccessRepository {
  /**
   * One `executor.all`. Null when the credential is unknown, revoked, expired, idle, in another
   * organization or its user is not active. An unknown, archived or (on an organization boundary)
   * ignored slug still returns the authenticated envelope with `project: null` and an empty
   * `projectPermissions`. Never writes.
   */
  lookupSession(ctx: OrgContext, input: SessionLookupInput): Promise<SessionAccess | null>;
  /**
   * Sets `last_seen_at` only when the last sign of life is at least five minutes old, using database
   * time. True when a row changed. Call only after a route allow.
   */
  touchSession(ctx: OrgContext, sessionId: string): Promise<boolean>;
  /**
   * One `executor.all`. Null when the selector is unknown, not a personal or service token, or in
   * another organization. Expired, revoked, suspended and stale tokens still return the envelope,
   * with empty permission arrays. A project that is unknown, archived or not covered by the token
   * returns `project: null` and empty arrays; `projectVisible` distinguishes principal visibility
   * independently of token coverage. On an organization boundary only `organizationPermissions`
   * is filled; on a project boundary only
   * `projectPermissions`, holding the organization and project rows. Never writes.
   */
  lookupToken(ctx: OrgContext, input: TokenLookupInput): Promise<TokenAccess | null>;
  /**
   * Sets `last_used_at` to database time only while the token is still unrevoked, unexpired, of
   * the expected kind with an active principal, and its last use is NULL or at least five minutes
   * old. True when a row changed. Call only after credential proof and a route allow.
   */
  touchToken(ctx: OrgContext, tokenId: string, kind: 'pat' | 'svc'): Promise<boolean>;
}

export interface AccessRepositoryOptions {
  readonly idleSeconds?: number;
}

type LooseDatabase = Record<string, Record<string, unknown>>;

const loose = db as unknown as Kysely<LooseDatabase>;
const looseEb = expressionBuilder<LooseDatabase, string>();

const SECRET_HASH = /^[0-9a-f]{64}$/;
const TOUCH_INTERVAL_SECONDS = 300;

const KNOWN_PERMISSIONS: readonly string[] = PERMISSIONS.map((entry) => entry.name);
const KNOWN_PROJECT_PERMISSIONS: readonly string[] = PERMISSIONS.filter(
  (entry) => entry.scope === 'project',
).map((entry) => entry.name);

const nowMs = sql<number>`cast(round(unixepoch('now', 'subsec') * 1000) as integer)`;

function instantMs(column: string) {
  return sql<number>`cast(round(unixepoch(${sql.ref(column)}, 'subsec') * 1000) as integer)`;
}

type ProjectOperand = Expression<string | null> | string | null;

export interface PermissionRowsOptions {
  /** Whether local-admin eligibility may carry an organization e-mail grant on a protected role. */
  readonly localAdmin?: Expression<SqlBool>;
}

function freshEvidence(column: string) {
  return sql<SqlBool>`${instantMs(column)} between ${nowMs} - ${sql.lit(EVIDENCE_MAX_AGE_MS)} and ${nowMs} + ${sql.lit(EVIDENCE_FUTURE_SKEW_MS)}`;
}

const ALIAS_NAMES = [
  'user',
  'grant',
  'role',
  'member',
  'identity',
  'binding',
  'login',
  'credential',
  'perm',
  'values',
  'anchors',
] as const;

type RowAlias = Record<(typeof ALIAS_NAMES)[number], string>;

function literals(values: readonly string[]) {
  return values.map((value) => sql.lit(value));
}

function branch(
  bindings: GuardBindings,
  creator: QueryCreator<LooseDatabase>,
  alias: RowAlias,
  kind: 'email' | 'group',
  scope: PermissionScopeName,
  userId: UserIdOperand,
  projectId: ProjectOperand,
  providers: readonly ProtectedHolderProvider[],
  localAdmin: Expression<SqlBool> | undefined,
) {
  const names = scope === 'organization' ? KNOWN_PERMISSIONS : KNOWN_PROJECT_PERMISSIONS;
  const grantOwner = kind === 'email' ? alias.user : alias.member;
  const base =
    kind === 'email'
      ? creator.selectFrom(`user_account as ${alias.user}`)
      : creator
          .selectFrom(`user_group as ${alias.member}`)
          .innerJoin(`user_account as ${alias.user}`, (join) =>
            join
              .onRef(`${alias.user}.id`, '=', `${alias.member}.user_id`)
              .onRef(`${alias.user}.org_id`, '=', `${alias.member}.org_id`),
          );

  const query = base
    .innerJoin(`access_grant as ${alias.grant}`, (join) => {
      let joined = join
        .onRef(`${alias.grant}.org_id`, '=', `${grantOwner}.org_id`)
        .on(`${alias.grant}.subject_type`, '=', sql.lit(kind))
        .on(`${alias.grant}.scope`, '=', sql.lit(scope));
      joined =
        kind === 'email'
          ? joined
              .on(sql<SqlBool>`${sql.ref(`${alias.grant}.subject_provider`)} is null`)
              .onRef(`${alias.grant}.subject_value`, '=', `${alias.user}.email`)
          : joined
              .onRef(`${alias.grant}.subject_provider`, '=', `${alias.member}.provider`)
              .onRef(`${alias.grant}.subject_value`, '=', `${alias.member}.group_name`);
      return scope === 'project'
        ? joined.on(`${alias.grant}.project_id`, '=', bound(bindings, 'project_id', projectId))
        : joined;
    })
    .innerJoin(`role as ${alias.role}`, (join) =>
      join
        .onRef(`${alias.role}.id`, '=', `${alias.grant}.role_id`)
        .onRef(`${alias.role}.org_id`, '=', `${alias.grant}.org_id`)
        .onRef(`${alias.role}.scope`, '=', `${alias.grant}.scope`),
    )
    .innerJoin(`role_permission as ${alias.perm}`, (join) =>
      join
        .onRef(`${alias.perm}.role_id`, '=', `${alias.role}.id`)
        .onRef(`${alias.perm}.org_id`, '=', `${alias.role}.org_id`),
    )
    .select([
      sql.lit(scope).as('scope'),
      `${alias.perm}.permission as permission`,
      `${alias.role}.protects_last_holder as protects`,
    ])
    .where(`${alias.user}.org_id`, '=', bindings.org)
    .where(`${alias.user}.id`, '=', bound(bindings, 'user_id', userId))
    .where(`${alias.user}.status`, '=', sql.lit('active'))
    .where(`${alias.perm}.permission`, 'in', literals(names));

  if (kind === 'group') {
    return query
      .where(sql<SqlBool>`${sql.ref(`${alias.member}.org_id`)} = ${bindings.org}`)
      .where(freshEvidence(`${alias.member}.refreshed_at`))
      .where((eb) =>
        eb.exists(
          boundVerifiedIdentity(bindings, alias, false)
            .whereRef(`${alias.identity}.provider`, '=', `${alias.member}.provider`)
            .where(freshEvidence(`${alias.identity}.validated_at`)),
        ),
      );
  }

  const authoritative = providers.some((entry) => entry.emailAuthoritative);
  return query.where((eb) => {
    const alternatives: Expression<SqlBool>[] = [];
    if (authoritative) {
      alternatives.push(eb.exists(boundVerifiedIdentity(bindings, alias, true)));
    }
    if (scope === 'organization' && localAdmin !== undefined) {
      alternatives.push(
        eb.and([
          typeof localAdmin === 'boolean'
            ? sql<SqlBool>`${sql.lit(localAdmin ? 1 : 0)}`
            : localAdmin,
          eb(`${alias.role}.protects_last_holder`, '=', sql.lit(1)),
          eb.exists(usableLocalLogin(bindings, alias)),
        ]),
      );
    }
    return alternatives.length === 0 ? sql<SqlBool>`0` : eb.or(alternatives);
  });
}

function bound(
  bindings: GuardBindings,
  column: string,
  operand: UserIdOperand | ProjectOperand,
): Expression<string> {
  return (typeof operand === 'string' ? bindings.value(column) : operand) as Expression<string>;
}

/**
 * The effective `(scope, permission, protects)` rows of one user: an e-mail branch UNION ALL a
 * group branch, each carrying the scope of the grant and `role.protects_last_holder`.
 * Organization-scope grants contribute every catalogue permission of their role; project-scope
 * grants of `projectId` contribute `project:*` names only, so they never carry organization
 * authority. Evidence freshness is database time. `userId` and `projectId` may be correlated
 * table-qualified column references.
 *
 * The organization, string ids and provider anchors bind once in a leading WITH of this select,
 * so its bound parameter count does not depend on the number of anchors or branches. Use the
 * result only as a derived table or a subquery, never as the right-hand member of a union: SQLite
 * accepts a WITH only at the head of a whole select.
 */
export function permissionRows(
  ctx: OrgContext,
  userId: UserIdOperand,
  projectId: ProjectOperand,
  providerAnchors: readonly ProtectedHolderProvider[],
  options: PermissionRowsOptions = {},
): SelectQueryBuilder<LooseDatabase, string, PermissionRow> {
  requireProviders(providerAnchors);
  const alias = guardAliases(ALIAS_NAMES, [
    referencedTable(userId),
    projectId === null ? null : referencedTable(projectId as UserIdOperand),
  ]);
  const values: Record<string, string> = { org_id: ctx.orgId };
  if (typeof userId === 'string') values.user_id = userId;
  if (typeof projectId === 'string') values.project_id = projectId;
  const bindings = guardBindings(
    { values: alias.values, anchors: alias.anchors },
    values,
    providerAnchors,
  );
  const localAdmin = options.localAdmin;
  const scopes: PermissionScopeName[] =
    projectId === null ? ['organization'] : ['organization', 'project'];
  const branches: SelectQueryBuilder<LooseDatabase, string, PermissionRow>[] = [];
  for (const scope of scopes) {
    for (const kind of providerAnchors.length > 0
      ? (['email', 'group'] as const)
      : (['email'] as const)) {
      const creator = branches.length === 0 ? bindings.creator : loose;
      branches.push(
        branch(
          bindings,
          creator,
          alias,
          kind,
          scope,
          userId,
          projectId,
          providerAnchors,
          localAdmin,
        ) as never,
      );
    }
  }
  const [first, ...rest] = branches;
  if (first === undefined) throw new TypeError('permissionRows has no branch');
  return rest.reduce((all, next) => all.unionAll(next) as never, first);
}

export interface HoldsPermissionInput {
  readonly userId: UserIdOperand;
  readonly permission: string;
  readonly projectId: ProjectOperand;
  readonly providerAnchors: readonly ProtectedHolderProvider[];
  /** `active` also requires the project to exist with status active; issue and grant writers use it. */
  readonly projectState: 'active' | 'any';
  /**
   * Session the acting user is using. Local-admin eligibility applies only when this session
   * exists in the organization, is not revoked and has no identity.
   */
  readonly session?: Expression<string> | string;
}

/**
 * An existence condition for `assertGuard` or a `where`: the user holds `permission` through the
 * organization grants plus, when `projectId` is set, that project's grants. Database time.
 *
 * One condition binds about a dozen parameters whatever the number of anchors. D1 refuses a
 * statement with more than 100; a guard combining more conditions than fit splits them, passing one
 * to `assertGuard` and each further one to its own `assertCheck` at the head of the mutations.
 */
export function holdsPermission(ctx: OrgContext, input: HoldsPermissionInput): Guard {
  if (!KNOWN_PERMISSIONS.includes(input.permission)) {
    throw new TypeError('permission is not in the catalogue');
  }
  if (input.projectState !== 'active' && input.projectState !== 'any') {
    throw new TypeError('projectState must be active or any');
  }
  const rowsAlias = 'hp_rows';
  const project = 'hp_project';
  const localSession = 'hp_session';
  const localAdmin =
    input.session === undefined
      ? undefined
      : sql<SqlBool>`exists ${loose
          .selectFrom(`session as ${localSession}`)
          .select(sql.lit(1).as('one'))
          .where(`${localSession}.org_id`, '=', ctx.orgId)
          .where(`${localSession}.id`, '=', input.session as string)
          .where(`${localSession}.revoked_at`, 'is', null)
          .where(`${localSession}.identity_id`, 'is', null)}`;
  const rows = permissionRows(ctx, input.userId, input.projectId, input.providerAnchors, {
    ...(localAdmin === undefined ? {} : { localAdmin }),
  });
  const held = sql<SqlBool>`exists ${loose
    .selectFrom(rows.as(rowsAlias))
    .select(sql.lit(1).as('one'))
    .where(`${rowsAlias}.permission`, '=', input.permission)}`;
  if (input.projectState === 'any' || input.projectId === null) return held;
  const active = sql<SqlBool>`exists ${loose
    .selectFrom(`project as ${project}`)
    .select(sql.lit(1).as('one'))
    .where(`${project}.org_id`, '=', ctx.orgId)
    .where(`${project}.id`, '=', input.projectId as string)
    .where(`${project}.status`, '=', sql.lit('active'))}`;
  return sql<SqlBool>`(${active} and ${held})`;
}

interface LookupRow {
  readonly session_id: string;
  readonly user_id: string;
  readonly identity_id: string | null;
  readonly csrf_hash: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly last_seen_at: string | null;
  readonly reauth_at: string | null;
  readonly user_email: string;
  readonly user_display_name: string | null;
  readonly identity_provider: string | null;
  readonly identity_email_verified: number | null;
  readonly identity_validated_at: string | null;
  readonly identity_fresh: number;
  readonly project_id: string | null;
  readonly project_slug: string | null;
  readonly project_name: string | null;
  readonly project_status: string | null;
  readonly project_token_max_scope: string | null;
  readonly project_require_publish_approval: number | null;
  readonly project_revision: number | null;
  readonly access: string;
}

function requireSecretHash(value: string): string {
  if (typeof value !== 'string' || !SECRET_HASH.test(value)) {
    throw new TypeError('secretHash must be 64 lowercase hexadecimal characters');
  }
  return value;
}

/** The single read behind `lookupSession`. */
export function lookupSessionStatement(
  ctx: OrgContext,
  input: SessionLookupInput,
  idleSeconds = DEFAULT_IDLE_SECONDS,
): Statement {
  requireSecretHash(input.secretHash);
  requireIdleSeconds(idleSeconds);
  if (input.boundary !== 'organization' && input.boundary !== 'project') {
    throw new TypeError('boundary must be organization or project');
  }
  if (input.projectSlug !== null && typeof input.projectSlug !== 'string') {
    throw new TypeError('projectSlug must be a string or null');
  }
  requireProviders(input.providerAnchors);
  const withProject = input.boundary === 'project' && input.projectSlug !== null;

  const projectOperand: ProjectOperand = withProject
    ? (looseEb.ref('p.id') as unknown as Expression<string | null>)
    : null;
  const userOperand = looseEb.ref('s.user_id') as unknown as Expression<string>;
  const rows = permissionRows(ctx, userOperand, projectOperand, input.providerAnchors, {
    localAdmin: sql<SqlBool>`s.identity_id is null`,
  });
  const access = loose.selectFrom(rows.as('pr')).select(
    sql<string>`json_object(
      'organization', json_group_array(distinct pr.permission) filter (where pr.scope = 'organization'),
      'project', json_group_array(distinct pr.permission) filter (where pr.scope = 'project'),
      'holder', coalesce(max(pr.scope = 'organization' and pr.protects = 1), 0)
    )`.as('access'),
  );

  let query = loose
    .selectFrom('session as s')
    .innerJoin('user_account as u', (join) =>
      join.onRef('u.id', '=', 's.user_id').onRef('u.org_id', '=', 's.org_id'),
    )
    .leftJoin('identity as i', (join) =>
      join
        .onRef('i.id', '=', 's.identity_id')
        .onRef('i.org_id', '=', 's.org_id')
        .onRef('i.user_id', '=', 's.user_id'),
    );

  const projectColumns = withProject
    ? [
        'p.id as project_id',
        'p.slug as project_slug',
        'p.name as project_name',
        'p.status as project_status',
        'p.token_max_scope as project_token_max_scope',
        'p.require_publish_approval as project_require_publish_approval',
        'p.revision as project_revision',
      ]
    : [
        sql`null`.as('project_id'),
        sql`null`.as('project_slug'),
        sql`null`.as('project_name'),
        sql`null`.as('project_status'),
        sql`null`.as('project_token_max_scope'),
        sql`null`.as('project_require_publish_approval'),
        sql`null`.as('project_revision'),
      ];
  if (withProject) {
    query = query.leftJoin('project as p', (join) =>
      join
        .onRef('p.org_id', '=', 's.org_id')
        .on('p.slug', '=', input.projectSlug as string)
        .on('p.status', '=', 'active'),
    );
  }

  const freshAlias = guardAliases(
    ['user', 'grant', 'role', 'member', 'identity', 'binding', 'login', 'credential'],
    ['s', 'u', 'i', 'p'],
  );
  const identityFresh =
    input.providerAnchors.length === 0
      ? sql<number>`0`
      : sql<number>`case when exists ${verifiedIdentity(
          ctx,
          { ...freshAlias, user: 'u' },
          input.providerAnchors,
          undefined,
        )
          .whereRef(`${freshAlias.identity}.id`, '=', 'i.id')
          .where(freshEvidence(`${freshAlias.identity}.validated_at`))} then 1 else 0 end`;

  const select = query
    .select([
      's.id as session_id',
      's.user_id as user_id',
      's.identity_id as identity_id',
      's.csrf_hash as csrf_hash',
      's.created_at as created_at',
      's.expires_at as expires_at',
      's.last_seen_at as last_seen_at',
      's.reauth_at as reauth_at',
      'u.email as user_email',
      'u.display_name as user_display_name',
      'i.provider as identity_provider',
      'i.email_verified as identity_email_verified',
      'i.validated_at as identity_validated_at',
      identityFresh.as('identity_fresh'),
      ...projectColumns,
      access.as('access'),
    ])
    .where('s.secret_hash', '=', input.secretHash)
    .where('s.org_id', '=', ctx.orgId)
    .where(sql<SqlBool>`(s.identity_id is null or i.id is not null)`)
    .where(liveSessionCondition('s', idleSeconds))
    .where('u.status', '=', 'active');

  return compile(select);
}

interface AccessJson {
  readonly organization?: unknown;
  readonly project?: unknown;
  readonly holder?: unknown;
  readonly visible?: unknown;
}

function names(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === 'string'))].sort();
}

function toAccess(row: LookupRow): SessionAccess {
  const access = JSON.parse(row.access) as AccessJson;
  return {
    session: {
      id: row.session_id,
      userId: row.user_id,
      identityId: row.identity_id,
      csrfHash: row.csrf_hash,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastSeenAt: row.last_seen_at,
      reauthAt: row.reauth_at,
    },
    user: { id: row.user_id, email: row.user_email, displayName: row.user_display_name },
    identity:
      row.identity_id === null || row.identity_provider === null
        ? null
        : {
            id: row.identity_id,
            provider: row.identity_provider,
            emailVerified: row.identity_email_verified === 1,
            validatedAt: row.identity_validated_at,
            fresh: row.identity_fresh === 1,
          },
    project:
      row.project_id === null
        ? null
        : {
            id: row.project_id,
            slug: row.project_slug ?? '',
            name: row.project_name ?? '',
            status: row.project_status ?? '',
            tokenMaxScope: row.project_token_max_scope ?? '',
            requirePublishApproval: row.project_require_publish_approval === 1,
            revision: row.project_revision ?? 1,
          },
    organizationPermissions: names(access.organization),
    projectPermissions: row.project_id === null ? [] : names(access.project),
    protectedHolder: access.holder === 1,
  };
}

interface TokenRow {
  readonly token_id: string;
  readonly kind: 'pat' | 'svc';
  readonly hash: string;
  readonly pepper_version: number;
  readonly token_name: string;
  readonly scopes_json: string;
  readonly read_only: number;
  readonly user_id: string | null;
  readonly service_principal_id: string | null;
  readonly token_project_id: string | null;
  readonly project_mode: string | null;
  readonly validation_kind: string | null;
  readonly validation_identity_id: string | null;
  readonly validation_fresh: number;
  readonly validation_evidence_at: string | null;
  readonly expires_at: string | null;
  readonly revoked_at: string | null;
  readonly last_used_at: string | null;
  readonly expired: number;
  readonly principal_status: string | null;
  readonly binding_ok: number;
  readonly principal_project_id: string | null;
  readonly visible_project_id: string | null;
  readonly service_visible: number;
  readonly project_id: string | null;
  readonly project_slug: string | null;
  readonly project_name: string | null;
  readonly project_status: string | null;
  readonly project_token_max_scope: string | null;
  readonly project_require_publish_approval: number | null;
  readonly project_revision: number | null;
  readonly access: string;
  readonly service_permissions: string;
}

const SELECTOR = /^[a-z2-7]{12}$/;

function requireSelector(value: string): string {
  if (typeof value !== 'string' || !SELECTOR.test(value)) {
    throw new TypeError('selector must be 12 characters from a-z and 2-7');
  }
  return value;
}

/** The single read behind `lookupToken`. */
export function lookupTokenStatement(ctx: OrgContext, input: TokenLookupInput): Statement {
  requireSelector(input.selector);
  if (input.boundary !== 'organization' && input.boundary !== 'project') {
    throw new TypeError('boundary must be organization or project');
  }
  if (input.projectSlug !== null && typeof input.projectSlug !== 'string') {
    throw new TypeError('projectSlug must be a string or null');
  }
  requireProviders(input.providerAnchors);
  const withProject = input.boundary === 'project' && input.projectSlug !== null;
  const nowSeconds = sql`unixepoch('now', 'subsec')`;

  const projectOperand: ProjectOperand = withProject
    ? (looseEb.ref('vp.id') as unknown as Expression<string | null>)
    : null;
  const userOperand = looseEb.ref('t.user_id') as unknown as Expression<string>;
  const rows = permissionRows(ctx, userOperand, projectOperand, input.providerAnchors, {
    localAdmin: sql<SqlBool>`t.validation_kind = 'local'`,
  });
  const projectNames = sql.join(literals(KNOWN_PROJECT_PERMISSIONS));
  const access = loose
    .selectFrom(rows.as('pr'))
    .select(
      sql<string>`json_object(
      'organization', json_group_array(distinct pr.permission) filter (where pr.scope = 'organization'),
      'project', json_group_array(distinct pr.permission) filter (where pr.scope = 'project'),
      'holder', coalesce(max(pr.scope = 'organization' and pr.protects = 1), 0),
      'visible', coalesce(max(pr.permission in (${projectNames})), 0)
    )`.as('access'),
    )
    .where(sql<SqlBool>`t.kind = 'pat'`);
  const servicePermissions = loose
    .selectFrom('service_principal_permission as spp')
    .select(sql<string>`json_group_array(distinct spp.permission)`.as('permissions'))
    .where('spp.org_id', '=', ctx.orgId)
    .whereRef('spp.service_principal_id', '=', 't.service_principal_id');

  const freshAlias = guardAliases(
    ['user', 'grant', 'role', 'member', 'identity', 'binding', 'login', 'credential'],
    ['t', 'u', 'sp', 'p'],
  );
  const holderAlias = { ...freshAlias, user: 'u' };
  const ssoFresh =
    input.providerAnchors.length === 0
      ? sql<SqlBool>`0`
      : sql<SqlBool>`exists ${verifiedIdentity(ctx, holderAlias, input.providerAnchors, undefined)
          .whereRef(`${freshAlias.identity}.id`, '=', 't.validation_identity_id')
          .where(freshEvidence(`${freshAlias.identity}.validated_at`))}`;
  const localFresh = sql<SqlBool>`exists ${usableLocalLogin(ctx, holderAlias).where(
    freshEvidence(`${freshAlias.login}.last_login_at`),
  )} and ${adminEligibility(ctx, looseEb.ref('u.id') as unknown as Expression<string>)}`;
  const validationFresh = sql<number>`case
    when t.kind = 'pat' and t.validation_kind = 'sso' then ${ssoFresh}
    when t.kind = 'pat' and t.validation_kind = 'local' and t.validation_identity_id is null then ${localFresh}
    else 0 end`;

  const validationEvidence = sql<string | null>`case
    when t.kind = 'pat' and t.validation_kind = 'sso' then (
      select ev_i.validated_at from identity ev_i
      where ev_i.org_id = ${ctx.orgId} and ev_i.id = t.validation_identity_id and ev_i.user_id = t.user_id)
    when t.kind = 'pat' and t.validation_kind = 'local' and t.validation_identity_id is null then (
      select ev_l.last_login_at from local_login ev_l
      where ev_l.org_id = ${ctx.orgId} and ev_l.user_id = t.user_id)
    else null end`;

  let query = loose
    .selectFrom('token as t')
    .leftJoin('user_account as u', (join) =>
      join.onRef('u.id', '=', 't.user_id').onRef('u.org_id', '=', 't.org_id'),
    )
    .leftJoin('service_principal as sp', (join) =>
      join.onRef('sp.id', '=', 't.service_principal_id').onRef('sp.org_id', '=', 't.org_id'),
    );

  const projectColumns = withProject
    ? [
        'p.id as project_id',
        'p.slug as project_slug',
        'p.name as project_name',
        'p.status as project_status',
        'p.token_max_scope as project_token_max_scope',
        'p.require_publish_approval as project_require_publish_approval',
        'p.revision as project_revision',
      ]
    : [
        sql`null`.as('project_id'),
        sql`null`.as('project_slug'),
        sql`null`.as('project_name'),
        sql`null`.as('project_status'),
        sql`null`.as('project_token_max_scope'),
        sql`null`.as('project_require_publish_approval'),
        sql`null`.as('project_revision'),
      ];
  const visibilityColumns = withProject
    ? [
        'vp.id as visible_project_id',
        sql<number>`case when t.kind = 'svc' and vp.id is not null
          and (sp.project_id is null or sp.project_id = vp.id)
          and exists (
            select 1 from service_principal_permission spv
            where spv.org_id = t.org_id and spv.service_principal_id = t.service_principal_id
              and spv.permission in (${projectNames})
          ) then 1 else 0 end`.as('service_visible'),
      ]
    : [sql`null`.as('visible_project_id'), sql`0`.as('service_visible')];
  if (withProject) {
    query = query.leftJoin('project as vp', (join) =>
      join
        .onRef('vp.org_id', '=', 't.org_id')
        .on('vp.slug', '=', input.projectSlug as string)
        .on('vp.status', '=', sql.lit('active')),
    );
    query = query.leftJoin('project as p', (join) =>
      join
        .onRef('p.org_id', '=', 't.org_id')
        .on('p.slug', '=', input.projectSlug as string)
        .on('p.status', '=', 'active')
        .on(
          sql<SqlBool>`(
            (t.kind = 'pat' and t.project_id is null and t.project_mode = 'all')
            or (t.kind = 'pat' and t.project_id is null and t.project_mode = 'selected' and exists (
              select 1 from token_project tp
              where tp.token_id = t.id and tp.org_id = t.org_id and tp.project_id = p.id
            ))
            or (t.kind = 'svc' and t.project_id is sp.project_id and (sp.project_id is null or sp.project_id = p.id))
          )`,
        ),
    );
  }

  const select = query
    .select([
      't.id as token_id',
      't.kind as kind',
      't.hash as hash',
      't.pepper_version as pepper_version',
      't.name as token_name',
      't.scopes_json as scopes_json',
      't.read_only as read_only',
      't.user_id as user_id',
      't.service_principal_id as service_principal_id',
      't.project_id as token_project_id',
      't.project_mode as project_mode',
      't.validation_kind as validation_kind',
      't.validation_identity_id as validation_identity_id',
      validationFresh.as('validation_fresh'),
      validationEvidence.as('validation_evidence_at'),
      't.expires_at as expires_at',
      't.revoked_at as revoked_at',
      't.last_used_at as last_used_at',
      sql<number>`case when unixepoch(t.expires_at, 'subsec') > ${nowSeconds} then 0 else 1 end`.as(
        'expired',
      ),
      sql<string | null>`case t.kind when 'pat' then u.status else sp.status end`.as(
        'principal_status',
      ),
      sql<number>`case t.kind when 'svc' then (t.project_id is sp.project_id) else (t.project_id is null) end`.as(
        'binding_ok',
      ),
      'sp.project_id as principal_project_id',
      ...visibilityColumns,
      ...projectColumns,
      access.as('access'),
      servicePermissions.as('service_permissions'),
    ])
    .where('t.selector', '=', input.selector)
    .where('t.org_id', '=', ctx.orgId)
    .where('t.kind', 'in', ['pat', 'svc']);

  return compile(select);
}

function parsedScope(row: TokenRow): TokenAccess['token']['scope'] {
  const parsed = parseScopesJson(row.scopes_json);
  if (!parsed.ok) return null;
  const readOnly = parsed.level === 'read';
  if ((row.read_only === 1) !== readOnly) return null;
  return { level: parsed.level, readOnly };
}

export function tokenProjectMode(
  kind: 'pat' | 'svc',
  stored: string | null,
  principalProjectId: string | null,
): TokenProjectMode | null {
  if (kind === 'svc') return principalProjectId === null ? 'all' : 'selected';
  return stored === 'all' || stored === 'selected' ? stored : null;
}

function toTokenAccess(row: TokenRow, boundary: AccessBoundary): TokenAccess {
  const scope = parsedScope(row);
  const projectMode = tokenProjectMode(row.kind, row.project_mode, row.principal_project_id);
  const isService = row.kind === 'svc';
  const expired = row.expired === 1;
  const revoked = row.revoked_at !== null;
  const principalActive = row.principal_status === 'active';
  const credentialValid = row.binding_ok === 1 && (isService || row.validation_fresh === 1);
  const project: AccessProject | null =
    row.project_id === null
      ? null
      : {
          id: row.project_id,
          slug: row.project_slug ?? '',
          name: row.project_name ?? '',
          status: row.project_status ?? '',
          tokenMaxScope: row.project_token_max_scope ?? '',
          requirePublishApproval: row.project_require_publish_approval === 1,
          revision: row.project_revision ?? 1,
        };

  let organizationPermissions: string[] = [];
  let projectPermissions: string[] = [];
  let protectedHolder = false;
  let projectVisible = false;
  if (
    boundary === 'project' &&
    row.visible_project_id !== null &&
    !expired &&
    !revoked &&
    principalActive &&
    (isService || row.validation_fresh === 1)
  ) {
    projectVisible = isService
      ? row.service_visible === 1
      : (JSON.parse(row.access) as AccessJson).visible === 1;
  }
  if (
    !expired &&
    !revoked &&
    principalActive &&
    credentialValid &&
    scope !== null &&
    projectMode !== null
  ) {
    const stored = JSON.parse(row.access) as AccessJson;
    const orgRows = names(stored.organization);
    const projectRows = names(stored.project);
    protectedHolder =
      !isService && scope.level === 'full' && projectMode === 'all' && stored.holder === 1;
    const service = names(JSON.parse(row.service_permissions));
    if (boundary === 'organization') {
      organizationPermissions = [
        ...tokenEffectivePermissions({
          boundary: 'organization',
          grants: isService ? service : orgRows,
          projectMode,
          scope,
        }),
      ].sort();
    } else if (project !== null) {
      const maxScope = parseScopeLevel(project.tokenMaxScope);
      if (maxScope.ok) {
        projectPermissions = [
          ...tokenEffectivePermissions({
            boundary: 'project',
            grants: isService ? service : [...orgRows, ...projectRows],
            projectMode,
            scope,
            tokenMaxScope: maxScope.level,
          }),
        ].sort();
      }
    }
  }

  const envelope: Omit<TokenAccess, 'verifier'> = {
    token: {
      id: row.token_id,
      kind: row.kind,
      name: row.token_name,
      userId: row.user_id,
      servicePrincipalId: row.service_principal_id,
      boundProjectId: row.token_project_id,
      projectMode,
      scope,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      lastUsedAt: row.last_used_at,
      expired,
      revoked,
    },
    principalStatus: row.principal_status ?? '',
    validation:
      row.kind === 'svc'
        ? null
        : {
            kind:
              row.validation_kind === 'sso' || row.validation_kind === 'local'
                ? row.validation_kind
                : null,
            identityId: row.validation_identity_id,
            fresh: row.validation_fresh === 1,
            evidenceAt: row.validation_evidence_at,
          },
    project,
    organizationPermissions,
    projectPermissions,
    protectedHolder,
    projectVisible,
  };
  return Object.defineProperty(envelope, 'verifier', {
    value: { secretHash: row.hash, pepperVersion: row.pepper_version },
    enumerable: false,
  }) as TokenAccess;
}

export function createAccessRepository(
  executor: SqlExecutor,
  options: AccessRepositoryOptions = {},
): AccessRepository {
  const idleSeconds = requireIdleSeconds(options.idleSeconds ?? DEFAULT_IDLE_SECONDS);
  return {
    async lookupSession(ctx, input) {
      const rows = await executor.all<LookupRow>(lookupSessionStatement(ctx, input, idleSeconds));
      const row = rows[0];
      return row === undefined ? null : toAccess(row);
    },

    async lookupToken(ctx, input) {
      const rows = await executor.all<TokenRow>(lookupTokenStatement(ctx, input));
      const row = rows[0];
      return row === undefined ? null : toTokenAccess(row, input.boundary);
    },

    async touchSession(ctx, sessionId) {
      const rows = await executor.all<{ id: string }>(
        compile(
          loose
            .updateTable('session')
            .set({ last_seen_at: sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` })
            .where('org_id', '=', ctx.orgId)
            .where('id', '=', sessionId)
            .where(liveSessionCondition('session', idleSeconds))
            .where(
              sql<SqlBool>`unixepoch(coalesce(last_seen_at, created_at), 'subsec') < unixepoch('now', 'subsec') - ${TOUCH_INTERVAL_SECONDS}`,
            )
            .where(
              sql<SqlBool>`exists (select 1 from user_account where user_account.id = session.user_id and user_account.org_id = session.org_id and user_account.status = 'active')`,
            )
            .returning('id'),
        ),
      );
      return rows.length > 0;
    },

    async touchToken(ctx, tokenId, kind) {
      const rows = await executor.all<{ id: string }>(
        compile(
          loose
            .updateTable('token')
            .set({ last_used_at: sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` })
            .where('org_id', '=', ctx.orgId)
            .where('id', '=', tokenId)
            .where('kind', '=', kind)
            .where('revoked_at', 'is', null)
            .where(
              sql<SqlBool>`(expires_at is null or unixepoch(expires_at, 'subsec') > unixepoch('now', 'subsec'))`,
            )
            .where(
              sql<SqlBool>`(last_used_at is null or unixepoch(last_used_at, 'subsec') is null or unixepoch(last_used_at, 'subsec') < unixepoch('now', 'subsec') - ${TOUCH_INTERVAL_SECONDS})`,
            )
            .where(
              sql<SqlBool>`(
                (token.kind = 'pat' and exists (select 1 from user_account where user_account.id = token.user_id and user_account.org_id = token.org_id and user_account.status = 'active'))
                or (token.kind = 'svc' and exists (select 1 from service_principal where service_principal.id = token.service_principal_id and service_principal.org_id = token.org_id and service_principal.status = 'active'))
              )`,
            )
            .returning('id'),
        ),
      );
      return rows.length > 0;
    },
  };
}
