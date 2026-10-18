import { describe, expect, it } from 'vitest';
import { openMigratedDatabase } from '../testing/migrated-database.js';
import type { SqlExecutor } from '@package-broker/core/db/port';
import {
  catalogueWriteContractCases,
  describeCatalogueWriteContract,
} from './catalogue-write-contract.js';

describe('catalogue write contract on node:sqlite', () => {
  describeCatalogueWriteContract('node:sqlite', () =>
    openMigratedDatabase({ d1PatternLimit: true }),
  );
});

it('detects removal of the flag-0 organization authority check from T324', async () => {
  let removed = 0;
  const weaken = (executor: SqlExecutor): SqlExecutor => ({
    ...executor,
    batch(statements) {
      return executor.batch(
        statements.map((statement) => {
          if (
            statement.sql.startsWith('with "guard_cond"') &&
            statement.sql.includes('vs_hidden.visible_to_new_projects = 0') &&
            statement.sql.includes('vs_owner.project_id is null')
          ) {
            removed += 1;
            return { sql: 'SELECT 1', params: [] };
          }
          return statement;
        }),
      );
    },
  });
  await expect(
    catalogueWriteContractCases.hiddenExplicitAuthority(
      () => openMigratedDatabase({ d1PatternLimit: true }),
      weaken,
    ),
  ).rejects.toThrow(/expected.*to deeply equal/s);
  expect(removed).toBeGreaterThan(0);
});

for (const mutation of [
  'Composer publication rewrite',
  'Composer publication self-assignment',
  'premature broker phase',
  'historical date with broker basis',
] as const) {
  it(`detects ${mutation}`, async () => {
    let changed = 0;
    const weaken = (executor: SqlExecutor): SqlExecutor => ({
      ...executor,
      batch(statements) {
        return executor.batch(
          statements.map((statement) => {
            let sql = statement.sql;
            if (mutation.startsWith('Composer')) {
              if (/^update "version" set/i.test(sql) && sql.includes('"revision" =')) {
                const value =
                  mutation === 'Composer publication rewrite'
                    ? "'2022-01-01T00:00:00.000Z'"
                    : '"published_at"';
                sql = sql.replace(
                  /^update "version" set /i,
                  `update "version" set "published_at" = ${value}, `,
                );
              }
            } else if (/^insert into "version" /i.test(sql)) {
              if (mutation === 'premature broker phase') {
                sql = sql.replaceAll(
                  'package.last_synced_at IS NULL',
                  'NOT EXISTS (SELECT 1 FROM version AS prior WHERE prior.org_id = package.org_id AND prior.package_id = package.id)',
                );
              } else {
                sql = sql.replace(
                  /ELSE strftime\('%Y-%m-%dT%H:%M:%fZ', 'now'\) END/i,
                  "ELSE '2020-01-01T00:00:00.000Z' END",
                );
              }
            }
            if (sql !== statement.sql) changed += 1;
            return { ...statement, sql };
          }),
        );
      },
    });
    const open = () => openMigratedDatabase({ d1PatternLimit: true });
    const run = mutation.startsWith('Composer')
      ? catalogueWriteContractCases.publicationImmutable(open, 'composer', weaken)
      : catalogueWriteContractCases.publicationPhases(open, weaken);
    await expect(run).rejects.toThrow(
      mutation === 'Composer publication self-assignment'
        ? /expected true to be false/
        : mutation === 'historical date with broker basis'
          ? /expected.*not to be/s
          : /expected.*to deeply equal/s,
    );
    expect(changed).toBeGreaterThan(0);
  });
}
