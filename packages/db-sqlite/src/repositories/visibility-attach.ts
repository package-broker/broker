import { sql, type SqlBool } from 'kysely';
import type { FailureProbes, MutationFence } from '@package-broker/core/authz/fence';
import type { VisibilityStore, VisibilityWriteResult } from '@package-broker/core/db/catalogue';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { isUlid } from '@package-broker/core/ids';
import {
  assertGuard,
  compile,
  db,
  newOpId,
  runOrgFenced,
  type Guard,
  type ProtectedHolderProvider,
} from '../kysely.js';
import { actorHolds } from './actor-authority.js';
import { visibilityAuditStatements } from './visibility-audit.js';
import { rederiveStatements } from './visibility-derive.js';

const PROXY_TYPES = sql`('packagist_proxy', 'npmjs_proxy')`;
const DEFAULT_PRECEDENCE = sql<number>`case when type in ${PROXY_TYPES} then 1000 else 100 end`;

export type VisibilityAttachRepository = Pick<
  VisibilityStore,
  'attachSource' | 'detachSource' | 'setPrecedence' | 'setOrder' | 'setPackageFlag'
>;

export interface VisibilityAttachOptions {
  readonly providerAnchors: readonly ProtectedHolderProvider[];
}

function precedenceOf(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('precedence must be a non-negative safe integer');
  }
  return value;
}

function allOf(...conditions: Guard[]): Guard {
  return sql<SqlBool>`(${sql.join(conditions, sql` and `)})`;
}

function probe(condition: Guard): Statement {
  return compile(db.selectNoFrom(sql<number>`(${condition}) is not 1`.as('failed')));
}

function activeProject(ctx: OrgContext, projectId: string): Guard {
  return sql<SqlBool>`exists (select 1 from project as target_project
    where target_project.id = ${projectId} and target_project.org_id = ${ctx.orgId}
      and target_project.status = 'active')`;
}

/** S still has the owner the caller read, and that owner is null or P. */
function sourceServes(
  ctx: OrgContext,
  sourceId: string,
  owner: string | null,
  projectId: string,
): Guard {
  return sql<SqlBool>`exists (select 1 from source as target_source
    where target_source.id = ${sourceId} and target_source.org_id = ${ctx.orgId}
      and target_source.project_id is ${owner}
      and (target_source.project_id is null or target_source.project_id = ${projectId}))`;
}

function isAttached(ctx: OrgContext, projectId: string, sourceId: string): Guard {
  return sql<SqlBool>`exists (select 1 from project_source as target_attachment
    where target_attachment.org_id = ${ctx.orgId} and target_attachment.project_id = ${projectId}
      and target_attachment.source_id = ${sourceId})`;
}

export function attachSourceStatements(ctx: OrgContext, projectId: string): Statement[] {
  const insert = db
    .insertInto('project_source')
    .columns(['org_id', 'project_id', 'source_id', 'precedence'])
    .expression(
      db
        .selectFrom('source')
        .select([
          'org_id',
          sql<string>`${projectId}`.as('project_id'),
          'id',
          DEFAULT_PRECEDENCE.as('precedence'),
        ])
        .where('org_id', '=', ctx.orgId)
        .where('project_id', 'is', null)
        .where(
          sql<SqlBool>`exists (select 1 from project as new_project
            where new_project.id = ${projectId} and new_project.org_id = ${ctx.orgId})`,
        ),
    )
    .onConflict((conflict) => conflict.columns(['project_id', 'source_id']).doNothing());
  return [compile(insert), ...rederiveStatements(ctx, { kind: 'project', projectId })];
}

export function createVisibilityAttachRepository(
  executor: SqlExecutor,
  options: VisibilityAttachOptions,
): VisibilityAttachRepository {
  const anchors = options.providerAnchors;

  function holds(
    ctx: OrgContext,
    fence: MutationFence,
    owner: string | null,
    projectId: string | null,
    allowArchived = false,
  ): Guard {
    return actorHolds(ctx, fence, {
      permission:
        owner === null && projectId === null ? 'org:sources:write' : 'project:sources:write',
      projectId: projectId ?? owner,
      allowArchived,
      providerAnchors: anchors,
    });
  }

  async function sourceOwner(
    ctx: OrgContext,
    sourceId: string,
  ): Promise<{ readonly owner: string | null } | null> {
    const [row] = await executor.all<{ project_id: string | null }>(
      compile(
        db
          .selectFrom('source')
          .select('project_id')
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', sourceId),
      ),
    );
    return row === undefined ? null : { owner: row.project_id };
  }

  async function exists(statement: Statement): Promise<boolean> {
    return (await executor.all(statement)).length > 0;
  }

  const projectInOrg = (ctx: OrgContext, projectId: string) =>
    exists(
      compile(
        db
          .selectFrom('project')
          .select('id')
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', projectId),
      ),
    );

  const attached = (ctx: OrgContext, projectId: string, sourceId: string) =>
    exists(
      compile(
        db
          .selectFrom('project_source')
          .select('source_id')
          .where('org_id', '=', ctx.orgId)
          .where('project_id', '=', projectId)
          .where('source_id', '=', sourceId),
      ),
    );

  /** The source and project of an attachment write, or null when either is absent or S cannot serve P. */
  async function locate(
    ctx: OrgContext,
    projectId: string,
    sourceId: string,
  ): Promise<{ readonly owner: string | null } | null> {
    const source = await sourceOwner(ctx, sourceId);
    if (source === null || (source.owner !== null && source.owner !== projectId)) return null;
    return (await projectInOrg(ctx, projectId)) ? source : null;
  }

  async function run(
    ctx: OrgContext,
    fence: MutationFence,
    authority: Guard,
    state: Guard,
    mutations: readonly Statement[],
    changed?: Guard,
  ): Promise<VisibilityWriteResult> {
    const probes: FailureProbes = { authority: probe(authority), conflict: probe(state) };
    const opId = newOpId();
    const guard = assertGuard(allOf(authority, state), ctx, changed);
    const outcome = await runOrgFenced(executor, ctx, fence, guard, mutations, probes);
    return outcome.ok ? { ok: true, opId } : { ok: false, reason: outcome.reason };
  }

  function projectRevision(ctx: OrgContext, projectId: string, changed?: Guard): Statement {
    return compile(
      db
        .updateTable('project')
        .set({ revision: sql<number>`revision + 1` })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', projectId)
        .where(changed ?? sql<SqlBool>`1`),
    );
  }

  const notFound: VisibilityWriteResult = { ok: false, reason: 'not_found' };

  return {
    async attachSource(ctx, fence, input) {
      const precedence =
        input.precedence === undefined ? undefined : precedenceOf(input.precedence);
      const found = await locate(ctx, input.projectId, input.sourceId);
      if (found === null) return notFound;
      const authority =
        found.owner === null
          ? allOf(holds(ctx, fence, null, null), activeProject(ctx, input.projectId))
          : holds(ctx, fence, found.owner, input.projectId);
      const insert = db
        .insertInto('project_source')
        .columns(['org_id', 'project_id', 'source_id', 'precedence'])
        .expression(
          db
            .selectFrom('source')
            .select([
              'org_id',
              sql<string>`${input.projectId}`.as('project_id'),
              'id',
              (precedence === undefined ? DEFAULT_PRECEDENCE : sql<number>`${precedence}`).as(
                'precedence',
              ),
            ])
            .where('org_id', '=', ctx.orgId)
            .where('id', '=', input.sourceId),
        )
        .onConflict((conflict) =>
          precedence === undefined
            ? conflict.columns(['project_id', 'source_id']).doNothing()
            : conflict
                .columns(['project_id', 'source_id'])
                .doUpdateSet({ precedence: (eb) => eb.ref('excluded.precedence') })
                .where(sql<SqlBool>`project_source.precedence is not excluded.precedence`),
        );
      const changed = sql<SqlBool>`not ${isAttached(ctx, input.projectId, input.sourceId)} or exists (
          select 1 from project_source where org_id = ${ctx.orgId}
          and project_id = ${input.projectId} and source_id = ${input.sourceId}
          and ${precedence === undefined ? sql<SqlBool>`0` : sql<SqlBool>`precedence is not ${precedence}`})`;
      const result = await run(
        ctx,
        fence,
        authority,
        sourceServes(ctx, input.sourceId, found.owner, input.projectId),
        [
          projectRevision(ctx, input.projectId, changed),
          compile(insert),
          ...visibilityAuditStatements(ctx, input),
          ...rederiveStatements(ctx, {
            kind: 'projectSource',
            projectId: input.projectId,
            sourceId: input.sourceId,
          }),
        ],
        changed,
      );
      return found.owner === null && !result.ok && result.reason === 'authority'
        ? notFound
        : result;
    },

    async detachSource(ctx, fence, input) {
      const found = await locate(ctx, input.projectId, input.sourceId);
      if (found === null || !(await attached(ctx, input.projectId, input.sourceId))) {
        return notFound;
      }
      const { projectId, sourceId } = input;
      const rows = db
        .deleteFrom('project_package')
        .where('org_id', '=', ctx.orgId)
        .where('project_id', '=', projectId)
        .where('package_id', 'in', (qb) =>
          qb
            .selectFrom('package')
            .select('id')
            .where('org_id', '=', ctx.orgId)
            .where('source_id', '=', sourceId),
        );
      const patterns = db
        .deleteFrom('project_package_pattern')
        .where('org_id', '=', ctx.orgId)
        .where('project_id', '=', projectId)
        .where('source_id', '=', sourceId);
      const attachment = db
        .deleteFrom('project_source')
        .where('org_id', '=', ctx.orgId)
        .where('project_id', '=', projectId)
        .where('source_id', '=', sourceId);
      return run(
        ctx,
        fence,
        holds(ctx, fence, found.owner, projectId, true),
        allOf(
          sourceServes(ctx, sourceId, found.owner, projectId),
          isAttached(ctx, projectId, sourceId),
        ),
        [
          projectRevision(ctx, projectId),
          compile(rows),
          compile(patterns),
          compile(attachment),
          ...visibilityAuditStatements(ctx, input),
        ],
      );
    },

    async setPrecedence(ctx, fence, input) {
      const precedence = precedenceOf(input.precedence);
      const found = await locate(ctx, input.projectId, input.sourceId);
      if (found === null || !(await attached(ctx, input.projectId, input.sourceId))) {
        return notFound;
      }
      const update = db
        .updateTable('project_source')
        .set({ precedence })
        .where('org_id', '=', ctx.orgId)
        .where('project_id', '=', input.projectId)
        .where('source_id', '=', input.sourceId)
        .where('precedence', 'is not', precedence);
      const changed = sql<SqlBool>`exists (select 1 from project_source where org_id = ${ctx.orgId}
          and project_id = ${input.projectId} and source_id = ${input.sourceId}
          and precedence is not ${precedence})`;
      return run(
        ctx,
        fence,
        holds(ctx, fence, found.owner, input.projectId),
        allOf(
          sourceServes(ctx, input.sourceId, found.owner, input.projectId),
          isAttached(ctx, input.projectId, input.sourceId),
        ),
        [
          projectRevision(ctx, input.projectId, changed),
          compile(update),
          ...visibilityAuditStatements(ctx, input),
        ],
        changed,
      );
    },

    async setOrder(ctx, fence, input) {
      const expected = fence.expected['project'];
      if (expected === undefined)
        throw new TypeError('fence must carry an expected project revision');
      const { projectId, sourceIds } = input;
      if (
        !Array.isArray(sourceIds) ||
        sourceIds.length === 0 ||
        sourceIds.some((id: unknown) => typeof id !== 'string' || !isUlid(id)) ||
        new Set(sourceIds).size !== sourceIds.length
      )
        throw new TypeError('invalid visibility order');
      const projects = await executor.all(
        compile(
          db
            .selectFrom('project')
            .select('id')
            .where('org_id', '=', ctx.orgId)
            .where('id', '=', projectId)
            .where('status', '=', 'active'),
        ),
      );
      if (projects.length === 0) return notFound;
      const attachments = await executor.all<{ source_id: string; project_id: string | null }>(
        compile(
          db
            .selectFrom('project_source as ps')
            .innerJoin('source as s', 's.id', 'ps.source_id')
            .select(['ps.source_id', 's.project_id'])
            .where('ps.org_id', '=', ctx.orgId)
            .where('s.org_id', '=', ctx.orgId)
            .where('ps.project_id', '=', projectId),
        ),
      );
      if (sourceIds.length > attachments.length)
        throw new TypeError('invalid visibility order size');
      const owners = new Map(attachments.map((row) => [row.source_id, row.project_id]));
      if (sourceIds.some((id) => !owners.has(id))) return { ok: false, reason: 'not_attached' };
      const order = JSON.stringify(sourceIds);
      const snapshot = JSON.stringify(sourceIds.map((id) => ({ id, owner: owners.get(id) })));
      // Allow archived here so a concurrent archive is classified by the state guard.
      // With a target project, holds checks the same permission for every source owner.
      const authority = holds(ctx, fence, null, projectId, true);
      const state = allOf(
        sql<SqlBool>`exists (select 1 from project where org_id = ${ctx.orgId}
          and id = ${projectId} and status = 'active' and revision = ${expected})`,
        sql<SqlBool>`(select count(*) from project_source where org_id = ${ctx.orgId}
          and project_id = ${projectId}) = ${sourceIds.length}`,
        sql<SqlBool>`(select count(*) from project_source as ps
          join source as s on s.id = ps.source_id
          join json_each(${snapshot}) as wanted on json_extract(wanted.value, '$.id') = ps.source_id
          where ps.org_id = ${ctx.orgId} and s.org_id = ${ctx.orgId}
            and ps.project_id = ${projectId}
            and s.project_id is json_extract(wanted.value, '$.owner')
            and (s.project_id is null or s.project_id = ${projectId})) = ${sourceIds.length}`,
        input.idempotency === undefined
          ? sql<SqlBool>`1`
          : sql<SqlBool>`not exists (
          select 1 from api_idempotency where org_id = ${ctx.orgId}
          and principal_key = ${input.idempotency.principalKey} and key = ${input.idempotency.key}
          and expires_at > ${input.idempotency.createdAt})`,
      );
      const changed = sql<SqlBool>`exists (select 1 from project_source as ps
        join json_each(${order}) as wanted on wanted.value = ps.source_id
        where ps.org_id = ${ctx.orgId} and ps.project_id = ${projectId}
          and ps.precedence is not cast(wanted.key as integer))`;
      const revision = projectRevision(ctx, projectId, changed);
      const precedence = sql<number>`(select cast(wanted.key as integer)
        from json_each(${order}) as wanted where wanted.value = project_source.source_id)`;
      const update = compile(
        db
          .updateTable('project_source')
          .set({ precedence })
          .where('org_id', '=', ctx.orgId)
          .where('project_id', '=', projectId)
          .where('precedence', 'is not', precedence),
      );
      return run(
        ctx,
        fence,
        authority,
        state,
        [revision, update, ...visibilityAuditStatements(ctx, input)],
        changed,
      );
    },

    async setPackageFlag(ctx, fence, input) {
      const flag = input.visibleToNewProjects ? 1 : 0;
      const [row] = await executor.all<{ project_id: string | null }>(
        compile(
          db
            .selectFrom('package')
            .innerJoin('source', 'source.id', 'package.source_id')
            .select('source.project_id')
            .where('package.org_id', '=', ctx.orgId)
            .where('source.org_id', '=', ctx.orgId)
            .where('package.id', '=', input.packageId),
        ),
      );
      if (row === undefined) return notFound;
      const owner = row.project_id;
      const update = db
        .updateTable('package')
        .set({ visible_to_new_projects: flag })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.packageId)
        .where('visible_to_new_projects', 'is not', flag);
      const state = sql<SqlBool>`exists (select 1 from package as target_package
        join source as owner_source on owner_source.id = target_package.source_id
        where target_package.id = ${input.packageId} and target_package.org_id = ${ctx.orgId}
          and owner_source.org_id = ${ctx.orgId} and owner_source.project_id is ${owner})`;
      return run(ctx, fence, holds(ctx, fence, owner, null), state, [
        compile(update),
        ...rederiveStatements(ctx, { kind: 'package', packageId: input.packageId }),
      ]);
    },
  };
}
