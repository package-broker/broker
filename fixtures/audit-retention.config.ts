import { defineConfig } from '@package-broker/core/config';
import auditWebhook from '@package-broker/plugin-audit-webhook';
import { auditTrail } from '@package-broker/plugin-audit-trail';
import base from '../broker.config.js';

export default defineConfig({
  ...base,
  plugins: [
    auditTrail({ toggleEnv: 'PB_AUDIT_TRAIL' }),
    auditWebhook({ id: 'webhook', activation: 'env', durableAck: true }),
  ],
  audit: {
    capacity: { maxJournalBytes: 64 * 1024 * 1024 },
    acceptNoDurableAudit: true,
    ...(process.env['AUD40B_RUNTIME'] === 'node' ? { egress: { allowPrivate: ['webhook'] } } : {}),
  },
});
