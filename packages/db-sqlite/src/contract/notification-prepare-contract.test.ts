import { openMigratedDatabase } from '../testing/migrated-database.js';
import { describeNotificationPrepareContract } from './notification-prepare-contract.js';

describeNotificationPrepareContract('node:sqlite', async () => {
  const database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
  return { executor: database.executor, orgs: database.orgs!, close: () => database.close() };
});
