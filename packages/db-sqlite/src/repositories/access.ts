import {
  expressionBuilder,
  sql,
  type Expression,
  type Kysely,
  type SelectQueryBuilder,
  type SqlBool,
} from 'kysely';
import { PERMISSIONS } from '@package-broker/core/authz/permissions';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import {
  compile,
  db,
  EVIDENCE_FUTURE_SKEW_MS,
  EVIDENCE_MAX_AGE_MS,
  guardAliases,
  referencedTable,
  requireProviders,
  usableLocalLogin,
  verifiedIdentity,
  type Guard,
  type ProtectedHolderProvider,
  type UserIdOperand,
} from '../kysely.js';

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
}

export interface AccessRepositoryOptions {
  readonly idleSeconds?: number;
}

type LooseDatabase = Record<string, Record<string, unknown>>;

const loose = db as unknown as Kysely<LooseDatabase>;
const looseEb = expressionBuilder<LooseDatabase, string>();

const SECRET_HASH = /^[0-9a-f]{64}$/;
const TOUCH_INTERVAL_SECONDS = 300;
const DEFAULT_IDLE_SECONDS = 3600;

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
  return sql<SqlBool>`${instantMs(column)} between ${nowMs} - ${EVIDENCE_MAX_AGE_MS} and ${nowMs} + ${EVIDENCE_FUTURE_SKEW_MS}`;
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
] as const;

type RowAlias = Record<(typeof ALIAS_NAMES)[number], string>;

function branch(
  ctx: OrgContext,
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
      ? loose.selectFrom(`user_account as ${alias.user}`)
      : loose
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
        .on(`${alias.grant}.subject_type`, '=', kind)
        .on(`${alias.grant}.scope`, '=', scope);
      joined =
        kind === 'email'
          ? joined
              .on(sql<SqlBool>`${sql.ref(`${alias.grant}.subject_provider`)} is null`)
              .onRef(`${alias.grant}.subject_value`, '=', `${alias.user}.email`)
          : joined
              .onRef(`${alias.grant}.subject_provider`, '=', `${alias.member}.provider`)
              .onRef(`${alias.grant}.subject_value`, '=', `${alias.member}.group_name`);
      return scope === 'project'
        ? joined.on(`${alias.grant}.project_id`, '=', projectId as string)
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
    .where(`${alias.user}.org_id`, '=', ctx.orgId)
    .where(`${alias.user}.id`, '=', userId)
    .where(`${alias.user}.status`, '=', 'active')
    .where(`${alias.perm}.permission`, 'in', names);

  if (kind === 'group') {
    return query
      .where(sql<SqlBool>`${sql.ref(`${alias.member}.org_id`)} = ${ctx.orgId}`)
      .where(freshEvidence(`${alias.member}.refreshed_at`))
      .where((eb) =>
        eb.exists(
          verifiedIdentity(ctx, alias, providers, undefined)
            .whereRef(`${alias.identity}.provider`, '=', `${alias.member}.provider`)
            .where(freshEvidence(`${alias.identity}.validated_at`)),
        ),
      );
  }

  const authoritative = providers.filter((entry) => entry.emailAuthoritative);
  return query.where((eb) => {
    const alternatives: Expression<SqlBool>[] = [];
    if (authoritative.length > 0) {
      alternatives.push(eb.exists(verifiedIdentity(ctx, alias, authoritative, undefined)));
    }
    if (scope === 'organization' && localAdmin !== undefined) {
      alternatives.push(
        eb.and([
          typeof localAdmin === 'boolean'
            ? sql<SqlBool>`${sql.lit(localAdmin ? 1 : 0)}`
            : localAdmin,
          eb(`${alias.role}.protects_last_holder`, '=', 1),
          eb.exists(usableLocalLogin(ctx, alias)),
        ]),
      );
    }
    return alternatives.length === 0 ? sql<SqlBool>`0` : eb.or(alternatives);
  });
}

/**
 * The effective `(scope, permission, protects)` rows of one user: an e-mail branch UNION ALL a
 * group branch, each carrying the scope of the grant and `role.protects_last_holder`.
 * Organization-scope grants contribute every catalogue permission of their role; project-scope
 * grants of `projectId` contribute `project:*` names only, so they never carry organization
 * authority. Evidence freshness is database time. `userId` and `projectId` may be correlated
 * table-qualified column references.
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
  const localAdmin = options.localAdmin;
  const scopes: PermissionScopeName[] =
    projectId === null ? ['organization'] : ['organization', 'project'];
  const branches: SelectQueryBuilder<LooseDatabase, string, PermissionRow>[] = [];
  for (const scope of scopes) {
    branches.push(
      branch(ctx, alias, 'email', scope, userId, projectId, providerAnchors, localAdmin) as never,
    );
    if (providerAnchors.length > 0) {
      branches.push(
        branch(ctx, alias, 'group', scope, userId, projectId, providerAnchors, localAdmin) as never,
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
    .where(`${project}.status`, '=', 'active')}`;
  return sql<SqlBool>`${active} and ${held}`;
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

function requireIdleSeconds(value: number): number {
  if (!Number.isInteger(value) || value < 60 || value > 86400) {
    throw new RangeError('idleSeconds must be an integer from 60 to 86400');
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
  const nowSeconds = sql`unixepoch('now', 'subsec')`;

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
    .where('s.revoked_at', 'is', null)
    .where(sql<SqlBool>`(s.identity_id is null or i.id is not null)`)
    .where(sql<SqlBool>`unixepoch(s.expires_at, 'subsec') > ${nowSeconds}`)
    .where(
      sql<SqlBool>`unixepoch(coalesce(s.last_seen_at, s.created_at), 'subsec') > ${nowSeconds} - ${idleSeconds}`,
    )
    .where('u.status', '=', 'active');

  return compile(select);
}

interface AccessJson {
  readonly organization?: unknown;
  readonly project?: unknown;
  readonly holder?: unknown;
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

    async touchSession(ctx, sessionId) {
      const rows = await executor.all<{ id: string }>(
        compile(
          loose
            .updateTable('session')
            .set({ last_seen_at: sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` })
            .where('org_id', '=', ctx.orgId)
            .where('id', '=', sessionId)
            .where('revoked_at', 'is', null)
            .where(sql<SqlBool>`unixepoch(expires_at, 'subsec') > unixepoch('now', 'subsec')`)
            .where(
              sql<SqlBool>`unixepoch(coalesce(last_seen_at, created_at), 'subsec') > unixepoch('now', 'subsec') - ${idleSeconds}`,
            )
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
  };
}
