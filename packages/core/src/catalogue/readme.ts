import type { ProjectActor } from '../authz/project-actor.js';
import type { RequestContext } from '../plugin.js';
import { withPolicyRetry } from '../registry/policy/session.js';
import { createPolicyViews, type PackageViewPolicy } from './policy-views.js';

export interface ResolvedReadme {
  readonly filename: string;
  readonly body: string;
  /** The version whose readme this is; required to decide policy. */
  readonly versionId?: string;
}

/**
 * The readme inherits the decision of the exact version it was resolved from, latest included:
 * a hidden version yields no content and no other version is chosen in its place.
 */
export async function policyBoundReadme(
  policy: PackageViewPolicy,
  ctx: RequestContext,
  actor: ProjectActor,
  packageId: string,
  readme: ResolvedReadme,
): Promise<{ filename: string; body: string } | null> {
  const versionId = readme.versionId;
  if (versionId === undefined) return null;
  const views = createPolicyViews(policy, ctx, actor, 'readme');
  const permitted = await withPolicyRetry(async () => {
    const allowed = await views.permits(packageId, versionId);
    await views.seal();
    return allowed;
  });
  return permitted ? { filename: readme.filename, body: readme.body } : null;
}
