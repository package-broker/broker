import { expect } from 'vitest';
import type { SqlExecutor } from '@package-broker/core/db/port';
import {
  completeSourceListing,
  completeVersionListing,
} from '@package-broker/core/catalogue/version-rules';
import { createCatalogueReconciler } from '../../repositories/catalogue-reconcile.js';
import { createCatalogueWriteGuard } from '../../repositories/catalogue-write-package.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { FUTURE, NOT_NULL, seedPackage, seedSource, seedVersion } from './fixtures.js';

const OLD = '2020-01-01T00:00:00.000Z';

function reconcileCase(kind: 'source' | 'package' | 'absent'): ContractCase {
  return {
    name: `${kind} reconciliation preserves foreign catalogue rows`,
    async run(context) {
      const { executor } = context;
      const { own, foreign } = orgOf(context);
      const seed = seeder(executor);
      await seed(
        `INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence)
         VALUES ('J', ?, 'sync:v1', 'J', 'running', 'worker', ?, 3)`,
        own.orgId,
        FUTURE,
      );
      for (const [prefix, org] of [
        ['O', own],
        ['F', foreign],
      ] as const) {
        await seedSource(seed, `${prefix}S`, org.orgId, 'composer_repository');
        await seed("UPDATE source SET removal_policy = 'exclude' WHERE id = ?", `${prefix}S`);
        if (kind !== 'source')
          await seedPackage(seed, `${prefix}K`, org.orgId, `${prefix}S`, 'parent');
        for (const key of ['present', 'missing', 'returned']) {
          if (kind === 'source') {
            await seedPackage(seed.forged, `${prefix}-${key}`, org.orgId, 'OS', key);
            await seedVersion(
              seed.forged,
              `V-${prefix}-${key}`,
              org.orgId,
              `O-${key}`,
              `${prefix}-${key}`,
            );
          } else {
            await seedVersion(
              seed.forged,
              `${prefix}-${key}`,
              org.orgId,
              'OK',
              prefix === 'O' ? key : `foreign-${key}`,
            );
          }
        }
      }
      const table = kind === 'source' ? 'package' : 'version';
      await seed(`UPDATE ${table} SET updated_at = ?`, OLD);
      await seed(
        `UPDATE ${table} SET status = 'removed_upstream', removed_upstream_at = ? WHERE id IN ('O-returned', 'F-returned')`,
        OLD,
      );
      const snapshot = async () => {
        const rows = [];
        for (const name of ['package', 'version', 'version_revision', 'cache_epoch']) {
          rows.push(
            await executor.all({
              sql: `SELECT * FROM ${name} WHERE org_id = ? ORDER BY rowid`,
              params: [foreign.orgId],
            }),
          );
        }
        return rows;
      };
      let before = await snapshot();
      const mutating: SqlExecutor = {
        driver: executor.driver,
        all: (statement) => executor.all(context.mutate(statement)),
        batch: (statements) => executor.batch(context.mutateBatch(statements)),
      };
      const reconciler = createCatalogueReconciler(mutating, {
        countUnseen: true,
        maxAbsenceShare: 0.5,
      });
      const guard = createCatalogueWriteGuard(own, { id: 'J', owner: 'worker', fence: 3 });
      if (kind === 'absent') {
        await seed(
          `INSERT INTO upstream_state (org_id, package_id, form, checked_at, fresh_until, not_found_count, first_not_found_at)
           VALUES (?, 'OK', 'composer-p2', ?, ?, 100, ?)`,
          own.orgId,
          OLD,
          OLD,
          OLD,
        );
        await expect(
          reconciler.markPackageAbsent(own, guard, { packageId: 'OK' }),
        ).resolves.toMatchObject({ changed: true, statements: 9 });
      } else {
        const scope =
          kind === 'source'
            ? { kind: 'source' as const, sourceId: 'OS' }
            : { kind: 'package' as const, packageId: 'OK' };
        const { stamp } = await reconciler.openListing(own, guard, scope);
        await seed(
          `UPDATE ${table} SET updated_at = ?, listing_seen_stamp = ? WHERE id = 'F-returned'`,
          stamp,
          stamp,
        );
        before = await snapshot();
        await expect(
          reconciler.markListing(own, guard, {
            scope,
            stamp,
            present: ['present', 'returned'],
          }),
        ).resolves.toMatchObject({ changed: true });
        expect(await snapshot()).toEqual(before);
        const listing =
          kind === 'source'
            ? completeSourceListing({ sourceId: 'OS', stamp, count: 2 })
            : completeVersionListing({ packageId: 'OK', stamp, count: 2 });
        await expect(
          reconciler.finalizeListing(own, guard, listing, {
            attemptedCandidates: 2,
            successfulCandidates: 2,
            definitiveAbsent: 0,
          }),
        ).resolves.toMatchObject({
          removed: 1,
          restored: 1,
          statements: kind === 'source' ? 12 : 16,
        });
      }
      expect(await snapshot()).toEqual(before);
      expect(
        await executor.all({
          sql: `SELECT status FROM ${table} WHERE id = 'O-missing' AND org_id = ?`,
          params: [own.orgId],
        }),
      ).toEqual([{ status: 'removed_upstream' }]);
    },
  };
}

export const entries: readonly MutationEntry[] = [
  {
    builder: 'createCatalogueReconciler',
    file: 'repositories/catalogue-reconcile.ts',
    cases: (['source', 'package', 'absent'] as const).map(reconcileCase),
    predicates: [
      {
        name: 'source mark updates only own rows',
        locate: /(?<=UPDATE package SET updated_at[^]*?WHERE )org_id = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: reconcileCase('source').name,
      },
      {
        name: 'source mark count includes only own rows',
        locate: /package.org_id = \?(?= AND package.source_id = \?\s+AND package.name IN)/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: reconcileCase('source').name,
      },
      {
        name: 'source finalize counts only own marked packages',
        locate:
          /package.org_id = \?(?= AND package.source_id = \?\s+AND package.listing_seen_stamp)/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: reconcileCase('source').name,
      },
      {
        name: 'version finalize counts only own marked versions',
        locate:
          /version.org_id = \?(?= AND version.package_id = \?\s+AND version.listing_seen_stamp)/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: reconcileCase('package').name,
      },
      {
        name: 'source unseen count includes only own packages',
        locate:
          /package\.org_id = \?(?=\s+AND package\.source_id = \?\s+AND package\.updated_at < \()/,
        neutral: NOT_NULL,
        copies: 2,
        caseName: reconcileCase('source').name,
      },
      {
        name: 'version unseen count includes only own versions',
        locate:
          /version\.org_id = \?(?=\s+AND version\.package_id = \?\s+AND version\.status = 'active' AND version\.updated_at < \()/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: reconcileCase('package').name,
      },
      {
        name: 'source sweep updates only own packages',
        locate:
          /(?<=WHERE )package.org_id = \?(?= AND package.source_id = \? AND package.updated_at)/,
        neutral: NOT_NULL,
        copies: 2,
        caseName: reconcileCase('source').name,
      },
      ...(['source', 'package', 'absent'] as const).map((kind) => ({
        name: `${kind} transitions select only own versions`,
        locate: /version.org_id = \?(?=\s+AND version.status = \? AND)/,
        neutral: NOT_NULL,
        copies: kind === 'package' ? 3 : 2,
        caseName: reconcileCase(kind).name,
      })),
      {
        name: 'epoch bump updates only own organization',
        locate: /(?<=UPDATE cache_epoch SET version = hex\(randomblob\(16\)\)\s+WHERE )org_id = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: reconcileCase('source').name,
      },
    ],
    waivers: [
      {
        locate:
          /version.org_id = \?(?=\s+AND version.last_op_id = \? AND version.status = 'active')/,
        reason:
          'Revival revisions select the rows stamped with this operation id, and only the organization scoped revival update stamps it.',
      },
      {
        locate: /blob.org_id = \?/,
        reason: 'The composed removedBlobs builder has its own organization mutation registration.',
      },
      {
        locate: /(?<=UPDATE version SET updated_at[^]*?WHERE )org_id = \?/,
        reason:
          'UNIQUE(package_id, version_normalized) and the scoped exact seen-count assertion make this predicate redundant: a foreign key cannot match an own version, and marking a foreign-only key rolls back.',
      },
      {
        locate: /job.org_id = \?/,
        reason: 'Composed jobLeaseGuard has its own organization mutation registration.',
      },
      {
        locate: /source.org_id = package.org_id/,
        reason: 'Source IDs are globally unique; the package is scoped separately.',
      },
      {
        locate: /version.org_id = package.org_id/,
        reason:
          'Epoch eligibility is already true from the own missing and returned versions; transition predicates are tested separately.',
      },
      {
        locate: /source.org_id = \?/,
        reason:
          'The source ID is globally unique and belongs to the caller in these cases; scope validation is also enforced before the mutations.',
      },
      {
        locate: /package.org_id = \?(?! AND package.source_id = \? AND package.updated_at)/,
        reason:
          'Package scope and clock updates target a globally unique own package ID. Finalize seen-count and epoch eligibility are redundant with the marked own rows and the tested sweep predicates.',
      },
      {
        locate: /version.org_id = \?(?!\s+AND version.status = \? AND)/,
        reason:
          'Version mark counts are redundant with UNIQUE(package_id, version_normalized) for own keys; the finalize count predicate is independently mutation-tested.',
      },
      {
        locate: /(?<=AND )org_id = \?/,
        reason:
          'Open binding, open stamp updates and last_synced_at target a globally unique scope ID already checked by scopeExists.',
      },
      {
        locate: /upstream_state.org_id = \?/,
        reason:
          'The absence case has only qualifying own evidence for this globally unique package; evidence eligibility is shared by the guarded transitions.',
      },
    ],
  },
];
