import { expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { discoveredMigrations } from '@package-broker/db-sqlite/testing/migrated-database';
import { seedTwoOrganizations } from '@package-broker/db-sqlite/contract/two-organizations';
import { createAuditStatusReader } from '@package-broker/db-sqlite/repositories/audit-status';
import { createD1Executor } from './d1-executor.js';
import { bridgedD1Database, D1_BRIDGE_SCRIPT } from './d1-bridge.test.support.js';

it('isolates status selections on D1', async () => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: D1_BRIDGE_SCRIPT,
      compatibilityDate: '2026-10-01',
      d1Databases: ['STATUS'],
    } as Parameters<typeof convertV4MiniflareOptions>[0]),
  );
  try {
    const executor = createD1Executor(
      bridgedD1Database('STATUS', (body) =>
        mf.dispatchFetch('http://status.test/', { method: 'POST', body }),
      ),
    );
    await migrate(executor, await discoveredMigrations(), { holder: 'status-test' });
    const orgs = await seedTwoOrganizations(executor);
    await executor.batch([
      { sql: "UPDATE audit_chain SET mode = 'none' WHERE org_id = ?", params: [orgs.a.orgId] },
      { sql: "UPDATE audit_chain SET mode = 'trail' WHERE org_id = ?", params: [orgs.b.orgId] },
      {
        sql: `INSERT INTO audit_pending (org_id, id, created_at, actor_type, action, target_type)
          VALUES (?, 'pending', 'now', 'system', 'org.update', 'organization')`,
        params: [orgs.a.orgId],
      },
    ]);
    const reader = createAuditStatusReader(executor);
    expect(await reader.read(orgs.a)).toMatchObject({ mode: 'none', pendingCount: 1 });
    expect(await reader.read(orgs.b)).toMatchObject({
      mode: 'trail',
      pendingCount: 0,
      sinks: [],
      ledger: [],
    });
  } finally {
    await mf.dispose();
  }
});
