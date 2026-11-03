import { openNodeSqliteExecutor } from '../testing/node-sqlite-executor.js';
import { describeNotificationMigrationContract } from './notification-migration-contract.js';

describeNotificationMigrationContract('node:sqlite', async () =>
  openNodeSqliteExecutor(undefined, { d1PatternLimit: true }),
);
