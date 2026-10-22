import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { compile, db } from '../kysely.js';

export interface ProjectSourceReader {
  list(
    ctx: OrgContext,
    input: { readonly projectId: string },
  ): Promise<readonly { readonly sourceId: string }[]>;
}

export function projectSourceIdsStatement(ctx: OrgContext, projectId: string): Statement {
  return compile(
    db
      .selectFrom('project_source as ps')
      .innerJoin('source as s', 's.id', 'ps.source_id')
      .select('ps.source_id')
      .where('ps.org_id', '=', ctx.orgId)
      .where('s.org_id', '=', ctx.orgId)
      .where('ps.project_id', '=', projectId)
      .orderBy('ps.precedence')
      .orderBy('ps.source_id'),
  );
}

export function createProjectSourceReader(executor: SqlExecutor): ProjectSourceReader {
  return {
    async list(ctx, { projectId }) {
      if (typeof projectId !== 'string' || projectId === '') {
        throw new RangeError('project id must be a non-empty string');
      }
      const rows = await executor.all<{ source_id: string }>(
        projectSourceIdsStatement(ctx, projectId),
      );
      return rows.map((row) => ({ sourceId: row.source_id }));
    },
  };
}
