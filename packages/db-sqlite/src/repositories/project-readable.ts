import { sql, type Kysely, type SelectQueryBuilder, type SqlBool } from 'kysely';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { isUlid } from '@package-broker/core/ids';
import {
  PROJECT_LIST_MAX_LIMIT,
  type ProjectListEntry,
  type ReadableProjectPage,
  type ReadableProjectSource,
} from '@package-broker/core/authz/project-list';
import {
  compile,
  db,
  EVIDENCE_FUTURE_SKEW_MS,
  EVIDENCE_MAX_AGE_MS,
  requireProviders,
  authoritativeVerifiedIdentity,
  verifiedIdentity,
  type HolderAlias,
  type ProtectedHolderProvider,
} from '../kysely.js';

export interface ReadableProjectActor {
  readonly userId: string;
}

export interface ReadableProjectRepositoryOptions {
  readonly providerAnchors?: readonly ProtectedHolderProvider[];
}

type LooseDatabase = Record<string, Record<string, unknown>>;

const loose = db as unknown as Kysely<LooseDatabase>;

const READ = 'project:read';

interface ReadableRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: ProjectListEntry['status'];
}

function requirePage(page: ReadableProjectPage): void {
  if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > PROJECT_LIST_MAX_LIMIT) {
    throw new TypeError(`limit must be an integer from 1 to ${PROJECT_LIST_MAX_LIMIT}`);
  }
  if (page.afterId !== undefined && (typeof page.afterId !== 'string' || !isUlid(page.afterId))) {
    throw new TypeError('afterId must be a ULID');
  }
  if (
    page.ids !== undefined &&
    (!Array.isArray(page.ids) || page.ids.length > 50 || !page.ids.every(isUlid))
  ) {
    throw new TypeError('ids must contain at most 50 ULIDs');
  }
  if (page.status !== 'active' && page.status !== 'archived') {
    throw new TypeError('status must be active or archived');
  }
}

/** Keeps the planner off an index led by this column, so it uses the primary key instead. */
function unindexed(column: string) {
  return sql<string>`+${sql.ref(column)}`;
}

const nowMs = sql<number>`cast(round(unixepoch('now', 'subsec') * 1000) as integer)`;

/** The evidence window `permissionRows` applies, on database time. */
function freshEvidence(column: string) {
  return sql<SqlBool>`cast(round(unixepoch(${sql.ref(column)}, 'subsec') * 1000) as integer) between ${nowMs} - ${sql.lit(EVIDENCE_MAX_AGE_MS)} and ${nowMs} + ${sql.lit(EVIDENCE_FUTURE_SKEW_MS)}`;
}

function holderAlias(user: string, prefix: string): HolderAlias {
  return {
    user,
    grant: `${prefix}_grant`,
    role: `${prefix}_role`,
    member: `${prefix}_member`,
    identity: `${prefix}_identity`,
    binding: `${prefix}_binding`,
    login: `${prefix}_login`,
    credential: `${prefix}_credential`,
  };
}

const PROJECT_COLUMNS = ['id', 'slug', 'name', 'status'] as const;

/**
 * One grant path: the user's project-scope grant rows, each joined by primary key to its role, the
 * role's `project:read` row and its project, with the same subject match and evidence `permissionRows`
 * applies to a project-scope grant. Only the matched grant row is evaluated per project.
 */
function grantPath(
  kind: 'email' | 'group',
  ctx: OrgContext,
  userId: string,
  page: ReadableProjectPage,
  providerAnchors: readonly ProtectedHolderProvider[],
) {
  const [u, g, r, perm, p, m] =
    kind === 'email' ? ['eu', 'ge', 'er', 'ep', 'pe', 'em'] : ['gu', 'gg', 'gr', 'gp', 'pg', 'gm'];
  const start =
    kind === 'email'
      ? loose.selectFrom(`user_account as ${u}`)
      : loose
          .selectFrom(`user_group as ${m}`)
          .crossJoin(`user_account as ${u}`)
          .where(`${m}.user_id`, '=', userId)
          .where(unindexed(`${m}.org_id`), '=', ctx.orgId)
          .whereRef(`${u}.id`, '=', `${m}.user_id`)
          .where(freshEvidence(`${m}.refreshed_at`));
  let query = start
    .crossJoin(`access_grant as ${g}`)
    .crossJoin(`role as ${r}`)
    .crossJoin(`role_permission as ${perm}`)
    .crossJoin(`project as ${p}`)
    .select(PROJECT_COLUMNS.map((column) => `${p}.${column} as ${column}`))
    .distinct()
    .where(`${u}.id`, '=', userId)
    .where(`${u}.org_id`, '=', ctx.orgId)
    .where(`${u}.status`, '=', sql.lit('active'))
    .where(`${g}.org_id`, '=', ctx.orgId)
    .where(`${g}.subject_type`, '=', sql.lit(kind))
    .where(`${g}.scope`, '=', sql.lit('project'))
    .whereRef(`${r}.id`, '=', `${g}.role_id`)
    .whereRef(`${r}.org_id`, '=', `${g}.org_id`)
    .where(`${r}.scope`, '=', sql.lit('project'))
    .whereRef(`${perm}.role_id`, '=', `${r}.id`)
    .where(`${perm}.permission`, '=', sql.lit(READ))
    .whereRef(`${perm}.org_id`, '=', `${r}.org_id`)
    .whereRef(`${p}.id`, '=', `${g}.project_id`)
    .where(unindexed(`${p}.org_id`), '=', ctx.orgId)
    .where(unindexed(`${p}.status`), '=', page.status);
  query =
    kind === 'email'
      ? query
          .where(`${g}.subject_provider`, 'is', null)
          .whereRef(`${g}.subject_value`, '=', `${u}.email`)
      : query
          .whereRef(`${g}.subject_provider`, '=', `${m}.provider`)
          .whereRef(`${g}.subject_value`, '=', `${m}.group_name`);
  if (page.ids !== undefined) {
    query = query.where(
      sql<SqlBool>`${sql.ref(`${g}.project_id`)} in (select value from json_each(${JSON.stringify(page.ids)}))`,
    );
  }
  if (page.afterId !== undefined) query = query.where(`${g}.project_id`, '>', page.afterId);

  const alias = holderAlias(u, `${kind}_evidence`);
  const evidence =
    kind === 'email'
      ? authoritativeVerifiedIdentity(ctx, alias, providerAnchors)
      : verifiedIdentity(ctx, alias, providerAnchors, undefined)
          .whereRef(`${alias.identity}.provider`, '=', `${m}.provider`)
          .where(freshEvidence(`${alias.identity}.validated_at`));
  return query
    .where((eb) => eb.exists(evidence))
    .orderBy(`${p}.id`)
    .limit(page.limit);
}

/**
 * The single read behind `listReadableProjects`: the projects of one status after `afterId`, in id
 * order, on which the user holds `project:read` through that project's own grants, as
 * `permissionRows` resolves project-scope grants. Organization grants are not read: a caller whose
 * organization permissions carry `project:read` sees every project and needs no filtered source.
 *
 * Each path starts from the user and its group memberships and reaches every grant by the full
 * `access_grant_subject` key, so the cost follows the user's own grants, never the organization's
 * project or grant count, with or without planner statistics.
 */
export function listReadableProjectsStatement(
  ctx: OrgContext,
  actor: ReadableProjectActor,
  page: ReadableProjectPage,
  providerAnchors: readonly ProtectedHolderProvider[],
): Statement {
  if (typeof actor.userId !== 'string' || actor.userId === '') {
    throw new TypeError('userId must be a non-empty string');
  }
  requirePage(page);
  requireProviders(providerAnchors);
  const { userId } = actor;

  const paths: SelectQueryBuilder<LooseDatabase, string, ReadableRow>[] = [];
  if (providerAnchors.some((entry) => entry.emailAuthoritative)) {
    paths.push(grantPath('email', ctx, userId, page, providerAnchors) as never);
  }
  if (providerAnchors.length > 0) {
    paths.push(grantPath('group', ctx, userId, page, providerAnchors) as never);
  }
  if (paths.length === 0) {
    return compile(
      loose
        .selectFrom('project as pn')
        .select(PROJECT_COLUMNS.map((column) => `pn.${column} as ${column}`))
        .where(sql<SqlBool>`0`),
    );
  }
  const [first, ...rest] = paths.map((path, index) =>
    loose.selectFrom(path.as(`path_${index}`)).selectAll(),
  );
  const union = rest.reduce((all, next) => all.union(next) as never, first as never) as never;

  return compile(
    loose
      .selectFrom((union as SelectQueryBuilder<LooseDatabase, string, ReadableRow>).as('readable'))
      .select(['readable.id', 'readable.slug', 'readable.name', 'readable.status'])
      .orderBy('readable.id')
      .limit(page.limit),
  );
}

export interface ReadableProjectRepository extends ReadableProjectSource {
  listReadableProjects(
    ctx: OrgContext,
    actor: ReadableProjectActor,
    page: ReadableProjectPage,
  ): Promise<readonly ProjectListEntry[]>;
}

export function createReadableProjectRepository(
  executor: SqlExecutor,
  options: ReadableProjectRepositoryOptions = {},
): ReadableProjectRepository {
  const providerAnchors = options.providerAnchors ?? [];
  requireProviders(providerAnchors);
  return {
    async listReadableProjects(ctx, actor, page) {
      const rows = await executor.all<ReadableRow>(
        listReadableProjectsStatement(ctx, actor, page, providerAnchors),
      );
      return rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        name: row.name,
        status: row.status,
      }));
    },
  };
}
