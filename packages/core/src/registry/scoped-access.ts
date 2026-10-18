import { packageKey } from '../catalogue/names.js';
import { PACKAGES_READ } from '../catalogue/package-access.js';
import type { PackageVisibilityPort } from '../db/catalogue.js';
import type { OrgContext } from '../db/port.js';

interface ScopedAdmission {
  admitScoped(
    ctx: OrgContext,
    query: { readonly projectId: string; readonly key: string },
  ): Promise<readonly string[]>;
}

export function createScopedAdmittingAccess(
  packageAccess: PackageVisibilityPort,
  scopedAdmission: ScopedAdmission,
): PackageVisibilityPort {
  return {
    async resolve(actor, ecosystem, rawName) {
      const outcome = await packageAccess.resolve(actor, ecosystem, rawName);
      if (
        outcome.kind !== 'absent' ||
        ecosystem !== 'npm' ||
        actor.kind !== 'project' ||
        !actor.permissions.has(PACKAGES_READ)
      ) {
        return outcome;
      }
      let key: string;
      try {
        key = packageKey(rawName, { ecosystem, legacyCase: true });
      } catch {
        return outcome;
      }
      if (!key.startsWith('@')) {
        return outcome;
      }
      const sourceIds = await scopedAdmission.admitScoped(
        { orgId: actor.orgId },
        { projectId: actor.projectId, key },
      );
      return sourceIds.length > 0
        ? { kind: 'proxy_admissible', projectId: actor.projectId, ecosystem, key, sourceIds }
        : outcome;
    },
  };
}
