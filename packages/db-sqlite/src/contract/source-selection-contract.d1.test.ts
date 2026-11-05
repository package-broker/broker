import { describeNpmClaimsContract } from './npm-claims-contract.js';
import { createRequire } from 'node:module';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { describeSourceSelectionContract } from './source-selection-contract.js';
import { discoveredMigrations } from '../testing/migrated-database.js';
import { migrate } from '../migrations/runner.js';
import { describeSourceSelectionRacesContract } from './source-selection-races-contract.js';

async function open() {
  const require = createRequire(
    new URL('../../../runtime-cloudflare/package.json', import.meta.url),
  );
  const { Miniflare, convertV4MiniflareOptions } = await import(require.resolve('miniflare'));
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      compatibilityDate: '2026-10-01',
      d1Databases: ['SELECTION'],
    }),
  );
  try {
    const module = '@package-broker/runtime-cloudflare/db/d1-executor';
    const { createD1Executor } = await import(module);
    const executor: SqlExecutor = createD1Executor(await mf.getD1Database('SELECTION'));
    await migrate(executor, await discoveredMigrations(), { holder: 'selection-contract' });
    return { executor, close: () => mf.dispose() };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}

describeSourceSelectionContract('D1', open);
describeSourceSelectionRacesContract('D1', open);

describeNpmClaimsContract('D1', open);
