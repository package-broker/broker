import { sql } from 'kysely';
import type { OrgContext, ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import type {
  NpmVcsBuildPayload,
  NpmVcsBuildTarget,
} from '@package-broker/core/ingest/npm-vcs-build-job';
import { compile, db } from '../kysely.js';

export function npmVcsBuildTargetStatement(
  ctx: OrgContext,
  input: Pick<NpmVcsBuildPayload, 'packageId' | 'versionId' | 'sourceId'>,
): ScalarStatement {
  return compile(
    db
      .selectFrom('version as nv')
      .innerJoin('package as np', 'np.id', 'nv.package_id')
      .innerJoin('source as ns', 'ns.id', 'np.source_id')
      .select([
        'np.name as packageName',
        'nv.version as version',
        'nv.revision as revision',
        'nv.source_ref as sourceRef',
      ])
      .where('nv.org_id', '=', ctx.orgId)
      .where('np.org_id', '=', ctx.orgId)
      .where('ns.org_id', '=', ctx.orgId)
      .where('nv.id', '=', input.versionId)
      .where('np.id', '=', input.packageId)
      .where('ns.id', '=', input.sourceId)
      .where('nv.status', '=', 'active')
      .where('nv.blob_id', 'is', null)
      .where('np.ecosystem', '=', 'npm')
      .where('ns.ecosystem', '=', 'npm')
      .where('ns.type', '=', 'vcs')
      .where('ns.status', '=', 'active')
      .where(sql<boolean>`nv.dist_type = 'tgz' AND nv.source_ref IS NOT NULL`),
  ) as ScalarStatement;
}
export function createNpmVcsBuildReader(executor: ScalarSqlExecutor) {
  return async (
    ctx: OrgContext,
    input: Pick<NpmVcsBuildPayload, 'packageId' | 'versionId' | 'sourceId'>,
  ): Promise<NpmVcsBuildTarget | null> => {
    const [row] = await executor.all<NpmVcsBuildTarget>(npmVcsBuildTargetStatement(ctx, input));
    return row ?? null;
  };
}

export function createNpmVcsBuildPendingReader(executor: ScalarSqlExecutor) {
  return async (ctx: OrgContext, versionId: string): Promise<boolean> => {
    const rows = await executor.all(
      compile(
        db
          .selectFrom('job')
          .select('id')
          .where('org_id', '=', ctx.orgId)
          .where('type', '=', 'core:npm-vcs-build:v1')
          .where('resource_key', '=', versionId)
          .where('state', 'in', ['queued', 'running'])
          .limit(1),
      ) as ScalarStatement,
    );
    return rows.length > 0;
  };
}
