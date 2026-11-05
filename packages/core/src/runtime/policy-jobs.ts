import type { RegistryPolicyExpiry } from '../db/registry-policy.js';
import type { JobDefinition } from '../platform/jobs.js';
import {
  createRegistryPolicyExpiryJob,
  REGISTRY_POLICY_EXPIRY_DEFERRED_EVENT,
} from '../registry/policy/expiry.js';
import type { RegistryConfig } from '../registry/registry-config.js';

/** The log events registry policy jobs emit; each runtime adds them to its job registry. */
export const REGISTRY_POLICY_JOB_EVENTS: readonly string[] = Object.freeze([
  REGISTRY_POLICY_EXPIRY_DEFERRED_EVENT,
]);

/** Registry policy jobs a runtime registers; none while registry policy is disabled. */
export function registryPolicyJobs(
  registry: Pick<RegistryConfig, 'policy'>,
  expiry: () => RegistryPolicyExpiry,
): readonly JobDefinition[] {
  return registry.policy.enabled ? [createRegistryPolicyExpiryJob(expiry())] : [];
}
