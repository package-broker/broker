import { defineConfig } from '@package-broker/core/config';
import auditWebhook from '@package-broker/plugin-audit-webhook';
import base from '../broker.config.js';

export default defineConfig({
  ...base,
  plugins: [
    ...base.plugins.filter((plugin) => plugin.id !== 'audit-webhook-webhook'),
    auditWebhook({ id: 'webhook', activation: 'env', durableAck: true, skipAfter: 1 }),
  ],
});
