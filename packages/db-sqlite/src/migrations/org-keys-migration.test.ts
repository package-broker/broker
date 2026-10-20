import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { loadMigrationSource } from './source.js';
import { MigrationSyntaxError, splitStatements } from './split.js';

test.each(['0020_org_consistent_keys.sql', '0021_org_consistent_keys_tier2.sql'])(
  '%s is a contract migration that defers foreign key checks before any rebuild',
  async (name) => {
    const source = await loadMigrationSource(
      'core',
      name,
      await readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8'),
    );

    const statements = splitStatements(source.sql);

    expect(source.phase).toBe('contract');
    const firstRebuild = statements.findIndex((statement) => /^CREATE TABLE/i.test(statement));
    const defer = statements.findIndex((statement) =>
      /^PRAGMA defer_foreign_keys/i.test(statement),
    );
    expect(defer).toBeGreaterThanOrEqual(0);
    expect(defer).toBeLessThan(firstRebuild);
    const firstPreflight = statements.findIndex((statement) =>
      /^SELECT json_extract/i.test(statement),
    );
    expect(firstPreflight).toBeGreaterThanOrEqual(0);
    expect(firstPreflight).toBeLessThan(defer);
  },
);

test('a migration may defer foreign key checks', () => {
  expect(splitStatements('PRAGMA defer_foreign_keys = ON')).toEqual([
    'PRAGMA defer_foreign_keys = ON',
  ]);
});

test.each([
  'PRAGMA foreign_keys = OFF',
  'PRAGMA foreign_keys = ON',
  'PRAGMA defer_foreign_keys = OFF',
  'PRAGMA writable_schema = ON',
])('still rejects %s', (statement) => {
  expect(() => splitStatements(statement)).toThrow(MigrationSyntaxError);
});
