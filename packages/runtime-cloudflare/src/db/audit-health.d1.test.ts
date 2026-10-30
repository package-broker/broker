import { expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { discoveredMigrations } from '@package-broker/db-sqlite/testing/migrated-database';
import { seedTwoOrganizations } from '@package-broker/db-sqlite/contract/two-organizations';
import { createAuditHealthRepository } from '@package-broker/db-sqlite/repositories/audit-health';
import { createD1Executor } from './d1-executor.js';
import { bridgedD1Database, D1_BRIDGE_SCRIPT } from './d1-bridge.test.support.js';

it('persists health atomically with RETURNING counts, organization isolation and stale ACK protection on D1', async () => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: D1_BRIDGE_SCRIPT,
      compatibilityDate: '2026-10-01',
      d1Databases: ['HEALTH'],
    } as Parameters<typeof convertV4MiniflareOptions>[0]),
  );
  try {
    const executor = createD1Executor(
      bridgedD1Database('HEALTH', (body) =>
        mf.dispatchFetch('http://health.test/', { method: 'POST', body }),
      ),
    );
    await migrate(executor, await discoveredMigrations(), { holder: 'health-test' });
    const { a, b } = await seedTwoOrganizations(executor);
    const port = createAuditHealthRepository(executor);
    const observation = { code: 'audit.capacity' as const, fingerprint: 'warning', failing: false };
    expect((await port.observe(a, [observation])).raised).toEqual(['audit.capacity']);
    expect((await port.observe(a, [observation])).raised).toEqual([]);
    expect((await port.observe(b, [])).alerts).toEqual([]);
    expect((await port.observe(a, [])).alerts[0]).toMatchObject({
      active: false,
      revision: 1,
      acknowledgedRevision: 0,
    });
    expect(await port.acknowledge(a, observation.code, 1)).toBe(true);
    await port.observe(a, [observation]);
    expect(await port.acknowledge(a, observation.code, 1)).toBe(false);
    expect(await port.acknowledge(b, observation.code, 2)).toBe(false);
    expect(await port.acknowledge(a, observation.code, 2)).toBe(true);
    expect((await port.snapshot(b)).oldestPendingAt).toBeNull();
    await port.raise(b, 'audit.hold_failed');
    expect((await port.observe(b, [])).alerts[0]).toMatchObject({
      code: 'audit.hold_failed',
      revision: 1,
    });
    await executor.all({
      sql: `CREATE TRIGGER reject_health BEFORE INSERT ON audit_health
      WHEN NEW.code = 'audit.uncertain' BEGIN SELECT RAISE(ABORT, 'health test failure'); END`,
      params: [],
    });
    await expect(
      port.observe(b, [
        { code: 'audit.withheld', fingerprint: 'one', failing: false },
        { code: 'audit.uncertain', fingerprint: 'two', failing: false },
      ]),
    ).rejects.toThrow();
    expect((await port.observe(b, [])).alerts.map((alert) => alert.code)).toEqual([
      'audit.hold_failed',
    ]);
  } finally {
    await mf.dispose();
  }
});
