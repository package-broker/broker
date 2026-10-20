import { describeImportVerificationContract } from '../contract/import-verification-contract.js';
import { openMigratedDatabase } from '../testing/migrated-database.js';

describeImportVerificationContract(async () => {
  const database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
  if (database.orgs === null) throw new Error('missing organizations');
  return { executor: database.executor, ctx: database.orgs.a, close: database.close };
});
