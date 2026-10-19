import { openNodeSqliteExecutor } from '../testing/node-sqlite-executor.js';
import { describeCatalogueContract } from './catalogue-contract.js';

describeCatalogueContract('node:sqlite', async () =>
  openNodeSqliteExecutor(':memory:', { d1PatternLimit: true }),
);
