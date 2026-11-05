import { openMigratedDatabase } from '../testing/migrated-database.js';
import { describeNotificationWriteContract } from './notification-write-contract.js';

describeNotificationWriteContract('node:sqlite', async () => {
  const database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
  return { executor: database.executor, orgs: database.orgs!, close: () => database.close() };
});
