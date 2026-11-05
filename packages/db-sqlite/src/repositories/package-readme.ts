import { sql } from 'kysely';
import type { OrgContext, ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import type { PackageRef } from '@package-broker/core/db/catalogue';
import { compile, db } from '../kysely.js';
import { visibleWinner } from './catalogue-read.js';

export function createPackageReadmeReader(executor: ScalarSqlExecutor) {
  return {
    async get(
      ctx: OrgContext,
      query: PackageRef,
    ): Promise<{ filename: string; body: string } | null> {
      if (query.ecosystem !== 'npm') return null;
      const raw = sql`with w as ${visibleWinner(ctx, query.projectId, query.ecosystem, query.key)}
        select r.filename,r.body from w
        join dist_tag dt on dt.package_id = w.package_id and dt.org_id = ${ctx.orgId} and dt.tag = 'latest'
        join version v on v.id = dt.version_id and v.package_id = w.package_id and v.org_id = ${ctx.orgId} and v.status = 'active'
        join version_readme r on r.version_id = v.id and r.org_id = ${ctx.orgId}`;
      const rows = await executor.all<{ filename: string; body: string }>(
        compile({ compile: () => raw.compile(db) }) as ScalarStatement,
      );
      return rows[0] ?? null;
    },
  };
}
