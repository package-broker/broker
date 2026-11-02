import type { CatalogueWriter } from '../db/catalogue.js';
import type { ExistingVersionsReader } from '../db/existing-versions.js';
import type { SourceRepository } from '../db/source.js';
import type { Clock } from '../ids.js';
import type { CoreJobs } from '../platform/jobs.js';
import type { OrgContext } from '../db/port.js';
import {
  NPM_VCS_BUILD_JOB_TYPE,
  npmVcsBuildEnqueueInput,
  type NpmVcsBuildPayload,
  type NpmVcsBuildTarget,
} from './npm-vcs-build-job.js';

export function createNpmVcsEagerWriter(
  writer: CatalogueWriter,
  deps: {
    readonly sources: Pick<SourceRepository, 'get'>;
    readonly existing: ExistingVersionsReader;
    readonly target:
      | ((ctx: OrgContext, payload: NpmVcsBuildPayload) => Promise<NpmVcsBuildTarget | null>)
      | undefined;
    readonly jobs: Pick<CoreJobs, 'enqueue'> | undefined;
    readonly packingPolicy: string;
    readonly clock: Clock;
  },
): CatalogueWriter {
  // One source read and one version-page read; each member adds a target read and four enqueue statements.
  const extra = (versions: number) => 2 + versions * 5;
  return {
    ...writer,
    resyncsUnchangedNpmVcs: deps.target !== undefined && deps.jobs !== undefined,
    get statementBudget() {
      return {
        ...writer.statementBudget,
        syncPackage: writer.statementBudget.syncPackage + extra(50),
      };
    },
    syncPackageCost(shape) {
      return writer.syncPackageCost(shape) + extra(shape.versions);
    },
    async syncPackage(ctx, guard, input) {
      const result = await writer.syncPackage(ctx, guard, input);
      if (
        input.ecosystem !== 'npm' ||
        input.versions.length === 0 ||
        deps.target === undefined ||
        deps.jobs === undefined
      )
        return result;
      if ((await deps.sources.get(ctx, input.sourceId))?.type !== 'vcs')
        return { ...result, statements: result.statements + 1 };
      let statements = 2;
      const rows = await deps.existing.existingVersions(ctx, {
        packageId: result.packageId,
        after: null,
        withMetadata: false,
        limit: input.versions.length,
        keys: input.versions.map((v) => v.versionNormalized),
      });
      for (const version of rows.rows) {
        const payload = {
          sourceId: input.sourceId,
          packageId: result.packageId,
          versionId: version.id,
          version: version.versionNormalized,
          packingPolicy: deps.packingPolicy,
        };
        const target = await deps.target(ctx, payload);
        statements++;
        if (target === null) continue;
        const identity = {
          ...payload,
          sourceRef: target.sourceRef,
          retryGeneration: target.retryGeneration,
        };
        await deps.jobs.enqueue(
          ctx,
          NPM_VCS_BUILD_JOB_TYPE,
          identity,
          npmVcsBuildEnqueueInput(identity, deps.clock.now().getTime()),
        );
        statements += 4;
      }
      return { ...result, statements: result.statements + statements };
    },
  };
}
