import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMigratedDatabase } from '../testing/migrated-database.js';
import { describeAccessContract, type OpenedAccessDatabase } from './access-contract.js';

async function openFile(): Promise<OpenedAccessDatabase> {
  const directory = await mkdtemp(join(tmpdir(), 'pb-access-contract-'));
  const database = await openMigratedDatabase({
    file: join(directory, 'contract.sqlite'),
    d1PatternLimit: true,
  });
  return {
    executor: database.executor,
    second: () => database.second(),
    async close() {
      await database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describeAccessContract('node:sqlite', openFile);
