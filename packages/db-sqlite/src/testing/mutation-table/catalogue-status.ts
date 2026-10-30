import { expect } from 'vitest';
import type { SqlExecutor, Statement } from '@package-broker/core/db/port';
import { createCatalogueStatusRepository } from '../../repositories/catalogue-status.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import {
  ANCHORS,
  FUTURE,
  HASH,
  NOT_NULL,
  fenceOf,
  seedBindings,
  seedPackage,
  seedSource,
  seedSubject,
  seedVersion,
} from './fixtures.js';

function releaseCase(foreignRow: 'version' | 'blob'): ContractCase {
  return {
    name: `quarantine release excludes a foreign ${foreignRow}`,
    async run(context) {
      const { own, foreign } = orgOf(context);
      const seed = seeder(context.executor);
      await seedBindings(context);
      const subject = await seedSubject(context, 'release');
      await seed(
        "UPDATE role_permission SET permission = 'org:sources:write' WHERE role_id = 'R-release'",
      );
      await seedSource(seed, 'S', own.orgId, 'npm_registry', 'npm');
      await seedPackage(seed, 'K', own.orgId, 'S', 'widget', 'npm');
      await seedVersion(
        seed.forged,
        'V',
        foreignRow === 'version' ? foreign.orgId : own.orgId,
        'K',
        '1.0.0',
      );
      await seed(
        "INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key, purge_lease_until) VALUES ('B', ?, ?, 1, 'b', ?)",
        foreign.orgId,
        HASH,
        FUTURE,
      );
      await seed("UPDATE version SET status = 'quarantined', blob_id = 'B' WHERE id = 'V'");
      const conflictRows: unknown[] = [];
      const executor: SqlExecutor = {
        driver: context.executor.driver,
        async all<R = Record<string, unknown>>(statement: Statement) {
          const rows = await context.executor.all<R>(context.mutate(statement));
          if (statement.sql.includes('target_version.id =')) conflictRows.push(...rows);
          return rows;
        },
        batch: (statements) => context.executor.batch(context.mutateBatch(statements)),
      };
      const repository = createCatalogueStatusRepository(executor, { providerAnchors: ANCHORS });
      const result = await repository.releaseQuarantine(own, fenceOf(subject), { versionId: 'V' });
      if (foreignRow === 'version') {
        expect(result).toEqual({ ok: false, reason: 'not_found' });
        // The conflict probe and refusal mapper both reject a foreign version independently.
        expect(conflictRows).toEqual([{ failed: 1 }]);
      } else {
        expect(result).toEqual({ ok: true, opId: expect.any(String) });
      }
      expect(
        await context.executor.all({
          sql: "SELECT status, revision FROM version WHERE id = 'V'",
          params: [],
        }),
      ).toEqual([
        foreignRow === 'version'
          ? { status: 'quarantined', revision: 1 }
          : { status: 'active', revision: 2 },
      ]);
      expect(
        await context.executor.all({
          sql: 'SELECT count(*) AS n FROM version_revision',
          params: [],
        }),
      ).toEqual([{ n: foreignRow === 'version' ? 0 : 1 }]);
    },
  };
}

export const entries: readonly MutationEntry[] = [
  {
    builder: 'createCatalogueStatusRepository',
    file: 'repositories/catalogue-status.ts',
    cases: [releaseCase('version'), releaseCase('blob')],
    predicates: [
      {
        name: 'release guard and conflict probe scope the target version',
        locate: /target_version.org_id = \?/,
        neutral: NOT_NULL,
        copies: 2,
        caseName: releaseCase('version').name,
      },
      {
        name: 'refusal lookup scopes the target version',
        locate: /"target_version"\."org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: releaseCase('version').name,
      },
      {
        name: 'release ignores a foreign blob purge lease',
        locate: /bls_blob.org_id = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: releaseCase('blob').name,
      },
    ],
    waivers: [
      {
        locate: /(?:pa\.)?org_id = \?(?= and (?:pa\.)?version_id = )/,
        reason:
          'The publish gate repeats the independently scoped version identity. Its composite organization/version FK prevents an approval in another organization from referring to the target; publish-gate behavioral contracts verify the refusal.',
      },
      {
        locate: /"(?:guard_\w+|s|actor|i|hp_session)"\."org_id" = /,
        reason:
          'delegated actorHolds and permissionRows authority predicates have their own registrations in actor-authority.ts and access.ts',
      },
      {
        locate: /"(?:version|package)"\."org_id" = \?/,
        reason:
          'delegated versionStatusStatements predicates are registered in catalogue-status-statements.ts',
      },
    ],
  },
];
