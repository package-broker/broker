import { monotonicNow } from '../internal/catalogue-write-guard.js';
import { sql, type RawBuilder, type SqlBool } from 'kysely';
import { fenceKind } from '@package-broker/core/authz/fence';
import type { PackageDetailRepository } from '@package-broker/core/db/package-admin';
import type { ScalarStatement, SqlExecutor } from '@package-broker/core/db/port';
import { assertGuard, compile, db, runOrgFenced, type ProtectedHolderProvider } from '../kysely.js';
import { visibleWinner } from './catalogue-read.js';
import { actorHolds } from './actor-authority.js';
import { visibilityAuditStatements } from './visibility-audit.js';
import { rederiveStatements } from './visibility-derive.js';

const statement = (raw: RawBuilder<unknown>) =>
  compile({ compile: () => raw.compile(db) }) as ScalarStatement;

export function createPackageDetailRepository(
  executor: SqlExecutor,
  providerAnchors: readonly ProtectedHolderProvider[] = [],
): PackageDetailRepository {
  return {
    async packageName(ctx, packageId) {
      const [pkg] = await executor.all<{ name: string }>(
        statement(
          sql`select name from package where org_id = ${ctx.orgId} and id = ${packageId} and ecosystem = 'npm'`,
        ),
      );
      return pkg?.name ?? null;
    },
    async readme(ctx, query) {
      const [pkg] = await executor.all<{ name: string; ecosystem: 'npm' | 'composer' }>(
        statement(sql`
        select name, ecosystem from package where org_id = ${ctx.orgId} and id = ${query.packageId}`),
      );
      if (!pkg || pkg.ecosystem !== 'npm') return null;
      const winner = visibleWinner(ctx, query.projectId, pkg.ecosystem, pkg.name);
      const version =
        query.version === undefined
          ? sql`v.id = (select dt.version_id from dist_tag dt where dt.org_id = ${ctx.orgId} and dt.package_id = w.package_id and dt.tag = 'latest')`
          : sql`v.version = ${query.version}`;
      const [readme] = await executor.all<{ filename: string; body: string }>(
        statement(sql`
        with w as ${winner}
        select r.filename, r.body from w
        join version v on v.package_id = w.package_id and v.org_id = ${ctx.orgId} and v.status = 'active'
        join version_readme r on r.version_id = v.id and r.org_id = ${ctx.orgId}
        where w.package_id = ${query.packageId} and ${version}`),
      );
      return readme ?? null;
    },
    async setAccess(ctx, fence, input) {
      if (fenceKind(fence) !== 'session') throw new TypeError('package access requires a session');
      if (
        typeof input.visibleToNewProjects !== 'boolean' ||
        !['none', 'request'].includes(input.newProjectAccessMode) ||
        (input.newProjectAccessMode === 'request' && input.visibleToNewProjects) ||
        !Number.isSafeInteger(input.revision) ||
        input.revision < 1
      )
        throw new TypeError('invalid package access');
      const [pkg] = await executor.all<{
        project_id: string | null;
        visible_to_new_projects: number;
        new_project_access_mode: string;
      }>(
        statement(
          sql`select source.project_id, package.visible_to_new_projects, package.new_project_access_mode from package join source on source.id = package.source_id where package.org_id = ${ctx.orgId} and source.org_id = ${ctx.orgId} and package.id = ${input.packageId}`,
        ),
      );
      if (!pkg) return { ok: false, error: 'not_found' };
      const authority = actorHolds(ctx, fence, {
        permission: pkg.project_id === null ? 'org:sources:write' : 'project:sources:write',
        projectId: pkg.project_id,
        providerAnchors,
      });
      const state = sql<SqlBool>`exists (select 1 from package join source on source.id = package.source_id where package.org_id = ${ctx.orgId} and source.org_id = ${ctx.orgId} and source.project_id is ${pkg.project_id} and package.id = ${input.packageId} and package.rev = ${input.revision})`;
      const both = sql<SqlBool>`((${authority}) and (${state}))`;
      const outcome = await runOrgFenced(
        executor,
        ctx,
        fence,
        assertGuard(both, ctx),
        [
          statement(sql`update package set visible_to_new_projects = ${input.visibleToNewProjects ? 1 : 0},
          new_project_access_mode = ${input.newProjectAccessMode}, rev = rev + 1,
          modified_at = ${monotonicNow}
          where org_id = ${ctx.orgId} and id = ${input.packageId} and rev = ${input.revision}`),
          ...visibilityAuditStatements(ctx, {
            ...input,
            audit: {
              ...input.audit,
              payloadJson: JSON.stringify({
                ...JSON.parse(input.audit.payloadJson),
                changes: {
                  visible_to_new_projects: {
                    old: pkg.visible_to_new_projects === 1,
                    new: input.visibleToNewProjects,
                  },
                  new_project_access_mode: {
                    old: pkg.new_project_access_mode,
                    new: input.newProjectAccessMode,
                  },
                },
              }),
            },
          }),
          ...rederiveStatements(ctx, { kind: 'package', packageId: input.packageId }),
        ],
        {
          authority: statement(sql`select (${authority}) is not 1 as failed`),
          conflict: statement(sql`select (${state}) is not 1 as failed`),
        },
      );
      if (outcome.ok) return { ok: true };
      return {
        ok: false,
        error:
          outcome.reason === 'authority'
            ? 'forbidden'
            : outcome.reason === 'conflict'
              ? 'conflict'
              : 'unavailable',
      };
    },
  };
}
