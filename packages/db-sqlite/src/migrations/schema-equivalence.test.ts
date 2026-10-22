import { expect, it } from 'vitest';
import { openNodeSqliteExecutor } from '../testing/node-sqlite-executor.js';
import { discoveredMigrations } from '../testing/migrated-database.js';
import { describeSchemaEquivalenceContract } from '../contract/migration-contract.js';
import { splitStatements } from './split.js';

describeSchemaEquivalenceContract('node:sqlite', async () => openNodeSqliteExecutor());

it('the baseline contains only DDL and its initial lock row within D1 statement and batch limits', async () => {
  const [source] = await discoveredMigrations();
  if (source === undefined) throw new Error('baseline is missing');
  const statements = splitStatements(source.sql);
  expect(
    statements
      .filter((statement) => statement !== 'INSERT INTO migration_lock (id) VALUES (1)')
      .every((statement) => /^CREATE (?:UNIQUE )?(?:TABLE|INDEX)\b/.test(statement)),
  ).toBe(true);
  // One extra statement records the migration; Workers Paid allows 1,000 queries per invocation.
  expect(statements.length + 1).toBeLessThanOrEqual(1_000);
  expect(statements.every((statement) => Buffer.byteLength(statement) <= 100_000)).toBe(true);
});
