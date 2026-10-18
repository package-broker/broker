import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMigratedDatabase } from '../testing/migrated-database.js';
import { describeAccessRace, type OpenedRaceDatabase } from './access-race.js';

async function openFile(): Promise<OpenedRaceDatabase> {
  const directory = await mkdtemp(join(tmpdir(), 'pb-access-race-'));
  const database = await openMigratedDatabase({
    file: join(directory, 'race.sqlite'),
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

describeAccessRace('node:sqlite', openFile);
