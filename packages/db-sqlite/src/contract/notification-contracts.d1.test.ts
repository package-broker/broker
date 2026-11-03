import { createRequire } from 'node:module';
import { afterAll } from 'vitest';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { describeNotificationCaptureContract } from './notification-capture-contract.js';
import { describeNotificationNpmContract } from './notification-npm-contract.js';
import { describeNotificationDeliveryContract } from './notification-delivery-contract.js';
import { describeNotificationPrepareContract } from './notification-prepare-contract.js';
import { describeNotificationFilterContract } from './notification-filter-contract.js';
import { describeNotificationMigrationContract } from './notification-migration-contract.js';
import { describeNotificationReadContract } from './notification-read-contract.js';
import { describeNotificationRetentionContract } from './notification-retention-contract.js';
import { describeNotificationWriteContract } from './notification-write-contract.js';
import { seedTwoOrganizations } from './two-organizations.js';
import { migrate } from '../migrations/runner.js';
import { discoveredMigrations } from '../testing/migrated-database.js';

const bindings = Array.from({ length: 300 }, (_, index) => `NOTIFY${index}`);
let next = 0;
let miniflare: Promise<{ getD1Database(name: string): Promise<unknown>; dispose(): Promise<void> }>;

function start() {
  miniflare ??= (async () => {
    const require = createRequire(
      new URL('../../../runtime-cloudflare/package.json', import.meta.url),
    );
    const { Miniflare, convertV4MiniflareOptions } = await import(require.resolve('miniflare'));
    return new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: 'export default { fetch() { return new Response("ok") } }',
        compatibilityDate: '2026-10-01',
        d1Databases: bindings,
      }),
    );
  })();
  return miniflare;
}

afterAll(async () => {
  if (next > 0) await (await start()).dispose();
});

async function open() {
  const binding = bindings[next];
  next += 1;
  if (binding === undefined) throw new Error('out of D1 bindings');
  const module = '@package-broker/runtime-cloudflare/db/d1-executor';
  const { createD1Executor } = await import(module);
  const executor: SqlExecutor = createD1Executor(await (await start()).getD1Database(binding));
  return { executor, close: async () => {} };
}

describeNotificationMigrationContract('D1', open);
describeNotificationFilterContract('D1', open);

async function openOrganizations() {
  const opened = await open();
  await migrate(opened.executor, await discoveredMigrations(), { holder: 'notification-d1' });
  return { ...opened, orgs: await seedTwoOrganizations(opened.executor) };
}

describeNotificationReadContract('D1', openOrganizations);
describeNotificationWriteContract('D1', openOrganizations);
describeNotificationCaptureContract('D1', openOrganizations);
describeNotificationNpmContract('D1', openOrganizations);
describeNotificationDeliveryContract('D1', openOrganizations);
describeNotificationPrepareContract('D1', openOrganizations);
describeNotificationRetentionContract('D1', openOrganizations);
