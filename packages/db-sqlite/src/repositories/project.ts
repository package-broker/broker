import type { IdempotencyRecord } from '@package-broker/core/api/idempotency';
import type { AuditEvent } from '@package-broker/core/audit/actions';
import { expressionBuilder, sql, type Compilable, type SqlBool } from 'kysely';
import { type FailureProbes, type MutationFence } from '@package-broker/core/authz/fence';
import {
  isValidProjectSlug,
  projectSlugProblem,
  reservedFirstSegments,
} from '@package-broker/core/authz/project-path';
import { PROJECT_LIST_MAX_LIMIT } from '@package-broker/core/authz/project-list';
import {
  PROJECT_NAME_MAX_LENGTH,
  TOKEN_MAX_SCOPES,
  type ProjectStatus,
  type ProjectStore,
  type TokenMaxScope,
} from '@package-broker/core/authz/project-service';
import type { OrgContext, ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import { isUlid, ulid } from '@package-broker/core/ids';
import {
  assertCheck,
  assertGuard,
  compile,
  db,
  existsGuard,
  newOpId,
  runOrgFenced,
  type Database,
  type Guard,
  type ProtectedHolderProvider,
} from '../kysely.js';
import { holdsPermission, permissionRows } from './access.js';
import { auditPendingStatement } from './audit-pending.js';
import { idempotencyInsertStatement, liveIdempotencyCollision } from './idempotency.js';
import { projectPrefixCondition } from '../sql/project-prefix.js';
import { attachSourceStatements } from './visibility-attach.js';
import {
  DEFAULT_IDLE_SECONDS,
  liveSessionCondition,
  requireIdleSeconds,
} from './session-liveness.js';

export interface Project {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: ProjectStatus;
  readonly tokenMaxScope: TokenMaxScope;
  readonly requirePublishApproval: boolean;
  readonly revision: number;
}

export interface ProjectRepositoryOptions {
  /** Slugs refused in addition to the first segments of the core route table. */
  readonly reservedSlugs?: Iterable<string>;
  /** Provider anchors that make group grants count toward the in-batch authority check. */
  readonly providerAnchors?: readonly ProtectedHolderProvider[];
  readonly idleSeconds?: number;
}

/**
 * Every write derives its authority from the fence, inside the decisive batch: the actor is active,
 * the session is live and owned by the actor, and the permission is held. A refusing batch rolls
 * back and answers `authority`. `conflict` means the fence's expected `project` revision is stale.
 * `not_found` and `conflict` are only answered to an actor that holds the permission.
 */
export interface ProjectRepository extends ProjectStore {
  get(ctx: OrgContext, id: string): Promise<Project | null>;
  /** Returns archived projects too unless `activeOnly` is set. */
  getBySlug(
    ctx: OrgContext,
    slug: string,
    options?: { readonly activeOnly?: boolean },
  ): Promise<Project | null>;
  /** Ordered by id; `limit` is 1 to 200 (TypeError otherwise). */
  list(
    ctx: OrgContext,
    page: {
      readonly q?: string;
      readonly afterId?: string;
      readonly limit: number;
      readonly status?: ProjectStatus;
      readonly ids?: readonly string[];
    },
  ): Promise<Project[]>;
  /**
   * Requires org:projects:create. One fenced batch inserts the active project and the actor's
   * e-mail grant on the initial role; either both land or neither. The role must be project-scoped
   * and every permission it carries must be held by the actor at organization scope, otherwise
   * `initial_role_not_allowed`. `duplicate` covers an existing slug or id of this organization.
   * TypeError for a malformed id, name or `now`; ProjectSetupError when the stored project_owner
   * role or the acting user is missing.
   */
  create(
    ctx: OrgContext,
    fence: MutationFence,
    input: Parameters<ProjectStore['create']>[2],
  ): Promise<
    | 'created'
    | 'conflict'
    | 'duplicate'
    | 'invalid_slug'
    | 'reserved_slug'
    | 'initial_role_not_allowed'
    | 'authority'
    | 'indeterminate'
  >;
  /**
   * Requires project:settings:write and the fence's expected `project` revision (TypeError when
   * absent). `unchanged` means the values already match and nothing was written. The slug is never
   * touched.
   */
  update(
    ctx: OrgContext,
    fence: MutationFence,
    input: Parameters<ProjectStore['update']>[2],
  ): Promise<
    'updated' | 'unchanged' | 'archived' | 'not_found' | 'conflict' | 'authority' | 'indeterminate'
  >;
  /** Requires org:projects:archive. Keeps the row and its slug. */
  archive(
    ctx: OrgContext,
    fence: MutationFence,
    input: Parameters<ProjectStore['archive']>[2],
  ): Promise<'archived' | 'not_active' | 'not_found' | 'conflict' | 'authority' | 'indeterminate'>;
  /** Requires org:projects:archive and a session reauthenticated within the last ten minutes. */
  restore(
    ctx: OrgContext,
    fence: MutationFence,
    input: Parameters<ProjectStore['restore']>[2],
  ): Promise<
    | 'restored'
    | 'not_archived'
    | 'not_found'
    | 'conflict'
    | 'authority'
    | 'reauth_required'
    | 'indeterminate'
  >;
}

interface ProjectRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: string;
  readonly token_max_scope: string;
  readonly require_publish_approval: number;
  readonly revision: number;
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FORBIDDEN_NAME_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;
const REAUTH_SECONDS = 600;

/** The stored project_owner role of the organization is missing. */
export class ProjectSetupError extends Error {}

const eb = expressionBuilder<Database>();

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

function requireId(value: string, label: string): void {
  if (typeof value !== 'string' || !isUlid(value)) {
    throw new TypeError(`${label} must be a ULID`);
  }
}

function requireName(name: string): void {
  const length = typeof name === 'string' ? [...name].length : 0;
  if (length < 1 || length > PROJECT_NAME_MAX_LENGTH || FORBIDDEN_NAME_CHARACTERS.test(name)) {
    throw new TypeError(
      `project name must be 1 to ${PROJECT_NAME_MAX_LENGTH} printable characters`,
    );
  }
}

function requireScope(scope: string): void {
  if (!(TOKEN_MAX_SCOPES as readonly string[]).includes(scope)) {
    throw new TypeError('tokenMaxScope must be read, write or full');
  }
}

function expectedRevision(fence: MutationFence): number {
  const expected = fence.expected['project'];
  if (expected === undefined) {
    throw new TypeError('fence must carry an expected project revision');
  }
  return expected;
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status as ProjectStatus,
    tokenMaxScope: row.token_max_scope as TokenMaxScope,
    requirePublishApproval: row.require_publish_approval === 1,
    revision: row.revision,
  };
}

function selectProjects(ctx: OrgContext) {
  return db
    .selectFrom('project')
    .select([
      'id',
      'slug',
      'name',
      'status',
      'token_max_scope',
      'require_publish_approval',
      'revision',
    ])
    .where('org_id', '=', ctx.orgId);
}

type Failure = 'authority' | 'conflict' | 'collision' | 'indeterminate';

function failure(reason: string): Failure {
  if (
    reason === 'authority' ||
    reason === 'conflict' ||
    reason === 'collision' ||
    reason === 'indeterminate'
  ) {
    return reason;
  }
  throw new Error(`project mutation failed unclassified (${reason})`);
}

export function createProjectRepository(
  executor: ScalarSqlExecutor,
  options: ProjectRepositoryOptions = {},
): ProjectRepository {
  const reserved: ReadonlySet<string> = new Set([
    ...reservedFirstSegments([]),
    ...(options.reservedSlugs ?? []),
  ]);
  const providerAnchors = options.providerAnchors ?? [];
  const idleSeconds = requireIdleSeconds(options.idleSeconds ?? DEFAULT_IDLE_SECONDS);

  function authorityParts(
    ctx: OrgContext,
    fence: MutationFence,
    permission: string,
    scope: { readonly projectId?: string } = {},
  ): { readonly base: Guard; readonly fresh: Guard } {
    const session = existsGuard((database) =>
      database
        .selectFrom('session as s')
        .innerJoin('user_account as actor', (join) =>
          join.onRef('actor.id', '=', 's.user_id').onRef('actor.org_id', '=', 's.org_id'),
        )
        .leftJoin('identity as i', (join) =>
          join
            .onRef('i.id', '=', 's.identity_id')
            .onRef('i.org_id', '=', 's.org_id')
            .onRef('i.user_id', '=', 's.user_id'),
        )
        .select('s.id')
        .where(sql<SqlBool>`(s.identity_id is null or i.id is not null)`)
        .where('s.org_id', '=', ctx.orgId)
        .where('s.id', '=', fence.sessionId)
        .where('s.user_id', '=', fence.userId)
        .where('actor.status', '=', 'active')
        .where(liveSessionCondition('s', idleSeconds)),
    );
    const held = holdsPermission(ctx, {
      userId: fence.userId,
      permission,
      projectId: scope.projectId ?? null,
      providerAnchors,
      projectState: 'any',
      session: fence.sessionId,
    });
    const fresh = existsGuard((database) =>
      database
        .selectFrom('session as rs')
        .select('rs.id')
        .where('rs.org_id', '=', ctx.orgId)
        .where('rs.id', '=', fence.sessionId)
        .where(
          sql<SqlBool>`unixepoch(rs.reauth_at, 'subsec') > unixepoch('now', 'subsec') - ${REAUTH_SECONDS}`,
        ),
    );
    return { base: eb.and([session, held]), fresh };
  }

  function projectAuthority(
    ctx: OrgContext,
    fence: MutationFence,
    permission: string,
    scope: { readonly projectId?: string; readonly reauth?: boolean } = {},
  ): Guard {
    const { base, fresh } = authorityParts(ctx, fence, permission, scope);
    return scope.reauth === true ? eb.and([base, fresh]) : base;
  }

  function authorityProbe(condition: Guard): ScalarStatement {
    return scalar(db.selectNoFrom(sql<number>`${condition} is not 1`.as('refused')));
  }

  async function load(ctx: OrgContext, id: string): Promise<Project | null> {
    requireId(id, 'id');
    const [row] = await executor.all<ProjectRow>(scalar(selectProjects(ctx).where('id', '=', id)));
    return row === undefined ? null : toProject(row);
  }

  async function loadAuthorized(
    ctx: OrgContext,
    id: string,
    authority: Guard,
    reauth?: { readonly base: Guard; readonly fresh: Guard },
  ): Promise<{
    readonly held: boolean;
    readonly stale: boolean;
    readonly project: Project | null;
  }> {
    requireId(id, 'id');
    const level =
      reauth === undefined
        ? sql<number>`${authority} is 1`
        : sql<number>`case when ${reauth.base} is 1 then (case when ${reauth.fresh} is 1 then 1 else 2 end) else 0 end`;
    const [row] = await executor.all<
      { held: number } & { [K in keyof ProjectRow]: ProjectRow[K] | null }
    >(
      scalar(
        db
          .selectFrom(db.selectNoFrom(level.as('held')).as('probe'))
          .leftJoin('project as p', (join) =>
            join.on('p.org_id', '=', ctx.orgId).on('p.id', '=', id),
          )
          .select([
            'probe.held',
            'p.id',
            'p.slug',
            'p.name',
            'p.status',
            'p.token_max_scope',
            'p.require_publish_approval',
            'p.revision',
          ]),
      ),
    );
    if (row?.held !== 1) return { held: false, stale: row?.held === 2, project: null };
    return {
      held: true,
      stale: false,
      project: row.id === null ? null : toProject(row as ProjectRow),
    };
  }

  function revisionCheck(ctx: OrgContext, id: string, expected: number, status: ProjectStatus) {
    return [
      ...assertCheck(
        existsGuard((database) =>
          database
            .selectFrom('project')
            .select('id')
            .where('org_id', '=', ctx.orgId)
            .where('id', '=', id)
            .where('revision', '=', expected),
        ),
      ),
      ...assertCheck(
        existsGuard((database) =>
          database
            .selectFrom('project')
            .select('id')
            .where('org_id', '=', ctx.orgId)
            .where('id', '=', id)
            .where('status', '=', status),
        ),
      ),
    ];
  }

  function targetProbes(
    ctx: OrgContext,
    id: string,
    expected: number,
    status: ProjectStatus,
    authority: Guard,
    idempotency: IdempotencyRecord | undefined,
  ): FailureProbes {
    const target = (column: 'revision' | 'status', comparison: '<>', value: number | string) =>
      scalar(
        db
          .selectFrom('project')
          .select(sql<number>`${sql.ref(column)} ${sql.raw(comparison)} ${value}`.as('holds'))
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', id),
      );
    return {
      authority: authorityProbe(authority),
      conflict: scalar(
        db.selectNoFrom(
          sql<number>`(${liveIdempotencyCollision(ctx, idempotency)} or exists (select 1 from project where org_id = ${ctx.orgId} and id = ${id} and revision <> ${expected}))`.as(
            'holds',
          ),
        ),
      ),
      collision: target('status', '<>', status),
    };
  }

  async function transition<Done extends string, Noop extends string>(
    ctx: OrgContext,
    fence: MutationFence,
    id: string,
    now: string,
    from: ProjectStatus,
    to: ProjectStatus,
    done: Done,
    noop: Noop,
    reauth: boolean,
    audit: AuditEvent,
    idempotency: IdempotencyRecord | undefined,
  ): Promise<
    Done | Noop | 'not_found' | 'conflict' | 'authority' | 'reauth_required' | 'indeterminate'
  > {
    const stamp = timestamp(now);
    const expected = expectedRevision(fence);
    const authority = projectAuthority(ctx, fence, 'org:projects:archive', { reauth });
    const parts = reauth ? authorityParts(ctx, fence, 'org:projects:archive') : undefined;
    const { held, stale, project } = await loadAuthorized(ctx, id, authority, parts);
    if (!held) return stale ? 'reauth_required' : 'authority';
    if (project === null) return 'not_found';

    const guard = assertGuard(authority, ctx);
    const checks = revisionCheck(ctx, id, expected, from);
    const changedAt = guard.length + checks.length;
    const outcome = await runOrgFenced(
      executor,
      ctx,
      fence,
      guard,
      [
        ...checks,
        scalar(
          db
            .updateTable('project')
            .set({
              status: to,
              revision: sql`revision + 1`,
              updated_at: stamp,
              last_op_id: newOpId(),
            })
            .where('org_id', '=', ctx.orgId)
            .where('id', '=', id)
            .where('revision', '=', expected)
            .where('status', '=', from)
            .returning('id'),
        ),
        auditPendingStatement(ctx, audit),
        ...(idempotency === undefined ? [] : [idempotencyInsertStatement(ctx, idempotency)]),
      ],
      targetProbes(ctx, id, expected, from, authority, idempotency),
    );
    if (!outcome.ok) {
      const reason = failure(outcome.reason);
      if (reason === 'authority' && reauth) {
        const [probe] = await executor.all<{ refused: number }>(
          authorityProbe(projectAuthority(ctx, fence, 'org:projects:archive')),
        );
        return probe?.refused === 0 ? 'reauth_required' : 'authority';
      }
      return reason === 'collision' ? noop : reason;
    }
    const changed = outcome.results[changedAt];
    if (changed === undefined || changed.rows.length === 0) {
      throw new Error('project transition committed without a changed row');
    }
    return done;
  }

  return {
    get: load,

    async getBySlug(ctx, slug, lookup = {}) {
      let query = selectProjects(ctx).where('slug', '=', slug);
      if (lookup.activeOnly === true) query = query.where('status', '=', 'active');
      const [row] = await executor.all<ProjectRow>(scalar(query));
      return row === undefined ? null : toProject(row);
    },

    async list(ctx, page) {
      if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > PROJECT_LIST_MAX_LIMIT) {
        throw new TypeError(`limit must be an integer from 1 to ${PROJECT_LIST_MAX_LIMIT}`);
      }
      let query = selectProjects(ctx).orderBy('id').limit(page.limit);
      if (page.q !== undefined) query = query.where(projectPrefixCondition('slug', 'name', page.q));
      if (page.afterId !== undefined) query = query.where('id', '>', page.afterId);
      if (page.status !== undefined) query = query.where('status', '=', page.status);
      if (page.ids !== undefined) {
        if (page.ids.length === 0) return [];
        query = query.where('id', 'in', [...page.ids]);
      }
      return (await executor.all<ProjectRow>(scalar(query))).map(toProject);
    },

    async create(ctx, fence, input) {
      requireId(input.id, 'id');
      requireName(input.name);
      const now = timestamp(input.now);
      const scope = input.tokenMaxScope ?? 'full';
      requireScope(scope);
      if (!isValidProjectSlug(input.slug)) return 'invalid_slug';
      if (projectSlugProblem(input.slug, reserved) !== null) return 'reserved_slug';

      if (input.initialRoleId !== undefined) requireId(input.initialRoleId, 'initialRoleId');

      const opId = newOpId();
      const authority = projectAuthority(ctx, fence, 'org:projects:create');
      let roleId = input.initialRoleId;
      if (roleId === undefined) {
        const [granted] = await executor.all<{ held: number }>(
          scalar(db.selectNoFrom(sql<number>`${authority} is 1`.as('held'))),
        );
        if (granted?.held !== 1) return 'authority';
        const [owner] = await executor.all<{ id: string }>(
          scalar(
            db
              .selectFrom('role')
              .select('id')
              .where('org_id', '=', ctx.orgId)
              .where('key', '=', 'project_owner')
              .where('scope', '=', 'project')
              .where('is_system', '=', 1),
          ),
        );
        if (owner === undefined) {
          throw new ProjectSetupError('the organization has no stored project_owner role');
        }
        roleId = owner.id;
      }
      const initialRoleId = roleId;
      const localAdmin = sql<SqlBool>`exists (select 1 from session hp_s where hp_s.org_id = ${ctx.orgId} and hp_s.id = ${fence.sessionId} and hp_s.revoked_at is null and hp_s.identity_id is null)`;
      const held = permissionRows(ctx, fence.userId, null, providerAnchors, { localAdmin });
      const roleAllowed: Guard = existsGuard((database) =>
        database
          .selectFrom('role as r')
          .select('r.id')
          .where('r.org_id', '=', ctx.orgId)
          .where('r.id', '=', initialRoleId)
          .where('r.scope', '=', 'project')
          .where(
            sql<SqlBool>`not exists (select 1 from role_permission rp where rp.org_id = r.org_id and rp.role_id = r.id and rp.permission not in (select held.permission from ${held.as('held')}))`,
          ),
      );
      const initialRole = (database: typeof db) =>
        database
          .selectFrom('role as r')
          .innerJoin('user_account as creator', 'creator.org_id', 'r.org_id')
          .where('r.org_id', '=', ctx.orgId)
          .where('r.id', '=', initialRoleId)
          .where('creator.id', '=', fence.userId);

      const outcome = await runOrgFenced(
        executor,
        ctx,
        fence,
        assertGuard(authority, ctx),
        [
          ...assertCheck(roleAllowed),
          scalar(
            db.insertInto('project').values({
              id: input.id,
              org_id: ctx.orgId,
              slug: input.slug,
              name: input.name,
              token_max_scope: scope,
              require_publish_approval: input.requirePublishApproval === true ? 1 : 0,
              created_at: now,
              updated_at: now,
              last_op_id: opId,
            }),
          ),
          scalar(
            db
              .insertInto('access_grant')
              .columns([
                'id',
                'org_id',
                'subject_type',
                'subject_value',
                'scope',
                'project_id',
                'role_id',
                'created_by',
                'created_at',
                'updated_at',
              ])
              .expression(
                initialRole(db)
                  .innerJoin('project as created', (join) =>
                    join
                      .onRef('created.org_id', '=', 'r.org_id')
                      .on('created.id', '=', input.id)
                      .on('created.last_op_id', '=', opId),
                  )
                  .select([
                    eb.val(ulid()).as('id'),
                    eb.val(ctx.orgId).as('org_id'),
                    eb.val('email').as('subject_type'),
                    'creator.email as subject_value',
                    eb.val('project').as('scope'),
                    'created.id as project_id',
                    'r.id as role_id',
                    'creator.id as created_by',
                    eb.val(now).as('created_at'),
                    eb.val(now).as('updated_at'),
                  ]),
              ),
          ),
          ...attachSourceStatements(ctx, input.id),
          auditPendingStatement(ctx, input.audit),
          ...(input.idempotency === undefined
            ? []
            : [idempotencyInsertStatement(ctx, input.idempotency)]),
        ],
        {
          authority: authorityProbe(authority),
          conflict: scalar(
            db.selectNoFrom(
              sql<number>`${liveIdempotencyCollision(ctx, input.idempotency)}`.as('holds'),
            ),
          ),
          collision: scalar(
            db.selectNoFrom(
              sql<number>`(${roleAllowed} is not 1 or exists (
            select 1 from project where org_id = ${ctx.orgId} and (slug = ${input.slug} or id = ${input.id})
          ))`.as('holds'),
            ),
          ),
        },
      );
      if (outcome.ok) return 'created';
      const reason = failure(outcome.reason);
      if (reason !== 'collision') return reason;
      const [role] = await executor.all<{ refused: number }>(authorityProbe(roleAllowed));
      return role?.refused === 0 ? 'duplicate' : 'initial_role_not_allowed';
    },

    async update(ctx, fence, { id, changes, now, audit, idempotency }) {
      const stamp = timestamp(now);
      const expected = expectedRevision(fence);
      if (changes.name !== undefined) requireName(changes.name);
      if (changes.tokenMaxScope !== undefined) requireScope(changes.tokenMaxScope);
      const authority = projectAuthority(ctx, fence, 'project:settings:write', { projectId: id });
      const { held, project: current } = await loadAuthorized(ctx, id, authority);
      if (!held) return 'authority';
      if (current === null) return 'not_found';
      if (current.revision !== expected) return 'conflict';

      const differences = [
        ...(changes.name !== undefined && changes.name !== current.name
          ? [sql<boolean>`name <> ${changes.name}`]
          : []),
        ...(changes.tokenMaxScope !== undefined && changes.tokenMaxScope !== current.tokenMaxScope
          ? [sql<boolean>`token_max_scope <> ${changes.tokenMaxScope}`]
          : []),
        ...(changes.requirePublishApproval !== undefined &&
        changes.requirePublishApproval !== current.requirePublishApproval
          ? [sql<boolean>`require_publish_approval <> ${changes.requirePublishApproval ? 1 : 0}`]
          : []),
      ];
      if (differences.length === 0 && current.status === 'active') return 'unchanged';

      const guard = assertGuard(authority, ctx);
      const checks = revisionCheck(ctx, id, expected, 'active');
      const changedAt = guard.length + checks.length;
      const outcome = await runOrgFenced(
        executor,
        ctx,
        fence,
        guard,
        [
          ...checks,
          scalar(
            db
              .updateTable('project')
              .set({
                ...(changes.name !== undefined ? { name: changes.name } : {}),
                ...(changes.tokenMaxScope !== undefined
                  ? { token_max_scope: changes.tokenMaxScope }
                  : {}),
                ...(changes.requirePublishApproval !== undefined
                  ? { require_publish_approval: changes.requirePublishApproval ? 1 : 0 }
                  : {}),
                revision: sql`revision + 1`,
                updated_at: stamp,
                last_op_id: newOpId(),
              })
              .where('org_id', '=', ctx.orgId)
              .where('id', '=', id)
              .where('revision', '=', expected)
              .where('status', '=', 'active')
              .where((w) => w.or(differences.map((difference) => w.parens(difference))))
              .returning('id'),
          ),
          auditPendingStatement(ctx, audit),
          ...(idempotency === undefined ? [] : [idempotencyInsertStatement(ctx, idempotency)]),
        ],
        targetProbes(ctx, id, expected, 'active', authority, idempotency),
      );
      if (!outcome.ok) {
        const reason = failure(outcome.reason);
        return reason === 'collision' ? 'archived' : reason;
      }
      const changed = outcome.results[changedAt];
      return changed !== undefined && changed.rows.length > 0 ? 'updated' : 'unchanged';
    },

    async archive(ctx, fence, { id, now, audit, idempotency }) {
      const answer = await transition(
        ctx,
        fence,
        id,
        now,
        'active',
        'archived',
        'archived',
        'not_active',
        false,
        audit,
        idempotency,
      );
      return answer === 'reauth_required' ? 'authority' : answer;
    },

    restore(ctx, fence, { id, now, audit, idempotency }) {
      return transition(
        ctx,
        fence,
        id,
        now,
        'archived',
        'active',
        'restored',
        'not_archived',
        true,
        audit,
        idempotency,
      );
    },
  } satisfies ProjectStore & ProjectRepository;
}
