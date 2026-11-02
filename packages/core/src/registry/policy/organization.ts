import type { OrgContext } from '../../db/port.js';
import {
  policyPackageView,
  type PolicyEcosystem,
  type PolicySnapshot,
} from '../../db/registry-policy.js';
import { evaluateMinAge } from './age.js';
import { RegistryPolicyChangedError, RegistryPolicyUnavailableError } from './errors.js';
import { evaluateMembers } from './members.js';
import { earliest } from './rule-scope.js';
import type { RegistryReadSessionDeps } from './session.js';
import type { VersionFact } from './types.js';

/**
 * Organization rules applied to an organization-wide view. Project rules, the client floor and
 * read hooks need a project and a package-manager request, so they never apply here.
 */
export interface OrganizationPolicyView {
  /** One answer per fact, in order: whether every organization rule permits it now. */
  permitted(facts: readonly VersionFact[]): Promise<readonly boolean[]>;
  /** The final recheck before the response; a change asks the caller for one retry. */
  seal(): Promise<void>;
}

export function createOrganizationPolicyView(
  deps: Pick<RegistryReadSessionDeps, 'policy' | 'clock'>,
  ctx: OrgContext,
  ecosystem: PolicyEcosystem,
): OrganizationPolicyView {
  const scope = { ecosystem, projectId: null };
  const now = deps.clock.now().toISOString();
  const snapshots = new Map<string, Promise<PolicySnapshot>>();
  let namespace: Promise<PolicySnapshot | null> | null = null;
  let epoch: string | null = null;
  let boundary: string | null = null;

  async function readPackage(packageKey: string | null): Promise<PolicySnapshot> {
    try {
      return await deps.policy.snapshot(ctx, { ...scope, packageKey });
    } catch {
      throw new RegistryPolicyUnavailableError();
    }
  }

  async function readNamespace(): Promise<PolicySnapshot | null> {
    if (deps.policy.namespace === undefined) return null;
    try {
      return await deps.policy.namespace(ctx, scope);
    } catch {
      throw new RegistryPolicyUnavailableError();
    }
  }

  async function rules(packageKey: string): Promise<PolicySnapshot> {
    namespace ??= readNamespace();
    const all = await namespace;
    let pending = snapshots.get(packageKey);
    if (pending === undefined) {
      pending =
        all === null
          ? readPackage(packageKey)
          : Promise.resolve().then(() => {
              try {
                return policyPackageView(all, packageKey);
              } catch {
                throw new RegistryPolicyUnavailableError();
              }
            });
      snapshots.set(packageKey, pending);
    }
    const snapshot = await pending;
    if (epoch === null) epoch = snapshot.epoch;
    else if (snapshot.epoch !== epoch) throw new RegistryPolicyChangedError();
    return snapshot;
  }

  return {
    async permitted(facts) {
      const answers: boolean[] = [];
      for (const fact of facts) {
        const snapshot = await rules(fact.packageKey);
        let allowed = true;
        for (const outcome of [
          evaluateMinAge(snapshot.rules, fact, now),
          evaluateMembers(snapshot.rules, fact, now),
        ]) {
          boundary = earliest(boundary, outcome.nextBoundary);
          if (outcome.denials.length > 0) allowed = false;
        }
        answers.push(allowed);
      }
      return answers;
    },

    async seal() {
      if (boundary !== null && deps.clock.now().toISOString() >= boundary) {
        throw new RegistryPolicyChangedError();
      }
      if (epoch === null) return;
      if ((await readPackage(null)).epoch !== epoch) throw new RegistryPolicyChangedError();
    },
  };
}
