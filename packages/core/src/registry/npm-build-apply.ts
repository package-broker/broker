import type { ApplyDeps } from '../ingest/apply-description.js';
import type { OrgContext } from '../db/port.js';
import type { Clock } from '../ids.js';
import type { CoreJobs } from '../platform/jobs.js';
import type { SourceType } from '../sources/config.js';
import {
  NPM_VCS_BUILD_JOB_TYPE,
  npmVcsBuildEnqueueInput,
  type NpmVcsBuildPayload,
  type NpmVcsBuildTarget,
} from '../ingest/npm-vcs-build-job.js';

/** Include source/version reads, target reads and four enqueue statements in apply planning. */
export function withNpmVcsBuildEnqueue(
  apply: ApplyDeps,
  deps: {
    readonly source: (ctx: OrgContext, id: string) => Promise<{ readonly type: SourceType } | null>;
    readonly target:
      | ((ctx: OrgContext, payload: NpmVcsBuildPayload) => Promise<NpmVcsBuildTarget | null>)
      | undefined;
    readonly jobs: Pick<CoreJobs, 'enqueue'> | undefined;
    readonly clock: Clock;
  },
): ApplyDeps {
  if (deps.target === undefined || deps.jobs === undefined) return apply;
  const { target, jobs } = deps;
  return {
    ...apply,
    writer: {
      ...apply.writer,
      get statementBudget() {
        return apply.writer.statementBudget;
      },
      syncPackageCost(input) {
        return (
          apply.writer.syncPackageCost(input) + (input.versions > 0 ? 2 + 5 * input.versions : 0)
        );
      },
      async syncPackage(ctx, guard, input) {
        const result = await apply.writer.syncPackage(ctx, guard, input);
        if (input.ecosystem !== 'npm' || input.versions.length === 0) return result;
        let statements = 1;
        if ((await deps.source(ctx, input.sourceId))?.type === 'vcs') {
          const rows = await apply.existing.existingVersions(ctx, {
            packageId: result.packageId,
            after: null,
            withMetadata: false,
            limit: input.versions.length,
            keys: input.versions.map((v) => v.versionNormalized),
          });
          statements++;
          for (const version of rows.rows) {
            const payload = {
              sourceId: input.sourceId,
              packageId: result.packageId,
              versionId: version.id,
              version: version.versionNormalized,
            };
            statements++;
            if ((await target(ctx, payload)) !== null) {
              await jobs.enqueue(
                ctx,
                NPM_VCS_BUILD_JOB_TYPE,
                payload,
                npmVcsBuildEnqueueInput(payload, deps.clock.now().getTime()),
              );
              statements += 4;
            }
          }
        }
        return { ...result, statements: result.statements + statements };
      },
    },
  };
}
