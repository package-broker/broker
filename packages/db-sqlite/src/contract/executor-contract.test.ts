import { openNodeSqliteExecutor } from '../testing/node-sqlite-executor.js';
import { describeExecutorContract } from './executor-contract.js';

describeExecutorContract('node-sqlite', async () => openNodeSqliteExecutor());
