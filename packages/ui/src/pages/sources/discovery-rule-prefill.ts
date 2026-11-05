import type { ShellServices } from '../../auth.js';
import type { operations } from '../../api-types.js';
type RuleOptions = operations['createDiscoveryRule']['requestBody']['content']['application/json'];
export type RuleDraft = {
  options: RuleOptions;
  id: string | null;
  revision: number | null;
  reauthPending?: boolean;
};
export const drafts = new WeakMap<ShellServices, RuleDraft>();
export function prefillDiscoveryRule(
  services: ShellServices,
  options: Pick<
    RuleOptions,
    'credentialId' | 'installationId' | 'ecosystem' | 'pattern' | 'includeForks'
  >,
) {
  drafts.set(services, {
    id: null,
    revision: null,
    options: { name: '', enabled: true, intervalSeconds: 86400, ...options },
  });
}
