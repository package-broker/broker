import { expect, it } from 'vitest';
import { openNodeSqliteExecutor } from '../testing/node-sqlite-executor.js';
import { discoveredMigrations } from '../testing/migrated-database.js';
import { describeSchemaEquivalenceContract } from '../contract/migration-contract.js';
import { scanSql } from '../sql/scan.js';
import { splitStatements } from './split.js';

describeSchemaEquivalenceContract('node:sqlite', async () => openNodeSqliteExecutor());

it('the baseline contains DDL, its initial lock row and the ecosystem preflight within D1 statement and batch limits', async () => {
  const [source] = await discoveredMigrations();
  if (source === undefined) throw new Error('baseline is missing');
  const statements = splitStatements(source.sql);
  const preflight = `UPDATE package SET ecosystem = ecosystem
WHERE ecosystem IS NOT (SELECT s.ecosystem FROM source AS s WHERE s.id = package.source_id)`;
  expect(statements).toContain(preflight);
  expect(
    statements
      .filter(
        (statement) =>
          statement !== 'INSERT INTO migration_lock (id) VALUES (1)' && statement !== preflight,
      )
      .every((statement) => /^CREATE (?:UNIQUE )?(?:TABLE|INDEX|TRIGGER)\b/.test(statement)),
  ).toBe(true);
  // One extra statement records the migration; Workers Paid allows 1,000 queries per invocation.
  expect(statements.length + 1).toBeLessThanOrEqual(1_000);
  expect(statements.every((statement) => Buffer.byteLength(statement) <= 100_000)).toBe(true);
});

it('npm_publish fits D1 migration statement and parameter limits', async () => {
  const source = (await discoveredMigrations())[1]!;
  expect(source.id).toBe('core:0002_npm_publish');
  expect(source.phase).toBe('expand');
  const statements = splitStatements(source.sql);
  expect(statements.filter((sql) => sql.startsWith('CREATE TABLE '))).toHaveLength(3);
  expect(statements.filter((sql) => sql.startsWith('ALTER TABLE '))).toHaveLength(3);
  expect(statements.length + 3).toBeLessThanOrEqual(200);
  expect(statements.every((sql) => Buffer.byteLength(sql) <= 100_000)).toBe(true);
  expect(
    statements.every((sql) =>
      scanSql(sql)
        .filter((s) => s.kind === 'code')
        .every((s) => !/[?:@$]/.test(s.text)),
    ),
  ).toBe(true);
});
it('npm_identity fits D1 migration statement and parameter limits', async () => {
  const source = (await discoveredMigrations())[2]!;
  expect(source.id).toBe('core:0003_npm_identity');
  expect(source.phase).toBe('expand');
  const statements = splitStatements(source.sql);
  expect(statements.filter((sql) => sql.startsWith('CREATE TABLE '))).toHaveLength(3);
  expect(statements.filter((sql) => sql.startsWith('ALTER TABLE '))).toHaveLength(2);
  expect(statements.length + 3).toBeLessThanOrEqual(200);
  expect(statements.every((sql) => Buffer.byteLength(sql) <= 100_000)).toBe(true);
  expect(
    statements.every((sql) =>
      scanSql(sql)
        .filter((s) => s.kind === 'code')
        .every((s) => !/[?:@$]/.test(s.text)),
    ),
  ).toBe(true);
});

it('npm_login_handoff fits D1 migration statement and parameter limits', async () => {
  const source = (await discoveredMigrations()).find(
    (source) => source.id === 'core:0006_npm_login_handoff',
  )!;
  expect(source.phase).toBe('contract');
  const statements = splitStatements(source.sql);
  expect(statements.length + 3).toBeLessThanOrEqual(200);
  expect(statements.every((sql) => Buffer.byteLength(sql) <= 100_000)).toBe(true);
  expect(
    statements.every((sql) =>
      scanSql(sql)
        .filter((part) => part.kind === 'code')
        .every((part) => !/[?:@$]/.test(part.text)),
    ),
  ).toBe(true);
});
