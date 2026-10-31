import { expect, it, vi } from 'vitest';
import { noopObservability } from '@package-broker/core/platform/observability';
import { collectRegistrations } from '@package-broker/core/kernel/registry';
import { openMigratedDatabase } from '@package-broker/db-sqlite/testing/migrated-database';
import { createWorkerAudit } from './audit.js';
import { auditTrail } from './audit-trail.test.support.js';

it('emits the fixed boot event for each audit warning', async () => {
  const database = await openMigratedDatabase();
  const plugins = [auditTrail()];
  try {
    for (const policy of ['availability', 'required'] as const) {
      const log = vi.fn();
      const budget = policy === 'required' ? 67108864 : null;
      await createWorkerAudit({
        config: {
          platform: 'cloudflare',
          plugins,
          audit: {
            policy,
            ...(budget === null ? {} : { capacity: { maxJournalBytes: budget } }),
            alerts: { webhookEnv: 'ALERT_URL' },
          },
        },
        env: (name) => (name === 'ALERT_URL' ? 'https://alerts.example.test' : undefined),
        executor: database.executor,
        observability: { ...noopObservability, log },
        maxJournalBytes: budget,
        generation: 0,
        telemetryActive: false,
        registration: () => collectRegistrations(plugins),
      });
      const event =
        policy === 'required' ? 'audit.trail_toggle_ignored' : 'audit.capacity_unbounded';
      if (policy === 'required')
        expect(log).toHaveBeenCalledWith({ level: 'warn', event, reason_code: event });
      else expect(log).not.toHaveBeenCalled();
      expect(log.mock.calls.filter(([record]) => record.level === 'warn')).toHaveLength(
        policy === 'required' ? 1 : 0,
      );
    }
  } finally {
    await database.close();
  }
});
