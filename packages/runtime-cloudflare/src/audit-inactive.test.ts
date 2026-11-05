import { expect, it, vi } from 'vitest';
import { collectRegistrations } from '@package-broker/core/kernel/registry';
import type { PluginDefinition } from '@package-broker/core/plugin';
import { noopObservability } from '@package-broker/core/platform/observability';
import { openMigratedDatabase } from '@package-broker/db-sqlite/testing/migrated-database';
import { createWorkerAudit } from './audit.js';
import { auditTrail } from './audit-trail.test.support.js';

vi.mock('@package-broker/core/kernel/registry-audit', async (original) => ({
  ...(await original<typeof import('@package-broker/core/kernel/registry-audit')>()),
  AUDIT_SINKS_AVAILABLE: true,
}));

it.each(['never-active', 'became-inactive', 'build-inactive'] as const)(
  'observes inactive sink alerts: %s',
  async (scenario) => {
    const database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
    const org = database.orgs!.a;
    const foreign = database.orgs!.b;
    const log = vi.fn();
    const counter = vi.fn();
    const sink: PluginDefinition = {
      id: 'archive',
      package: '@test/archive',
      apiVersion: 4,
      platforms: ['cloudflare'],
      auditSinks: [
        {
          id: 'archive',
          kind: 'custom',
          activation: scenario === 'build-inactive' ? 'build' : 'env',
          custody: 'durable',
          sourceIp: 'omit',
          destination: {
            protocol: 'https-json',
            urlEnv: 'ARCHIVE_URL',
            headersEnv: 'ARCHIVE_HEADERS',
          },
          create: () => ({ deliver: async () => ({ outcome: 'retry', code: 'network' }) }),
        },
      ],
    };
    const plugins = [auditTrail(), sink];
    const create = (generation: number, active: boolean) =>
      createWorkerAudit({
        config: { platform: 'cloudflare', plugins },
        env: (name) =>
          active
            ? {
                ARCHIVE_URL: 'https://archive.example.test',
                ARCHIVE_HEADERS: 'Authorization=fixture',
              }[name]
            : undefined,
        executor: database.executor,
        observability: { ...noopObservability, log, counter },
        deploymentId: 'test',
        maxJournalBytes: null,
        generation,
        telemetryActive: false,
        registration: () => collectRegistrations(plugins),
      });
    const alert = { level: 'error', event: 'audit.alert', reason_code: 'audit.sink_inactive' };
    try {
      let audit = await create(1, scenario !== 'never-active');
      await audit.effective(org);
      expect(await audit.health.read(org)).toEqual({ status: 'ok', codes: [] });
      expect(log).not.toHaveBeenCalledWith(alert);
      if (scenario === 'became-inactive') {
        audit = await create(2, false);
        await audit.effective(org);
      } else if (scenario === 'build-inactive') {
        await expect(create(2, false)).rejects.toMatchObject({ code: 'invalid_endpoint' });
        // Health must also flag an inactive build sink without recorded activation history.
        await database.executor.all({
          sql: "UPDATE audit_sink SET state = 'inactive', activation_source = 'none', receiver_fingerprint = '' WHERE org_id = ? AND sink_id = ? RETURNING sink_id",
          params: [org.orgId, 'archive'],
        });
      }
      const inactive = await database.executor.all({
        sql: 'SELECT state, activation_source AS source FROM audit_sink WHERE org_id = ? AND sink_id = ?',
        params: [org.orgId, 'archive'],
      });
      expect(inactive).toEqual([
        {
          state: 'inactive',
          source: scenario === 'became-inactive' ? 'ARCHIVE_URL' : 'none',
        },
      ]);
      const expected = scenario === 'never-active' ? [] : ['audit.sink_inactive'];
      expect((await audit.health.read(org)).codes).toEqual(expected);
      expect(
        log.mock.calls.filter(([record]) => record.reason_code === 'audit.sink_inactive'),
      ).toEqual(expected.map(() => [alert]));
      expect(counter.mock.calls.filter(([name]) => name === 'pb.audit.alerts_total')).toEqual(
        expected.map(() => ['pb.audit.alerts_total', { code: 'audit.sink_inactive' }]),
      );
      await audit.effective(foreign);
      expect(await audit.health.read(foreign)).toEqual({ status: 'ok', codes: [] });
      expect((await audit.health.read(org)).codes).toEqual(expected);
      expect(
        log.mock.calls.filter(([record]) => record.reason_code === 'audit.sink_inactive'),
      ).toHaveLength(expected.length);
    } finally {
      await database.close();
    }
  },
);
