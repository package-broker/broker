import { expect, it } from 'vitest';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { catalogueWriteContractCases } from './catalogue-write-contract.js';
import {
  randomCatalogueConfig,
  seedCatalogue,
  seedDerivedRows,
} from '../testing/catalogue-fixture.js';
import { seeder } from '../testing/mutation-table/harness.js';
import { openMigratedDatabase } from '../testing/migrated-database.js';

it('every project_package writer copies the linked package ecosystem and name in its write', async () => {
  const checked = new Set<string>();
  const wrap = (executor: SqlExecutor): SqlExecutor => ({
    ...executor,
    async batch(statements) {
      const result = await executor.batch(statements);
      const inserts = statements.filter(
        (s, index) =>
          /insert(?: or ignore)? into "project_package"/i.test(s.sql) &&
          (result[index]?.changes ?? 0) > 0,
      );
      if (inserts.length > 0) {
        const rows = await executor.all<{
          ecosystem: string;
          name: string;
          package_ecosystem: string;
          package_name: string;
        }>({
          sql: `SELECT pp.ecosystem, pp.name, p.ecosystem AS package_ecosystem, p.name AS package_name
            FROM project_package AS pp JOIN package AS p ON p.id = pp.package_id AND p.org_id = pp.org_id`,
          params: [],
        });
        for (const row of rows) {
          expect(row.ecosystem).toBe(row.package_ecosystem);
          expect(row.name).toBe(row.package_name);
        }
        if (rows.length > 0)
          for (const insert of inserts) {
            checked.add(insert.sql.includes('derive_package') ? 'derived' : 'explicit');
          }
      }
      return result;
    },
  });
  await catalogueWriteContractCases.hiddenExplicitAuthority(
    () => openMigratedDatabase({ d1PatternLimit: true }),
    wrap,
  );
  expect([...checked].sort()).toEqual(['derived', 'explicit']);
});

it.each(['explicit', 'derived'])(
  'shared %s fixtures reject a zero-row membership insert',
  async (kind) => {
    const database = await openMigratedDatabase();
    try {
      const base = randomCatalogueConfig(3, 6);
      const pkg = base.packages[0]!;
      const config = {
        ...base,
        explicit: [
          {
            orgId: pkg.orgId,
            projectId: base.projects.find((p) => p.orgId === pkg.orgId)!.id,
            packageId: pkg.id,
          },
        ],
      };
      const executor: SqlExecutor = {
        ...database.executor,
        async batch(statements) {
          const results = await database.executor.batch(statements);
          return results.map((result, index) =>
            /INSERT INTO project_package \(/i.test(statements[index]!.sql)
              ? { ...result, changes: 0 }
              : result,
          );
        },
      };
      if (kind === 'explicit') {
        await expect(seedCatalogue(executor, config)).rejects.toThrow(
          'project_package fixture must change exactly one row',
        );
      } else {
        await seedCatalogue(database.executor, { ...config, explicit: [] });
        await expect(seedDerivedRows(executor, { ...config, explicit: [] })).rejects.toThrow(
          'project_package fixture must change exactly one row',
        );
      }
    } finally {
      await database.close();
    }
  },
);

it.each([false, true])(
  'mutation fixture rejects a missing linked package (forged: %s)',
  async (forged) => {
    const database = await openMigratedDatabase();
    try {
      const seed = seeder(database.executor);
      const insert = forged ? seed.forged : seed;
      await expect(
        insert(`INSERT INTO project_package (org_id, project_id, package_id, origin, ecosystem, name)
      SELECT 'missing', 'missing', p.id, 'explicit', p.ecosystem, p.name FROM package p WHERE p.id = 'missing'`),
      ).rejects.toThrow('project_package fixture must change exactly one row');
    } finally {
      await database.close();
    }
  },
);

it.each(['missing', 'foreign'])(
  'membership fixture still rejects a %s package with foreign keys enabled',
  async (kind) => {
    const database = await openMigratedDatabase();
    try {
      const config = randomCatalogueConfig(3, 6);
      await seedCatalogue(database.executor, { ...config, explicit: [] });
      const own = config.projects[0]!;
      const foreign = config.packages.find((p) => p.orgId !== own.orgId)!;
      const seed = seeder(database.executor);
      await expect(
        seed(
          `INSERT INTO project_package (org_id, project_id, package_id, origin, ecosystem, name)
      SELECT ?, ?, ?, 'explicit', p.ecosystem, p.name FROM package p WHERE p.id = ?`,
          own.orgId,
          own.id,
          kind === 'missing' ? 'missing' : foreign.id,
          kind === 'missing' ? 'missing' : foreign.id,
        ),
      ).rejects.toThrow(
        kind === 'missing'
          ? 'project_package fixture must change exactly one row'
          : /FOREIGN KEY constraint failed/,
      );
      expect(
        await database.executor.all({ sql: 'SELECT * FROM project_package', params: [] }),
      ).toEqual([]);
    } finally {
      await database.close();
    }
  },
);
