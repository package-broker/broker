import { openNodeSqliteExecutor } from '../testing/node-sqlite-executor.js';
import { describeDiscoveryRulesMigrationContract } from './discovery-rules-migration-contract.js';

describeDiscoveryRulesMigrationContract('node:sqlite', async () =>
  openNodeSqliteExecutor(undefined, { d1PatternLimit: true }),
);
