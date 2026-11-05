import {
  describePolicyMigrationContract,
  describePolicyMigrationSource,
} from './policy-migration.js';
import { openNodeSqliteExecutor } from '../testing/node-sqlite-executor.js';

describePolicyMigrationSource();
describePolicyMigrationContract('node:sqlite', async () =>
  openNodeSqliteExecutor(':memory:', { d1PatternLimit: true }),
);
