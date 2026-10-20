import { delegatedMutationFence, type DelegatedMutationFence } from '../authz/fence.js';
import type { JobGuard } from './job-repository.js';

export interface JobFences {
  delegated(
    approverUserId: string,
    runId: string,
    expected: Readonly<Record<string, number>>,
  ): DelegatedMutationFence;
}

export function jobFences(guard: JobGuard): JobFences {
  const lease = Object.freeze({ id: guard.id, owner: guard.owner, fence: guard.fence });
  return Object.freeze({
    delegated: (
      approverUserId: string,
      runId: string,
      expected: Readonly<Record<string, number>>,
    ) => delegatedMutationFence(approverUserId, runId, lease, expected),
  });
}
