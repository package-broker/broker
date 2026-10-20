import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect } from 'vitest';
import { sql } from 'kysely';
import type { SqlExecutor, Statement } from '@package-broker/core/db/port';
import { compile, db } from '../kysely.js';
import { migrate } from '../migrations/runner.js';
import { loadMigrationSource } from '../migrations/source.js';
import { createCatalogueWriteGuard } from '../repositories/catalogue-write-package.js';
import { distTagStatements } from '../repositories/catalogue-write-tags.js';
import {
  admissionCondition,
  col,
  proxyEligibleCondition,
} from '../repositories/catalogue-predicates.js';
import { visibleWinner } from '../repositories/catalogue-read.js';
import { seedTwoOrganizations, type TwoOrganizations } from './two-organizations.js';
import { forgedItFor, withForeignKeysOff } from '../testing/foreign-keys-off.js';

interface Opened {
  readonly executor: SqlExecutor;
  close(): Promise<void>;
}

const st = (text: string, ...params: Statement['params']): Statement => ({ sql: text, params });

export function describeCatalogueContract(
  name: string,
  open: () => Promise<Opened>,
  options: { readonly d1?: boolean } = {},
): void {
  const forgedIt = forgedItFor(options.d1 === true);
  describe(`catalogue org consistency contract: ${name}`, () => {
    let database: Opened;
    let executor: SqlExecutor;
    let orgs: TwoOrganizations;
    const batchForged = (statements: readonly Statement[]) =>
      withForeignKeysOff(executor, () => executor.batch(statements));

    beforeEach(async () => {
      database = await open();
      executor = database.executor;
      const directory = new URL('../../migrations/', import.meta.url);
      const sources = await Promise.all(
        readdirSync(directory)
          .filter((n) => n.endsWith('.sql'))
          .sort()
          .map((n) => loadMigrationSource('core', n, readFileSync(new URL(n, directory), 'utf8'))),
      );
      await migrate(executor, sources, { holder: 'catalogue-contract' });
      orgs = await seedTwoOrganizations(executor);
      await executor.batch([
        st("INSERT INTO project (id, org_id, slug, name) VALUES ('P', ?, 'p', 'P')", orgs.a.orgId),
        st(
          "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('S', ?, 'npm', 'npm', 'npm_registry')",
          orgs.a.orgId,
        ),
        st(
          "INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES (?, 'P', 'S', 100)",
          orgs.a.orgId,
        ),
        st(
          "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('K', ?, 'S', 'npm', 'widget')",
          orgs.a.orgId,
        ),
        st(
          "INSERT INTO project_package (org_id, project_id, package_id, origin) VALUES (?, 'P', 'K', 'subscription')",
          orgs.a.orgId,
        ),
        st(
          `INSERT INTO version (id, org_id, package_id, version, version_normalized, stability, published_at, published_at_basis, metadata_json)
          VALUES ('V', ?, 'K', '1.0.0', '1.0.0', 'stable', '2026-01-01T00:00:00.000Z', 'broker', '{}')`,
          orgs.a.orgId,
        ),
        st(
          `INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence)
          VALUES ('J', ?, 'catalogue:sync:v1', 'j', 'running', 'owner', '2999-01-01T00:00:00.000Z', 1)`,
          orgs.a.orgId,
        ),
      ]);
    });

    afterEach(async () => {
      await database.close();
    });

    forgedIt('a foreign tag collision produces no history, change or revision bump', async () => {
      await batchForged([
        st(
          "INSERT INTO dist_tag (org_id, package_id, tag, version_id) VALUES (?, 'K', 'latest', 'V')",
          orgs.b.orgId,
        ),
      ]);
      const clock = () => executor.all(st("SELECT rev, modified_at FROM package WHERE id = 'K'"));
      const before = await clock();
      const guard = createCatalogueWriteGuard(orgs.a, { id: 'J', owner: 'owner', fence: 1 });
      const plan = distTagStatements(orgs.a, guard, {
        packageId: 'K',
        ecosystem: 'npm',
        tags: { latest: '1.0.0' },
        actorType: 'sync',
        actorId: null,
        opId: 'contract-tags',
      });
      expect(plan.result(await executor.batch(plan.statements))).toMatchObject({
        updated: 0,
        unchanged: 1,
      });
      expect(await executor.all(st('SELECT * FROM dist_tag_history'))).toEqual([]);
      expect(await clock()).toEqual(before);
      expect(await executor.all(st('SELECT org_id, version_id FROM dist_tag'))).toEqual([
        { org_id: orgs.b.orgId, version_id: 'V' },
      ]);
    });

    for (const [effect, pattern] of [
      ['exclude', 'widget'],
      ['include', 'other/*'],
      ['exclude', 'bad?'],
    ] as const) {
      forgedIt(`ignores a mismatched-org ${effect} pattern ${pattern}`, async () => {
        await batchForged([
          st(
            `INSERT INTO project_package_pattern (id, org_id, project_id, source_id, pattern, effect)
          VALUES ('PAT', ?, 'P', 'S', ?, ?)`,
            orgs.b.orgId,
            pattern,
            effect,
          ),
        ]);
        const query = db
          .selectFrom('package as pkg')
          .select('pkg.id')
          .where(
            admissionCondition(
              orgs.a,
              sql.lit('P'),
              col('pkg.source_id'),
              col('pkg.name'),
              col('pkg.visible_to_new_projects'),
            ),
          );
        expect(await executor.all(compile(query))).toEqual([{ id: 'K' }]);
      });
    }

    forgedIt('a foreign include cannot admit a package excluded by own includes', async () => {
      await batchForged([
        st(
          "INSERT INTO project_package_pattern (id, org_id, project_id, source_id, pattern, effect) VALUES ('OWN', ?, 'P', 'S', 'other/*', 'include')",
          orgs.a.orgId,
        ),
        st(
          "INSERT INTO project_package_pattern (id, org_id, project_id, source_id, pattern, effect) VALUES ('FOREIGN', ?, 'P', 'S', 'widget', 'include')",
          orgs.b.orgId,
        ),
      ]);
      const query = db
        .selectFrom('package as pkg')
        .select('pkg.id')
        .where(
          admissionCondition(
            orgs.a,
            sql.lit('P'),
            col('pkg.source_id'),
            col('pkg.name'),
            col('pkg.visible_to_new_projects'),
          ),
        );
      expect(await executor.all(compile(query))).toEqual([]);
    });

    for (const effect of ['include', 'exclude'] as const) {
      forgedIt(`foreign ${effect} patterns do not count towards the limit`, async () => {
        await batchForged(
          Array.from({ length: 65 }, (_, i) =>
            st(
              "INSERT INTO project_package_pattern (id, org_id, project_id, source_id, pattern, effect) VALUES (?, ?, 'P', 'S', ?, ?)",
              `PAT${i}`,
              orgs.b.orgId,
              `other/${i}`,
              effect,
            ),
          ),
        );
        const query = db
          .selectFrom('package as pkg')
          .select('pkg.id')
          .where(
            admissionCondition(
              orgs.a,
              sql.lit('P'),
              col('pkg.source_id'),
              col('pkg.name'),
              col('pkg.visible_to_new_projects'),
            ),
          );
        expect(await executor.all(compile(query))).toEqual([{ id: 'K' }]);
      });
    }

    for (const mismatch of ['package', 'source', 'registered_name'] as const) {
      forgedIt(`a competing foreign ${mismatch} does not shadow a proxy`, async () => {
        await batchForged([
          st("UPDATE source SET type = 'npmjs_proxy' WHERE id = 'S'"),
          st(
            "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('OTHER', ?, 'other', 'npm', 'npm_registry')",
            mismatch === 'package' ? orgs.a.orgId : orgs.b.orgId,
          ),
          mismatch === 'registered_name'
            ? st(
                "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES ('R', ?, 'OTHER', 'npm', 'widget')",
                orgs.b.orgId,
              )
            : st(
                "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('OTHER-K', ?, 'OTHER', 'npm', 'widget')",
                mismatch === 'package' ? orgs.b.orgId : orgs.a.orgId,
              ),
        ]);
        const query = db
          .selectFrom('package as pkg')
          .innerJoin('source as src', 'src.id', 'pkg.source_id')
          .select('pkg.id')
          .where('pkg.id', '=', 'K')
          .where(proxyEligibleCondition({ package: 'pkg', source: 'src' }));
        expect(await executor.all(compile(query))).toEqual([{ id: 'K' }]);
      });
    }

    for (const table of [
      'project_package',
      'project_source',
      'source',
      'package',
      'project',
    ] as const) {
      forgedIt(`a mismatched-org ${table} row cannot supply the visible winner`, async () => {
        expect(
          await executor.all(compile(visibleWinner(orgs.a, 'P', 'npm', 'widget'))),
        ).toHaveLength(1);
        await batchForged([st(`UPDATE ${table} SET org_id = ?`, orgs.b.orgId)]);
        expect(await executor.all(compile(visibleWinner(orgs.a, 'P', 'npm', 'widget')))).toEqual(
          [],
        );
      });
    }
  });
}
