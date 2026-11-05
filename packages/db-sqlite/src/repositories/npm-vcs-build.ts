import { sql, type SqlBool } from 'kysely';
import type { JobGuard } from '@package-broker/core/platform/job-repository';
import type { SqlExecutor } from '@package-broker/core/db/port';
import type { NpmPackSkipCode } from '@package-broker/core/sources/source-error-codes';
import { registerCatalogueWriteGuard } from '../internal/catalogue-write-guard.js';
import { jobLeaseGuard } from './job-lease-guard.js';
import type { OrgContext, ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import type {
  NpmVcsBuildPayload,
  NpmVcsBuildTarget,
} from '@package-broker/core/ingest/npm-vcs-build-job';
import { assertCheck, compile, db } from '../kysely.js';

export function npmVcsBuildTargetStatement(
  ctx: OrgContext,
  input: Pick<
    NpmVcsBuildPayload,
    'packageId' | 'versionId' | 'sourceId' | 'packingPolicy' | 'sourceRef'
  >,
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
        sql<number>`coalesce((select retry_generation from npm_vcs_build_outcome as bo where bo.org_id = ${ctx.orgId} and bo.version_id = nv.id and bo.source_ref = nv.source_ref and bo.packing_policy = ${input.packingPolicy ?? 'npm-pack-v1'}), 0)`.as(
          'retryGeneration',
        ),
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
      .where(sql<boolean>`nv.dist_type = 'tgz' AND nv.source_ref IS NOT NULL`)
      .where(
        sql<boolean>`NOT EXISTS (SELECT 1 FROM npm_vcs_build_outcome AS terminal WHERE terminal.org_id = ${ctx.orgId} AND terminal.version_id = nv.id AND terminal.source_ref = nv.source_ref AND terminal.packing_policy = ${input.packingPolicy ?? 'npm-pack-v1'} AND terminal.outcome IS NOT NULL)`,
      ),
  ) as ScalarStatement;
}
export function createNpmVcsBuildReader(executor: ScalarSqlExecutor) {
  return async (
    ctx: OrgContext,
    input: Pick<
      NpmVcsBuildPayload,
      'packageId' | 'versionId' | 'sourceId' | 'packingPolicy' | 'sourceRef'
    >,
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

export function createNpmVcsBuildOutcomes(executor: SqlExecutor) {
  function guard(ctx: OrgContext, lease: JobGuard, input: NpmVcsBuildPayload) {
    if (!input.sourceRef || !input.packingPolicy || input.retryGeneration === undefined)
      throw new TypeError('invalid_build_identity');
    return registerCatalogueWriteGuard(ctx, [
      ...jobLeaseGuard(ctx, lease),
      ...assertCheck(sql<SqlBool>`EXISTS (SELECT 1 FROM version AS ov
        JOIN package AS op ON op.id = ov.package_id AND op.org_id = ${ctx.orgId}
        JOIN source AS os ON os.id = op.source_id AND os.org_id = ${ctx.orgId}
        WHERE ov.org_id = ${ctx.orgId} AND ov.id = ${input.versionId}
          AND op.id = ${input.packageId} AND os.id = ${input.sourceId}
          AND ov.source_ref = ${input.sourceRef} AND ov.status = 'active'
          AND os.status = 'active' AND os.type = 'vcs' AND os.ecosystem = 'npm'
          AND coalesce((SELECT retry_generation FROM npm_vcs_build_outcome AS fence_outcome
            WHERE fence_outcome.org_id = ${ctx.orgId} AND fence_outcome.version_id = ov.id
              AND fence_outcome.source_ref = ${input.sourceRef} AND fence_outcome.packing_policy = ${input.packingPolicy}), 0) = ${input.retryGeneration})`),
    ]);
  }
  return {
    async terminal(
      ctx: OrgContext,
      input: Pick<NpmVcsBuildPayload, 'sourceId' | 'packageId' | 'versionId' | 'packingPolicy'>,
    ): Promise<boolean> {
      const rows = await executor.all(
        compile(
          db
            .selectFrom('npm_vcs_build_outcome as bo')
            .innerJoin('version as tv', 'tv.id', 'bo.version_id')
            .innerJoin('package as tp', 'tp.id', 'tv.package_id')
            .select('bo.version_id')
            .where('bo.org_id', '=', ctx.orgId)
            .where('tv.org_id', '=', ctx.orgId)
            .where('tp.org_id', '=', ctx.orgId)
            .where('tp.source_id', '=', input.sourceId)
            .where('tp.id', '=', input.packageId)
            .where('tv.id', '=', input.versionId)
            .whereRef('bo.source_ref', '=', 'tv.source_ref')
            .where('bo.packing_policy', '=', input.packingPolicy ?? 'npm-pack-v1')
            .where('bo.outcome', 'is not', null),
        ),
      );
      return rows.length > 0;
    },
    writeGuard: guard,
    async start(ctx: OrgContext, lease: JobGuard, input: NpmVcsBuildPayload) {
      await executor.batch([
        ...guard(ctx, lease, input),
        compile(
          db
            .insertInto('npm_vcs_build_outcome')
            .values({
              org_id: ctx.orgId,
              version_id: input.versionId,
              source_ref: input.sourceRef!,
              packing_policy: input.packingPolicy!,
              retry_generation: input.retryGeneration!,
              outcome: null,
            })
            .onConflict((oc) =>
              oc.columns(['org_id', 'version_id', 'source_ref', 'packing_policy']).doNothing(),
            ),
        ),
      ]);
    },
    async finish(
      ctx: OrgContext,
      lease: JobGuard,
      input: NpmVcsBuildPayload,
      outcome: NpmPackSkipCode,
    ) {
      await executor.batch([
        ...guard(ctx, lease, input),
        compile(
          db
            .insertInto('npm_vcs_build_outcome')
            .values({
              org_id: ctx.orgId,
              version_id: input.versionId,
              source_ref: input.sourceRef!,
              packing_policy: input.packingPolicy!,
              retry_generation: input.retryGeneration!,
              outcome,
            })
            .onConflict((oc) =>
              oc
                .columns(['org_id', 'version_id', 'source_ref', 'packing_policy'])
                .doUpdateSet({ outcome }),
            ),
        ),
      ]);
    },
  };
}

export function npmVcsBuildRetryStatement(ctx: OrgContext, sourceId: string) {
  return compile(
    db
      .updateTable('npm_vcs_build_outcome')
      .set({ outcome: null, retry_generation: sql<number>`retry_generation + 1` })
      .where('org_id', '=', ctx.orgId)
      .where(
        'version_id',
        'in',
        db
          .selectFrom('version as rv')
          .innerJoin('package as rp', 'rp.id', 'rv.package_id')
          .innerJoin('source as rs', 'rs.id', 'rp.source_id')
          .select('rv.id')
          .where('rv.org_id', '=', ctx.orgId)
          .where('rp.org_id', '=', ctx.orgId)
          .where('rs.org_id', '=', ctx.orgId)
          .where('rs.id', '=', sourceId),
      ),
  );
}
