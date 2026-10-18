import { describe } from 'vitest';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { openMigratedDatabase } from '../testing/migrated-database.js';
import {
  describeCatalogueReadContract,
  type OpenedCatalogueDatabase,
} from './catalogue-read-contract.js';

async function open(): Promise<OpenedCatalogueDatabase> {
  const database = await openMigratedDatabase();
  const executor: SqlExecutor = database.executor;
  return { executor, close: () => database.close() };
}

describe('catalogue read contract on node:sqlite', () => {
  describeCatalogueReadContract('node:sqlite', open);
});
