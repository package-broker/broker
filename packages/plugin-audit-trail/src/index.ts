import { definePlugin } from '@package-broker/core/plugin';
import { createTrail } from './routes.js';

export function auditTrail() {
  return definePlugin({
    id: 'audit-trail',
    package: '@package-broker/plugin-audit-trail',
    apiVersion: 4,
    platforms: ['node', 'cloudflare'],
    binds: ['audit-trail'],
    auditTrail: { toggleEnv: 'PB_AUDIT_TRAIL', create: createTrail },
  });
}
