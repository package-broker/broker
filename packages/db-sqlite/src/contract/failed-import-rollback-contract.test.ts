import { describeFailedImportRollbackContract } from './failed-import-rollback-contract.js';
import { openMigratedDatabase } from '../testing/migrated-database.js';

describeFailedImportRollbackContract('node:sqlite', () =>
  openMigratedDatabase({ d1PatternLimit: true }),
);
