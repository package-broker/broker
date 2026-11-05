import { AUDIT_GENESIS_HASH } from '@package-broker/core/audit/chain';
import type { PluginDefinition } from '@package-broker/core/plugin';

export function auditTrail(): PluginDefinition {
  return {
    id: 'audit-trail',
    package: '@test/audit-trail',
    apiVersion: 4,
    platforms: ['node', 'cloudflare'],
    binds: ['audit-trail'],
    auditTrail: {
      toggleEnv: 'PB_AUDIT_TRAIL',
      create: () => ({
        handle: async (...[operation]) =>
          operation === 'auditHead'
            ? {
                seq: 0,
                hash: AUDIT_GENESIS_HASH,
                pendingCount: 0,
                lastVerifiedAt: null,
                verification: null,
              }
            : { items: [], next: null },
      }),
    },
  };
}
