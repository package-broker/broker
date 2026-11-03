import { openNodeSqliteExecutor } from '../testing/node-sqlite-executor.js';
import { describeNotificationFilterContract } from './notification-filter-contract.js';

describeNotificationFilterContract('node:sqlite', async () =>
  openNodeSqliteExecutor(undefined, { d1PatternLimit: true }),
);
