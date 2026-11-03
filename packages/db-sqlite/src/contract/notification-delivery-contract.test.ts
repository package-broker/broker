import { openMigratedDatabase } from '../testing/migrated-database.js';
import { describeNotificationDeliveryContract } from './notification-delivery-contract.js';

describeNotificationDeliveryContract('node:sqlite', async () => {
  const database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
  return { executor: database.executor, orgs: database.orgs!, close: () => database.close() };
});
