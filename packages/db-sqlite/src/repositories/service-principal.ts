import type { AuditEvent } from '@package-broker/core/audit/actions';
import type { IdempotencyRecord } from '@package-broker/core/api/idempotency';
import { auditPendingStatement } from './audit-pending.js';
import { idempotencyInsertStatement } from './idempotency.js';
import type { ServicePrincipalStore } from '@package-broker/core/authz/service-principal-service';
import { sql, type Compilable } from 'kysely';
import { PERMISSIONS, isPermission } from '@package-broker/core/authz/permissions';
import {
  type FailureProbes,
  type FenceGuard,
  type MutationFence,
} from '@package-broker/core/authz/fence';
import { DbError } from '@package-broker/core/db/errors';
import type { OrgContext, ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import { assertCheck, compile, db, existsGuard, runOrgFenced } from '../kysely.js';

export const SERVICE_PRINCIPAL_NAME_MAX_LENGTH = 100;

export interface ServicePrincipal {
  readonly id: string;
  readonly name: string;
  readonly projectId: string | null;
  readonly createdByUserId: string;
  readonly status: 'active' | 'suspended';
  readonly revision: number;
  readonly permissions: readonly string[];
}

export interface ServicePrincipalRepository {
  get(ctx: OrgContext, id: string): Promise<ServicePrincipal | null>;
  /** The principals of this organization whose creator is `userId`, ordered by id. */
  createdBy(
    ctx: OrgContext,
    userId: string,
  ): Promise<readonly { readonly id: string; readonly projectId: string | null }[]>;
  /**
   * One fenced batch inserts the principal and exactly its permission rows. The caller guard decides
   * whether the actor may create; a refusing guard stores nothing and answers `authority`.
   * `project_mismatch` covers a missing or non-active project or one of another organization;
   * `duplicate` covers an existing name or id; `invalid_permissions` covers an unknown or
   * session-only permission, or an `org:` permission on a project-bound principal. TypeError for a
   * malformed id, opId, name or `now`, and after the insert is refused when `createdByUserId` is
   * not a user of the organization; nothing is stored.
   */
  create(
    ctx: OrgContext,
    fence: MutationFence,
    guard: FenceGuard,
    input: Parameters<ServicePrincipalStore['create']>[3],
  ): Promise<
    | 'created'
    | 'duplicate'
    | 'project_mismatch'
    | 'invalid_permissions'
    | 'authority'
    | 'indeterminate'
  >;
  /**
   * Replaces the whole permission set and bumps the revision in the fenced batch. The repository
   * enforces the `service_principal` expected revision itself (TypeError when the fence has none);
   * the caller guard adds the actor's authority. `authority` means the revision is current but the
   * guard refused; `conflict` means the revision is stale. The project binding is never touched.
   */
  setPermissions(
    ctx: OrgContext,
    fence: MutationFence,
    guard: FenceGuard,
    input: Parameters<ServicePrincipalStore['setPermissions']>[3],
  ): Promise<
    'updated' | 'not_found' | 'invalid_permissions' | 'conflict' | 'authority' | 'indeterminate'
  >;
  /** Suspending a suspended principal answers `unchanged` and rewrites nothing. */
  suspend(
    ctx: OrgContext,
    fence: MutationFence,
    guard: FenceGuard,
    input: Parameters<ServicePrincipalStore['suspend']>[3],
  ): Promise<'suspended' | 'unchanged' | 'not_found' | 'conflict' | 'authority' | 'indeterminate'>;
  restore(
    ctx: OrgContext,
    fence: MutationFence,
    guard: FenceGuard,
    input: Parameters<ServicePrincipalStore['restore']>[3],
  ): Promise<
    'restored' | 'not_suspended' | 'not_found' | 'conflict' | 'authority' | 'indeterminate'
  >;
}

interface PrincipalRow {
  readonly id: string;
  readonly name: string;
  readonly project_id: string | null;
  readonly created_by_user_id: string;
  readonly status: string;
  readonly revision: number;
  readonly permission: string | null;
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FORBIDDEN_NAME_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;

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

function requireName(name: string): void {
  const length = typeof name === 'string' ? [...name].length : 0;
  if (
    length < 1 ||
    length > SERVICE_PRINCIPAL_NAME_MAX_LENGTH ||
    FORBIDDEN_NAME_CHARACTERS.test(name)
  ) {
    throw new TypeError(
      `service principal name must be 1 to ${SERVICE_PRINCIPAL_NAME_MAX_LENGTH} printable characters`,
    );
  }
}

const SESSION_ONLY: ReadonlySet<string> = new Set(
  PERMISSIONS.filter((info) => info.sessionOnly).map((info) => info.name),
);

function acceptable(projectBound: boolean, permissions: readonly string[]): boolean {
  return permissions.every(
    (name) =>
      isPermission(name) && !SESSION_ONLY.has(name) && !(projectBound && name.startsWith('org:')),
  );
}

function requireNonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

const GUARD_CONSTRAINT = 'access_mutation_guard.key';

const ALWAYS: FailureProbes = {
  authority: { sql: 'SELECT 1 AS refused', params: [] },
};

function isGuardFailure(error: DbError): boolean {
  return (
    error.kind === 'unique' &&
    (error.constraint === undefined || error.constraint === GUARD_CONSTRAINT)
  );
}

function isPrincipalCollision(error: DbError): boolean {
  return error.kind === 'unique' && error.constraint?.startsWith('service_principal.') === true;
}

function isDataFailure(error: DbError): boolean {
  return (
    error.kind === 'foreign_key' ||
    error.kind === 'check' ||
    error.kind === 'not_null' ||
    (error.kind === 'unique' && !isGuardFailure(error))
  );
}

/**
 * Records the constraint error of the fenced batch and answers the failure probes with nothing when
 * the batch failed on data rather than on the guard, so a data failure is never read as authority.
 */
function watched(executor: ScalarSqlExecutor, probes: FailureProbes) {
  const probeStatements = new Set<unknown>(Object.values(probes));
  let failure: DbError | null = null;
  const wrapped: ScalarSqlExecutor = {
    driver: executor.driver,
    async batch(statements) {
      try {
        return await executor.batch(statements);
      } catch (error) {
        failure = error instanceof DbError ? error : null;
        throw error;
      }
    },
    all(statement) {
      if (failure !== null && probeStatements.has(statement) && isDataFailure(failure)) {
        return Promise.resolve([]);
      }
      return executor.all(statement);
    },
  };
  return { executor: wrapped, failure: (): DbError | null => failure };
}

function failed(outcome: { readonly reason: string }): 'authority' | 'conflict' | 'indeterminate' {
  if (
    outcome.reason === 'indeterminate' ||
    outcome.reason === 'authority' ||
    outcome.reason === 'conflict'
  ) {
    return outcome.reason;
  }
  throw new Error(`service principal mutation failed unclassified (${outcome.reason})`);
}

function toPrincipals(rows: readonly PrincipalRow[]): ServicePrincipal[] {
  const found = new Map<string, ServicePrincipal & { permissions: string[] }>();
  for (const row of rows) {
    let principal = found.get(row.id);
    if (principal === undefined) {
      principal = {
        id: row.id,
        name: row.name,
        projectId: row.project_id,
        createdByUserId: row.created_by_user_id,
        status: row.status as ServicePrincipal['status'],
        revision: row.revision,
        permissions: [],
      };
      found.set(row.id, principal);
    }
    if (row.permission !== null) principal.permissions.push(row.permission);
  }
  return [...found.values()];
}

function selectPrincipals(ctx: OrgContext, id: string) {
  return db
    .selectFrom('service_principal as sp')
    .leftJoin('service_principal_permission as p', (join) =>
      join.onRef('p.service_principal_id', '=', 'sp.id').onRef('p.org_id', '=', 'sp.org_id'),
    )
    .select([
      'sp.id',
      'sp.name',
      'sp.project_id',
      'sp.created_by_user_id',
      'sp.status',
      'sp.revision',
      'p.permission',
    ])
    .where('sp.org_id', '=', ctx.orgId)
    .where('sp.id', '=', id)
    .orderBy('p.permission');
}

function insertPermissions(
  ctx: OrgContext,
  id: string,
  permissions: readonly string[],
  extra: (source: ReturnType<typeof permissionSource>) => ReturnType<typeof permissionSource>,
): ScalarStatement {
  const source = extra(permissionSource(ctx, id, permissions));
  return scalar(
    db
      .insertInto('service_principal_permission')
      .columns(['org_id', 'service_principal_id', 'permission'])
      .expression(
        source.select((eb) => [
          eb.val(ctx.orgId).as('org_id'),
          'sp.id as service_principal_id',
          sql<string>`j.value`.as('permission'),
        ]),
      )
      .onConflict((conflict) => conflict.doNothing()),
  );
}

function permissionSource(ctx: OrgContext, id: string, permissions: readonly string[]) {
  return db
    .selectFrom('service_principal as sp')
    .innerJoin(sql`json_each(${JSON.stringify(permissions)})`.as('j'), (join) => join.onTrue())
    .where('sp.id', '=', id)
    .where('sp.org_id', '=', ctx.orgId);
}

function mutationStatements(
  ctx: OrgContext,
  input: { audit: AuditEvent; idempotency?: IdempotencyRecord },
  when?: ScalarStatement,
) {
  const replay =
    input.idempotency === undefined
      ? undefined
      : idempotencyInsertStatement(ctx, input.idempotency, false, when);
  return [auditPendingStatement(ctx, input.audit, when), ...(replay === undefined ? [] : [replay])];
}

export function createServicePrincipalRepository(
  executor: ScalarSqlExecutor,
): ServicePrincipalRepository {
  async function load(ctx: OrgContext, id: string): Promise<ServicePrincipal | null> {
    const rows = await executor.all<PrincipalRow>(scalar(selectPrincipals(ctx, id)));
    return toPrincipals(rows)[0] ?? null;
  }

  async function exists(ctx: OrgContext, id: string): Promise<boolean> {
    const found = await executor.all(
      scalar(
        db
          .selectFrom('service_principal')
          .select('id')
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', id),
      ),
    );
    return found.length > 0;
  }

  async function clashes(
    ctx: OrgContext,
    input: { readonly id: string; readonly name: string },
  ): Promise<boolean> {
    const found = await executor.all(
      scalar(
        db
          .selectFrom('service_principal')
          .select('id')
          .where((eb) =>
            eb.or([
              eb('id', '=', input.id),
              eb.and([eb('org_id', '=', ctx.orgId), eb('name', '=', input.name)]),
            ]),
          ),
      ),
    );
    return found.length > 0;
  }

  return {
    get: load,

    async createdBy(ctx, userId) {
      requireNonEmpty(userId, 'userId');
      const found = await executor.all<{ id: string; project_id: string | null }>(
        scalar(
          db
            .selectFrom('service_principal')
            .select(['id', 'project_id'])
            .where('org_id', '=', ctx.orgId)
            .where('created_by_user_id', '=', userId)
            .orderBy('id'),
        ),
      );
      return found.map((row) => ({ id: row.id, projectId: row.project_id }));
    },

    async create(ctx, fence, guard, input) {
      requireNonEmpty(input.id, 'id');
      requireNonEmpty(input.opId, 'opId');
      requireName(input.name);
      const now = timestamp(input.now);
      const projectBound = input.projectId !== null;
      if (!acceptable(projectBound, input.permissions)) return 'invalid_permissions';

      const principal = db
        .insertInto('service_principal')
        .columns([
          'id',
          'org_id',
          'name',
          'project_id',
          'created_by_user_id',
          'created_at',
          'updated_at',
          'last_op_id',
        ])
        .expression((eb) =>
          eb
            .selectFrom('user_account as creator')
            .select([
              eb.val(input.id).as('id'),
              eb.val(ctx.orgId).as('org_id'),
              eb.val(input.name).as('name'),
              eb.val(input.projectId).as('project_id'),
              'creator.id as created_by_user_id',
              eb.val(now).as('created_at'),
              eb.val(now).as('updated_at'),
              eb.val(input.opId).as('last_op_id'),
            ])
            .where('creator.id', '=', input.createdByUserId)
            .where('creator.org_id', '=', ctx.orgId)
            .$if(projectBound, (q) =>
              q.where((web) =>
                web.exists(
                  web
                    .selectFrom('project')
                    .select(sql.lit(1).as('one'))
                    .where('project.id', '=', input.projectId)
                    .where('project.org_id', '=', ctx.orgId)
                    .where('project.status', '=', 'active'),
                ),
              ),
            ),
        )
        .returning('id');

      const permissions = insertPermissions(ctx, input.id, input.permissions, (source) =>
        source
          .where('sp.name', '=', input.name)
          .where('sp.created_by_user_id', '=', input.createdByUserId)
          .where('sp.created_at', '=', now)
          .where('sp.updated_at', '=', now)
          .where('sp.revision', '=', 1)
          .where('sp.last_op_id', '=', input.opId)
          .where((eb) =>
            eb.exists(
              eb
                .selectFrom('user_account as creator')
                .select(sql.lit(1).as('one'))
                .where('creator.id', '=', input.createdByUserId)
                .where('creator.org_id', '=', ctx.orgId),
            ),
          )
          .$if(projectBound, (q) =>
            q.where((eb) =>
              eb.exists(
                eb
                  .selectFrom('project')
                  .select(sql.lit(1).as('one'))
                  .where('project.id', '=', input.projectId)
                  .where('project.org_id', '=', ctx.orgId)
                  .where('project.status', '=', 'active'),
              ),
            ),
          )
          .where((eb) =>
            input.projectId === null
              ? eb('sp.project_id', 'is', null)
              : eb('sp.project_id', '=', input.projectId),
          )
          .where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom('service_principal_permission as existing')
                  .select(sql.lit(1).as('one'))
                  .whereRef('existing.service_principal_id', '=', 'sp.id'),
              ),
            ),
          ),
      );

      const observed = watched(executor, ALWAYS);
      const outcome = await runOrgFenced(
        observed.executor,
        ctx,
        fence,
        guard,
        [
          scalar(principal),
          permissions,
          ...mutationStatements(ctx, input, {
            sql: 'exists (select 1 from service_principal where org_id = ? and id = ? and last_op_id = ?)',
            params: [ctx.orgId, input.id, input.opId],
          }),
        ],
        ALWAYS,
      );
      if (!outcome.ok) {
        if (outcome.reason === 'indeterminate') return 'indeterminate';
        const error = observed.failure();
        if (error !== null && isPrincipalCollision(error)) return 'duplicate';
        if (error !== null && isDataFailure(error)) return 'indeterminate';
        if (
          error !== null &&
          error.kind === 'unique' &&
          error.constraint === undefined &&
          (await clashes(ctx, input))
        ) {
          return 'duplicate';
        }
        return failed({ reason: outcome.reason }) === 'indeterminate'
          ? 'indeterminate'
          : 'authority';
      }
      const inserted = outcome.results[guard.length];
      if (inserted !== undefined && inserted.rows.length > 0) return 'created';

      const [creator, project] = await Promise.all([
        executor.all(
          scalar(
            db
              .selectFrom('user_account')
              .select('id')
              .where('id', '=', input.createdByUserId)
              .where('org_id', '=', ctx.orgId),
          ),
        ),
        input.projectId === null
          ? Promise.resolve([{ id: '' }])
          : executor.all(
              scalar(
                db
                  .selectFrom('project')
                  .select('id')
                  .where('id', '=', input.projectId)
                  .where('org_id', '=', ctx.orgId)
                  .where('status', '=', 'active'),
              ),
            ),
      ]);
      if (creator.length === 0)
        throw new TypeError('createdByUserId must be a user of the organization');
      if (project.length === 0) return 'project_mismatch';
      throw new TypeError('service principal was not stored');
    },

    async setPermissions(ctx, fence, guard, { id, permissions, now, opId, audit, idempotency }) {
      requireNonEmpty(id, 'id');
      requireNonEmpty(opId, 'opId');
      const stamp = timestamp(now);
      const expected = fence.expected['service_principal'];
      if (expected === undefined) {
        throw new TypeError('fence must carry an expected service_principal revision');
      }
      if (!permissions.every(isPermission)) return 'invalid_permissions';
      const current = await load(ctx, id);
      if (current === null) return 'not_found';
      if (!acceptable(current.projectId !== null, permissions)) return 'invalid_permissions';

      const revision = (comparison: '=' | '<>') =>
        scalar(
          db
            .selectFrom('service_principal')
            .select(sql<number>`revision ${sql.raw(comparison)} ${expected}`.as('holds'))
            .where('org_id', '=', ctx.orgId)
            .where('id', '=', id),
        );
      const probes: FailureProbes = { authority: revision('='), conflict: revision('<>') };
      const cas = assertCheck(
        existsGuard((database) =>
          database
            .selectFrom('service_principal')
            .select('id')
            .where('org_id', '=', ctx.orgId)
            .where('id', '=', id)
            .where('revision', '=', expected),
        ),
      );

      const observed = watched(executor, probes);
      const outcome = await runOrgFenced(
        observed.executor,
        ctx,
        fence,
        guard,
        [
          ...cas,
          scalar(
            db
              .deleteFrom('service_principal_permission')
              .where('org_id', '=', ctx.orgId)
              .where('service_principal_id', '=', id),
          ),
          insertPermissions(ctx, id, permissions, (source) => source),
          scalar(
            db
              .updateTable('service_principal')
              .set({ revision: sql`revision + 1`, updated_at: stamp, last_op_id: opId })
              .where('org_id', '=', ctx.orgId)
              .where('id', '=', id),
          ),
          ...mutationStatements(ctx, {
            audit,
            ...(idempotency === undefined ? {} : { idempotency }),
          }),
        ],
        probes,
      );
      if (outcome.ok) return 'updated';
      if (outcome.reason === 'indeterminate') return 'indeterminate';
      if (outcome.reason === 'unclassified' && !(await exists(ctx, id))) return 'not_found';
      const error = observed.failure();
      if (error !== null && isDataFailure(error)) return 'indeterminate';
      return failed(outcome);
    },

    async suspend(ctx, fence, guard, input) {
      const result = await transition(ctx, fence, guard, input, 'active', 'suspended', 'suspended');
      if (result === 'not_suspended') return 'unchanged';
      if (result !== 'conflict') return result;
      const current = await load(ctx, input.id);
      if (current?.status !== 'suspended') return result;
      const again = await transition(
        ctx,
        fence,
        guard,
        input,
        'active',
        'suspended',
        'suspended',
        current.revision,
      );
      return again === 'not_suspended' ? 'unchanged' : again;
    },

    async restore(ctx, fence, guard, input) {
      return transition(ctx, fence, guard, input, 'suspended', 'active', 'restored');
    },
  };

  async function transition<Done extends string>(
    ctx: OrgContext,
    fence: MutationFence,
    guard: FenceGuard,
    input: Parameters<ServicePrincipalStore['suspend']>[3],
    from: 'active' | 'suspended',
    to: 'active' | 'suspended',
    done: Done,
    revisionOverride?: number,
  ): Promise<Done | 'not_found' | 'not_suspended' | 'conflict' | 'authority' | 'indeterminate'> {
    const { id, now, opId } = input;
    requireNonEmpty(id, 'id');
    requireNonEmpty(opId, 'opId');
    const stamp = timestamp(now);
    const expected = revisionOverride ?? fence.expected['service_principal'];
    const revision = (comparison: '=' | '<>') =>
      scalar(
        db
          .selectFrom('service_principal')
          .select(sql<number>`revision ${sql.raw(comparison)} ${expected ?? 0}`.as('holds'))
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', id),
      );
    const present = scalar(
      db
        .selectFrom('service_principal')
        .select(sql<number>`1`.as('present'))
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', id),
    );
    const probes: FailureProbes =
      expected === undefined
        ? { authority: present }
        : { authority: revision('='), conflict: revision('<>') };
    const cas =
      expected === undefined
        ? []
        : assertCheck(
            existsGuard((database) =>
              database
                .selectFrom('service_principal')
                .select('id')
                .where('org_id', '=', ctx.orgId)
                .where('id', '=', id)
                .where('revision', '=', expected),
            ),
          );
    const observed = watched(executor, probes);
    const outcome = await runOrgFenced(
      observed.executor,
      ctx,
      fence,
      guard,
      [
        ...cas,
        scalar(
          db
            .updateTable('service_principal')
            .set({ status: to, revision: sql`revision + 1`, updated_at: stamp, last_op_id: opId })
            .where('org_id', '=', ctx.orgId)
            .where('id', '=', id)
            .where('status', '=', from)
            .returning('id'),
        ),
        scalar(
          db
            .selectFrom('service_principal')
            .select('status')
            .where('org_id', '=', ctx.orgId)
            .where('id', '=', id),
        ),
        ...mutationStatements(ctx, input, {
          sql: 'exists (select 1 from service_principal where org_id = ? and id = ? and last_op_id = ? and status = ?)',
          params: [ctx.orgId, id, opId, to],
        }),
      ],
      probes,
    );
    if (!outcome.ok) {
      if (outcome.reason === 'indeterminate') return 'indeterminate';
      if (outcome.reason === 'unclassified' && !(await exists(ctx, id))) return 'not_found';
      const error = observed.failure();
      if (error !== null && isDataFailure(error)) return 'indeterminate';
      const reason = failed({ reason: outcome.reason });
      return reason === 'conflict' && expected !== undefined
        ? 'conflict'
        : reason === 'indeterminate'
          ? 'indeterminate'
          : 'authority';
    }
    const [changed, state] = outcome.results.slice(guard.length + cas.length);
    if (changed !== undefined && changed.rows.length > 0) return done;
    return state !== undefined && state.rows.length > 0 ? 'not_suspended' : 'not_found';
  }
}
