import { sql, type Compilable } from 'kysely';
import { PERMISSIONS, isPermission } from '@package-broker/core/authz/permissions';
import {
  runFenced,
  type FailureProbes,
  type FenceGuard,
  type MutationFence,
} from '@package-broker/core/authz/fence';
import type { OrgContext, ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import { assertGuard, compile, db, existsGuard } from '../kysely.js';

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
    input: {
      readonly id: string;
      readonly name: string;
      readonly projectId: string | null;
      readonly createdByUserId: string;
      readonly permissions: readonly string[];
      readonly now: string;
      readonly opId: string;
    },
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
    id: string,
    permissions: readonly string[],
    now: string,
    opId: string,
  ): Promise<
    'updated' | 'not_found' | 'invalid_permissions' | 'conflict' | 'authority' | 'indeterminate'
  >;
  /** Suspending a suspended principal answers `suspended` and rewrites nothing. */
  suspend(
    ctx: OrgContext,
    fence: MutationFence,
    guard: FenceGuard,
    id: string,
    now: string,
    opId: string,
  ): Promise<'suspended' | 'not_found' | 'authority' | 'indeterminate'>;
  restore(
    ctx: OrgContext,
    fence: MutationFence,
    guard: FenceGuard,
    id: string,
    now: string,
    opId: string,
  ): Promise<'restored' | 'not_suspended' | 'not_found' | 'authority' | 'indeterminate'>;
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

const ALWAYS: FailureProbes = {
  authority: { sql: 'SELECT 1 AS refused', params: [] },
};

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

export function createServicePrincipalRepository(
  executor: ScalarSqlExecutor,
): ServicePrincipalRepository {
  async function load(ctx: OrgContext, id: string): Promise<ServicePrincipal | null> {
    const rows = await executor.all<PrincipalRow>(scalar(selectPrincipals(ctx, id)));
    return toPrincipals(rows)[0] ?? null;
  }

  return {
    get: load,

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
        .onConflict((conflict) => conflict.doNothing())
        .returning('id');

      const permissions = insertPermissions(ctx, input.id, input.permissions, (source) =>
        source
          .where('sp.name', '=', input.name)
          .where('sp.created_by_user_id', '=', input.createdByUserId)
          .where('sp.created_at', '=', now)
          .where('sp.updated_at', '=', now)
          .where('sp.revision', '=', 1)
          .where('sp.last_op_id', '=', input.opId)
          .where(sql<boolean>`changes() = 1`)
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

      const outcome = await runFenced(
        executor,
        fence,
        guard,
        [scalar(principal), permissions],
        ALWAYS,
      );
      if (!outcome.ok)
        return failed({ reason: outcome.reason }) === 'indeterminate'
          ? 'indeterminate'
          : 'authority';
      const inserted = outcome.results[guard.length];
      if (inserted !== undefined && inserted.rows.length > 0) return 'created';

      const [creator, project, clash] = await Promise.all([
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
        executor.all(
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
        ),
      ]);
      if (creator.length === 0)
        throw new TypeError('createdByUserId must be a user of the organization');
      if (project.length === 0) return 'project_mismatch';
      if (clash.length > 0) return 'duplicate';
      throw new TypeError('service principal was not stored');
    },

    async setPermissions(ctx, fence, guard, id, permissions, now, opId) {
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
      const cas = assertGuard(
        existsGuard((database) =>
          database
            .selectFrom('service_principal')
            .select('id')
            .where('org_id', '=', ctx.orgId)
            .where('id', '=', id)
            .where('revision', '=', expected),
        ),
      );

      const outcome = await runFenced(
        executor,
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
        ],
        probes,
      );
      return outcome.ok ? 'updated' : failed(outcome);
    },

    async suspend(ctx, fence, guard, id, now, opId) {
      const result = await transition(
        ctx,
        fence,
        guard,
        id,
        now,
        opId,
        'active',
        'suspended',
        'suspended',
      );
      return result === 'not_suspended' ? 'suspended' : result;
    },

    async restore(ctx, fence, guard, id, now, opId) {
      return transition(ctx, fence, guard, id, now, opId, 'suspended', 'active', 'restored');
    },
  };

  async function transition<Done extends string>(
    ctx: OrgContext,
    fence: MutationFence,
    guard: FenceGuard,
    id: string,
    now: string,
    opId: string,
    from: 'active' | 'suspended',
    to: 'active' | 'suspended',
    done: Done,
  ): Promise<Done | 'not_found' | 'not_suspended' | 'authority' | 'indeterminate'> {
    requireNonEmpty(id, 'id');
    requireNonEmpty(opId, 'opId');
    const stamp = timestamp(now);
    const outcome = await runFenced(
      executor,
      fence,
      guard,
      [
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
      ],
      ALWAYS,
    );
    if (!outcome.ok)
      return failed({ reason: outcome.reason }) === 'indeterminate' ? 'indeterminate' : 'authority';
    const [changed, state] = outcome.results.slice(guard.length);
    if (changed !== undefined && changed.rows.length > 0) return done;
    return state !== undefined && state.rows.length > 0 ? 'not_suspended' : 'not_found';
  }
}
