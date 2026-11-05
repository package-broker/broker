import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import {
  discoveredMigrations,
  auditForkRepositorySuite,
} from '@package-broker/db-sqlite/testing/migrated-database';
import { seedTwoOrganizations } from '@package-broker/db-sqlite/contract/two-organizations';
import { createD1Executor } from './d1-executor.js';
import { bridgedD1Database, D1_BRIDGE_SCRIPT } from './d1-bridge.test.support.js';

await auditForkRepositorySuite(async () => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: D1_BRIDGE_SCRIPT,
      compatibilityDate: '2026-10-01',
      d1Databases: ['AUDITFORK'],
    } as Parameters<typeof convertV4MiniflareOptions>[0]),
  );
  try {
    const executor = createD1Executor(
      bridgedD1Database('AUDITFORK', (body) =>
        mf.dispatchFetch('http://audit-fork.test/', { method: 'POST', body }),
      ),
    );
    await migrate(executor, await discoveredMigrations(), { holder: 'audit-fork-test' });
    return {
      executor,
      orgs: await seedTwoOrganizations(executor),
      second: async () => executor,
      analyze: async () => {},
      close: () => mf.dispose(),
    };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
});
