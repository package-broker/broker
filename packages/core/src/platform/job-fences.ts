import {
  delegatedMutationFence,
  systemMutationFence,
  type DelegatedMutationFence,
  type SystemMutationFence,
} from '../authz/fence.js';
import type { JobGuard } from './job-repository.js';

export interface JobFences {
  verifier(): SystemMutationFence;
  delegated(
    approverUserId: string,
    runId: string,
    expected: Readonly<Record<string, number>>,
  ): DelegatedMutationFence;
}

const leases = new WeakMap<JobFences, JobGuard>();

export function jobFences(guard: JobGuard): JobFences {
  const lease = Object.freeze({ id: guard.id, owner: guard.owner, fence: guard.fence });
  const fences: JobFences = Object.freeze({
    verifier: () => systemMutationFence('verifier', lease, {}),
    delegated: (
      approverUserId: string,
      runId: string,
      expected: Readonly<Record<string, number>>,
    ) => delegatedMutationFence(approverUserId, runId, lease, expected),
  });
  leases.set(fences, lease);
  return fences;
}

export function jobLeaseOf(context: { readonly fences?: JobFences }): JobGuard | null {
  const fences = context.fences;
  return fences === undefined ? null : (leases.get(fences) ?? null);
}
