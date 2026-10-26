import { sql, type SqlBool } from 'kysely';
import type { SourcePackageStore } from '@package-broker/core/api/routes/source-packages';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { assertGuard, compile, db, runOrgFenced, type ProtectedHolderProvider } from '../kysely.js';
import { actorHolds } from './actor-authority.js';
import { auditPendingStatement } from './audit-pending.js';

export function sourcePackagePresentStatement(
  ctx: OrgContext,
  sourceId: string,
  key: string,
): Statement {
  return compile(
    db
      .selectFrom('package as p')
      .innerJoin('source as s', 's.id', 'p.source_id')
      .select('p.id')
      .where('p.org_id', '=', ctx.orgId)
      .where('s.org_id', '=', ctx.orgId)
      .where('p.source_id', '=', sourceId)
      .where('p.name', '=', key)
      .where('p.status', '=', 'active')
      .where('p.last_synced_at', 'is not', null)
      .limit(1),
  );
}

export function createSourcePackageStore(
  executor: SqlExecutor,
  providerAnchors: readonly ProtectedHolderProvider[],
): SourcePackageStore {
  return {
    async present(ctx, sourceId, key) {
      return (await executor.all(sourcePackagePresentStatement(ctx, sourceId, key))).length > 0;
    },
    async request(ctx, fence, input) {
      const authority = actorHolds(ctx, fence, {
        permission: 'project:sources:write',
        projectId: input.projectId,
        providerAnchors,
      });
      const target = sql<SqlBool>`exists (select 1 from source as target
        join project_source as attachment on attachment.source_id = target.id
        join project as project on project.id = attachment.project_id
        where target.org_id = ${ctx.orgId} and attachment.org_id = ${ctx.orgId}
          and project.org_id = ${ctx.orgId} and project.status = 'active'
          and target.id = ${input.sourceId} and attachment.project_id = ${input.projectId}
          and (target.project_id is null or target.project_id = ${input.projectId})
          and target.status <> 'paused'
          and target.type in ('packagist_proxy', 'npmjs_proxy', 'npm_registry'))`;
      const probe = (condition: typeof authority) =>
        compile(db.selectNoFrom(sql<number>`(${condition}) is not 1`.as('refused')));
      const result = await runOrgFenced(
        executor,
        ctx,
        fence,
        assertGuard(sql<SqlBool>`(${authority} and ${target})`, ctx),
        input.audit === undefined ? [] : [auditPendingStatement(ctx, input.audit)],
        { authority: probe(authority), conflict: probe(target) },
      );
      if (result.ok) return 'accepted';
      if (result.reason === 'authority') return 'forbidden';
      if (result.reason === 'conflict') return 'not_found';
      return 'unavailable';
    },
  };
}
