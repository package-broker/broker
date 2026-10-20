import type { IdempotencyRecord } from '@package-broker/core/api/idempotency';
import type { AuditEvent } from '@package-broker/core/audit/actions';
import { sql, type Expression, type SqlBool } from 'kysely';
import { SESSION_IDLE_MS } from '@package-broker/core/auth/session';
import type { FailureProbes, MutationFence } from '@package-broker/core/authz/fence';
import { accessGrantFenceKey, roleFenceKey } from '@package-broker/core/authz/project-actor';
import type { GrantSubject } from '@package-broker/core/db/grants';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { normalizeEmail } from '@package-broker/core/identity/policy';
import { isReservedProviderId, isValidProviderId } from '@package-broker/core/identity/port';
import {
  assertCheck,
  assertGuard,
  compile,
  db,
  freshGroupMembership,
  guardAliases,
  guardBindings,
  newOpId,
  runOrgFenced,
  type Guard,
  type ProtectedHolderProvider,
} from '../kysely.js';
import { auditPendingStatement } from './audit-pending.js';
import { idempotencyInsertStatement } from './idempotency.js';
import { patInvalidationStatement } from './pat-offboarding.js';
import { holdsPermission, permissionRows } from './access.js';
import { liveSessionCondition, requireIdleSeconds } from './session-liveness.js';

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_GROUP_LENGTH = 256;
const UNSAFE_GROUP_CHARACTER = /[\p{Cc}\p{Cf}]/u;
const WRITE_PERMISSION = 'project:grants:write';

export interface NewProjectGrant {
  readonly audit: AuditEvent;
  readonly idempotency?: IdempotencyRecord;
  readonly id: string;
  readonly projectId: string;
  readonly subject: GrantSubject;
  readonly roleId: string;
  readonly now: string;
  readonly providerAnchors: readonly ProtectedHolderProvider[];
}

export interface ProjectGrantRoleChange {
  readonly audit: AuditEvent;
  readonly idempotency?: IdempotencyRecord;
  readonly id: string;
  readonly projectId: string;
  readonly roleId: string;
  readonly now: string;
  readonly providerAnchors: readonly ProtectedHolderProvider[];
}

interface GrantRef {
  readonly id: string;
  readonly projectId: string;
}

export interface ProjectGrantTarget {
  readonly audit: AuditEvent;
  readonly idempotency?: IdempotencyRecord;
  readonly id: string;
  readonly projectId: string;
  readonly providerAnchors: readonly ProtectedHolderProvider[];
}

/**
 * `indeterminate` on any method: the response was lost and the write may have committed; re-read.
 * `conflict` also covers a failure that could not be classified.
 */
export interface ProjectGrantRepository {
  /**
   * `forbidden`: the actor is not a live active user, lacks `project:grants:write` on this active
   * project of the organization, or the role holds a permission the actor does not. `role_scope_mismatch`:
   * the role is missing, belongs to another organization or is not project-scoped. `duplicate`: the
   * subject already holds a grant on the project, or the id exists. TypeError before SQL for an
   * invalid subject or `now`, a group provider that is reserved or not in `providerAnchors`.
   */
  create(
    ctx: OrgContext,
    fence: MutationFence,
    input: NewProjectGrant,
  ): Promise<
    'created' | 'duplicate' | 'forbidden' | 'role_scope_mismatch' | 'conflict' | 'indeterminate'
  >;
  /**
   * The fence must carry the grant's revision under `projectGrantKey(id)`. `forbidden` also covers a
   * current or new role the actor does not fully hold. Precedence: `forbidden`, `role_scope_mismatch`,
   * `not_found`, `conflict`. The fence also carries the new role's revision under
   * `projectGrantRoleKey(roleId)`; a stale one answers `conflict`.
   */
  changeRole(
    ctx: OrgContext,
    fence: MutationFence,
    input: ProjectGrantRoleChange,
  ): Promise<
    'updated' | 'forbidden' | 'role_scope_mismatch' | 'not_found' | 'conflict' | 'indeterminate'
  >;
  /**
   * Needs only write authority, so a holder of a role wider than the actor can be removed, and is
   * allowed on an archived project.
   */
  delete(
    ctx: OrgContext,
    fence: MutationFence,
    input: ProjectGrantTarget,
  ): Promise<
    | { readonly status: 'deleted'; readonly offboardedUserId: string | null }
    | 'forbidden'
    | 'not_found'
    | 'conflict'
    | 'indeterminate'
  >;
}

const projectGrantKey = accessGrantFenceKey;
const projectGrantRoleKey = roleFenceKey;
export { projectGrantKey, projectGrantRoleKey };

function timestamp(value: string): string {
  const parsed = typeof value === 'string' ? new Date(value) : new Date(Number.NaN);
  if (!TIMESTAMP.test(value) || Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError('now must be a UTC timestamp with millisecond precision');
  }
  return value;
}

function requireSubject(
  subject: GrantSubject,
  providerAnchors: readonly ProtectedHolderProvider[],
): void {
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
  if (
    isReservedProviderId(subject.provider) ||
    !providerAnchors.some((entry) => entry.provider === subject.provider)
  ) {
    throw new TypeError('grant provider must be a configured, non-reserved provider');
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

function expectedRevision(fence: MutationFence, key: string): number {
  const revision = fence.expected?.[key];
  if (typeof revision !== 'number') {
    throw new TypeError(`the fence must carry the expected revision of ${key}`);
  }
  return revision;
}

function allOf(conditions: readonly Guard[]): Guard {
  return sql<SqlBool>`(${sql.join(conditions, sql` and `)})`;
}

function actorIsLive(ctx: OrgContext, fence: MutationFence, idleSeconds: number): Guard {
  return sql<SqlBool>`exists (
    select 1 from user_account as actor
    join session as actor_session on actor_session.user_id = actor.id and actor_session.org_id = actor.org_id
    where actor.id = ${fence.userId} and actor.org_id = ${ctx.orgId} and actor.status = 'active'
      and actor_session.id = ${fence.sessionId}
      and ${liveSessionCondition('actor_session', idleSeconds)}
  )`;
}

function localAdminSession(ctx: OrgContext, fence: MutationFence): Guard {
  return sql<SqlBool>`exists (
    select 1 from session as local_session
    where local_session.org_id = ${ctx.orgId} and local_session.id = ${fence.sessionId}
      and local_session.revoked_at is null and local_session.identity_id is null
  )`;
}

function actorCoversRole(
  ctx: OrgContext,
  fence: MutationFence,
  access: AccessInput,
  roleOf: Expression<string>,
): Guard {
  const available = permissionRows(ctx, fence.userId, access.projectId, access.providerAnchors, {
    localAdmin: localAdminSession(ctx, fence),
  });
  return sql<SqlBool>`not exists (
    select 1 from role_permission as wanted
    join role as wanted_role on wanted_role.id = wanted.role_id and wanted_role.org_id = ${ctx.orgId}
    where wanted.role_id = ${roleOf}
      and not exists (
        select 1 from ${available.as('available')}
        where available.permission = wanted.permission
      )
  )`;
}

interface AccessInput {
  readonly projectId: string;
  readonly providerAnchors: readonly ProtectedHolderProvider[];
}

function authority(
  ctx: OrgContext,
  fence: MutationFence,
  access: AccessInput,
  options: {
    readonly projectState: 'active' | 'any';
    readonly idleSeconds: number;
    readonly roles: readonly Expression<string>[];
  },
): Guard {
  return allOf([
    actorIsLive(ctx, fence, options.idleSeconds),
    holdsPermission(ctx, {
      userId: fence.userId,
      permission: WRITE_PERMISSION,
      projectId: access.projectId,
      providerAnchors: access.providerAnchors,
      projectState: options.projectState,
      session: fence.sessionId,
    }),
    sql<SqlBool>`exists (
      select 1 from project as target_project
      where target_project.id = ${access.projectId} and target_project.org_id = ${ctx.orgId}
    )`,
    ...options.roles.map((roleOf) => actorCoversRole(ctx, fence, access, roleOf)),
  ]);
}

function projectRole(ctx: OrgContext, roleId: string, revision?: number): Guard {
  const stamp = revision === undefined ? sql`` : sql`and target_role.revision = ${revision}`;
  return sql<SqlBool>`exists (
    select 1 from role as target_role
    where target_role.id = ${roleId} and target_role.org_id = ${ctx.orgId} and target_role.scope = 'project' ${stamp}
  )`;
}

function projectGrant(ctx: OrgContext, target: GrantRef, revision?: number): Guard {
  const stamp = revision === undefined ? sql`` : sql`and target_grant.revision = ${revision}`;
  return sql<SqlBool>`exists (
    select 1 from access_grant as target_grant
    where target_grant.id = ${target.id} and target_grant.org_id = ${ctx.orgId}
      and target_grant.scope = 'project' and target_grant.project_id = ${target.projectId} ${stamp}
  )`;
}

function currentRole(ctx: OrgContext, target: GrantRef): Expression<string> {
  return sql<string>`(
    select current_grant.role_id from access_grant as current_grant
    where current_grant.id = ${target.id} and current_grant.org_id = ${ctx.orgId}
      and current_grant.scope = 'project' and current_grant.project_id = ${target.projectId}
  )`;
}

function probe(condition: Guard, negate: boolean): Statement {
  const expression = negate ? sql<number>`(${condition}) is not 1` : sql<number>`(${condition})`;
  return compile(db.selectNoFrom(expression.as('held')));
}

function idempotencyCollision(ctx: OrgContext, record: IdempotencyRecord | undefined): Guard {
  return record === undefined
    ? sql<SqlBool>`0`
    : sql<SqlBool>`exists (select 1 from api_idempotency where org_id = ${ctx.orgId}
        and principal_key = ${record.principalKey} and key = ${record.key})`;
}

function failed(reason: string): never {
  throw new Error(`project grant write failed without a classification: ${reason}`);
}

export interface ProjectGrantRepositoryOptions {
  readonly idleSeconds?: number;
}

export function createProjectGrantRepository(
  executor: SqlExecutor,
  options: ProjectGrantRepositoryOptions = {},
): ProjectGrantRepository {
  const idleSeconds = requireIdleSeconds(options.idleSeconds ?? SESSION_IDLE_MS / 1000);
  async function diagnose(
    ctx: OrgContext,
    target: GrantRef | null,
    role: { readonly id: string; readonly revision: number } | null,
    revision?: number,
  ): Promise<'role_scope_mismatch' | 'not_found' | 'conflict'> {
    const roleOk = (
      role === null ? sql<number>`1` : sql<number>`(${projectRole(ctx, role.id)})`
    ).as('role_ok');
    const roleCurrent =
      role === null ? sql<number>`1` : sql<number>`(${projectRole(ctx, role.id, role.revision)})`;
    const found = target === null ? sql<number>`1` : sql<number>`(${projectGrant(ctx, target)})`;
    const current =
      target === null ? sql<number>`1` : sql<number>`(${projectGrant(ctx, target, revision)})`;
    const [row] = await executor.all<{
      role_ok: number;
      role_current: number;
      found: number;
      current: number;
    }>(
      compile(
        db.selectNoFrom([
          roleOk,
          roleCurrent.as('role_current'),
          found.as('found'),
          current.as('current'),
        ]),
      ),
    );
    if (row === undefined || row.role_ok !== 1) return 'role_scope_mismatch';
    if (row.found !== 1) return 'not_found';
    if (row.current !== 1 || row.role_current !== 1) return 'conflict';
    return 'conflict';
  }

  return {
    async create(ctx, fence, input) {
      requireSubject(input.subject, input.providerAnchors);
      const now = timestamp(input.now);
      const subject = input.subject;
      const provider = subject.type === 'group' ? subject.provider : null;
      const allowed = authority(ctx, fence, input, {
        projectState: 'active',
        idleSeconds,
        roles: [sql<string>`${input.roleId}`],
      });
      const valid = projectRole(ctx, input.roleId);
      const duplicate = sql<SqlBool>`exists (
        select 1 from access_grant as existing
        where existing.org_id = ${ctx.orgId} and (existing.id = ${input.id}
          or (existing.project_id = ${input.projectId} and existing.scope = 'project'
            and existing.subject_type = ${subject.type} and existing.subject_value = ${subject.value}
            and existing.subject_provider is ${provider}))
      )`;
      const insert = compile(
        db.insertInto('access_grant').values({
          id: input.id,
          org_id: ctx.orgId,
          subject_type: subject.type,
          subject_value: subject.value,
          subject_provider: provider,
          scope: 'project',
          project_id: input.projectId,
          role_id: input.roleId,
          created_by: fence.userId,
          created_at: now,
          updated_at: now,
        }),
      );
      const probes: FailureProbes = {
        authority: probe(allowed, true),
        conflict: probe(
          sql<SqlBool>`(${valid} is not 1 or ${idempotencyCollision(ctx, input.idempotency)})`,
          false,
        ),
        collision: probe(duplicate, false),
      };
      const outcome = await runOrgFenced(
        executor,
        ctx,
        fence,
        assertGuard(allowed, ctx),
        [
          ...assertCheck(valid),
          insert,
          auditPendingStatement(ctx, input.audit),
          ...(input.idempotency === undefined
            ? []
            : [idempotencyInsertStatement(ctx, input.idempotency)]),
        ],
        probes,
      );
      if (outcome.ok) return 'created';
      if (outcome.reason === 'authority') return 'forbidden';
      if (outcome.reason === 'conflict') {
        const [collision] = await executor.all<{ held: number }>(
          probe(idempotencyCollision(ctx, input.idempotency), false),
        );
        return collision?.held === 1 ? 'conflict' : 'role_scope_mismatch';
      }
      if (outcome.reason === 'collision') return 'duplicate';
      return outcome.reason === 'indeterminate' ? 'indeterminate' : 'conflict';
    },

    async changeRole(ctx, fence, input) {
      const now = timestamp(input.now);
      const revision = expectedRevision(fence, projectGrantKey(input.id));
      const roleRevision = expectedRevision(fence, projectGrantRoleKey(input.roleId));
      const target = { id: input.id, projectId: input.projectId };
      const allowed = authority(ctx, fence, input, {
        projectState: 'active',
        idleSeconds,
        roles: [sql<string>`${input.roleId}`, currentRole(ctx, target)],
      });
      const valid = allOf([
        projectRole(ctx, input.roleId, roleRevision),
        projectGrant(ctx, target, revision),
      ]);
      const opId = newOpId();
      const update = compile(
        db
          .updateTable('access_grant')
          .set({
            role_id: input.roleId,
            updated_at: now,
            last_op_id: opId,
            revision: sql<number>`revision + 1`,
          })
          .where('access_grant.id', '=', input.id)
          .where('access_grant.org_id', '=', ctx.orgId)
          .where('access_grant.scope', '=', 'project')
          .where('access_grant.project_id', '=', input.projectId)
          .where('access_grant.revision', '=', revision)
          .returning('id'),
      );
      const guard = assertGuard(allowed, ctx);
      const checks = assertCheck(valid);
      const changedAt = guard.length + checks.length;
      const outcome = await runOrgFenced(
        executor,
        ctx,
        fence,
        guard,
        [
          ...checks,
          update,
          auditPendingStatement(ctx, input.audit),
          ...(input.idempotency === undefined
            ? []
            : [idempotencyInsertStatement(ctx, input.idempotency)]),
        ],
        {
          authority: probe(allowed, true),
          conflict: probe(
            sql<SqlBool>`(${valid} is not 1 or ${idempotencyCollision(ctx, input.idempotency)})`,
            false,
          ),
        },
      );
      if (outcome.ok) {
        if ((outcome.results[changedAt]?.rows.length ?? 0) !== 1) failed('update changed no row');
        return 'updated';
      }
      if (outcome.reason === 'authority') return 'forbidden';
      if (outcome.reason === 'conflict') {
        const [collision] = await executor.all<{ held: number }>(
          probe(idempotencyCollision(ctx, input.idempotency), false),
        );
        if (collision?.held === 1) return 'conflict';
        return diagnose(ctx, target, { id: input.roleId, revision: roleRevision }, revision);
      }
      return outcome.reason === 'indeterminate' ? 'indeterminate' : 'conflict';
    },

    async delete(ctx, fence, input) {
      const revision = expectedRevision(fence, projectGrantKey(input.id));
      const allowed = authority(ctx, fence, input, { projectState: 'any', idleSeconds, roles: [] });
      const valid = projectGrant(ctx, input, revision);
      const opId = newOpId();
      const tombstone = compile(
        db
          .updateTable('access_grant')
          .set({ last_op_id: opId })
          .where('access_grant.id', '=', input.id)
          .where('access_grant.org_id', '=', ctx.orgId)
          .where('access_grant.scope', '=', 'project')
          .where('access_grant.project_id', '=', input.projectId)
          .where('access_grant.revision', '=', revision),
      );
      const owned = sql<SqlBool>`exists (
        select 1 from access_grant as tombstoned
        where tombstoned.id = ${input.id} and tombstoned.last_op_id = ${opId}
      )`;
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
        null,
      );
      const bindings = guardBindings(
        { values: alias.values, anchors: alias.anchors },
        { org_id: ctx.orgId },
        input.providerAnchors,
      );
      const subject = sql.id(alias.user);
      const membership = sql.id(alias.member);
      const offboarded = compile(
        bindings.creator.selectNoFrom(
          sql<string | null>`(
          select ${subject}.id from user_account as ${subject}
          join access_grant as removed on removed.org_id = ${subject}.org_id
            and removed.subject_type = 'email' and removed.subject_value = ${subject}.email
          where removed.id = ${input.id} and removed.org_id = ${bindings.org}
            and removed.last_op_id = ${opId}
            and not exists (
              select 1 from access_grant as remaining
              where remaining.org_id = ${subject}.org_id and remaining.id <> removed.id
                and (remaining.scope = 'organization'
                  or (remaining.scope = 'project' and remaining.project_id = removed.project_id))
                and (
                  (remaining.subject_type = 'email' and remaining.subject_value = ${subject}.email)
                  or (remaining.subject_type = 'group' and exists (
                    select 1 from user_group as ${membership}
                    where ${membership}.org_id = ${subject}.org_id
                      and ${membership}.user_id = ${subject}.id
                      and ${membership}.provider = remaining.subject_provider
                      and ${membership}.group_name = remaining.subject_value
                      and ${freshGroupMembership(bindings, alias)}
                  ))
                )
            )
        )
      `.as('offboarded_user_id'),
        ),
      );
      const remove = compile(
        db
          .deleteFrom('access_grant')
          .where('access_grant.id', '=', input.id)
          .where('access_grant.org_id', '=', ctx.orgId)
          .where('access_grant.last_op_id', '=', opId)
          .returning('id'),
      );
      const guard = assertGuard(allowed, ctx);
      const checks = [...assertCheck(valid), tombstone, ...assertCheck(owned)];
      const offboardedAt = guard.length + checks.length;
      const changedAt = offboardedAt + 2;
      const outcome = await runOrgFenced(
        executor,
        ctx,
        fence,
        guard,
        [
          ...checks,
          offboarded,
          patInvalidationStatement(ctx, input.id, {
            sql: 'removed.last_op_id = ?',
            params: [opId],
          }),
          remove,
          auditPendingStatement(ctx, input.audit),
          ...(input.idempotency === undefined
            ? []
            : [idempotencyInsertStatement(ctx, input.idempotency)]),
        ],
        {
          authority: probe(allowed, true),
          conflict: probe(
            sql<SqlBool>`(${valid} is not 1 or ${idempotencyCollision(ctx, input.idempotency)})`,
            false,
          ),
        },
      );
      if (outcome.ok) {
        if ((outcome.results[changedAt]?.rows.length ?? 0) !== 1) failed('delete removed no row');
        const row = outcome.results[offboardedAt]?.rows[0] as
          { offboarded_user_id: string | null } | undefined;
        return { status: 'deleted', offboardedUserId: row?.offboarded_user_id ?? null };
      }
      if (outcome.reason === 'authority') return 'forbidden';
      if (outcome.reason === 'conflict') {
        const [collision] = await executor.all<{ held: number }>(
          probe(idempotencyCollision(ctx, input.idempotency), false),
        );
        if (collision?.held === 1) return 'conflict';
        return (await diagnose(ctx, input, null, revision)) === 'not_found'
          ? 'not_found'
          : 'conflict';
      }
      return outcome.reason === 'indeterminate' ? 'indeterminate' : 'conflict';
    },
  };
}
