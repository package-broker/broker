import { expect } from 'vitest';
import { removedBlobs } from '../../repositories/catalogue-reconcile.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { HASH, NOT_NULL, seedSource, seedPackage, seedVersion } from './fixtures.js';

function foreignCase(table: 'blob' | 'version' | 'package', operation: boolean): ContractCase {
  return {
    name: `${operation ? 'operation' : 'scope'} blob narrowing excludes foreign ${table}`,
    async run(context) {
      const { own, foreign } = orgOf(context);
      const seed = seeder(context.executor);
      await seedSource(seed, 'S', own.orgId, 'composer_repository');
      await seedPackage(
        seed.forged,
        'P',
        table === 'package' ? foreign.orgId : own.orgId,
        'S',
        'pkg',
      );
      await seedVersion(
        seed.forged,
        'V',
        table === 'version' ? foreign.orgId : own.orgId,
        'P',
        '1.0.0',
      );
      await seed(
        `INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key, refetchable)
         VALUES ('B', ?, ?, 1, 'blob', 1)`,
        table === 'blob' ? foreign.orgId : own.orgId,
        HASH,
      );
      await seed(
        `UPDATE version SET status = 'removed_upstream', removed_upstream_at = '2020-01-01T00:00:00.000Z', blob_id = 'B', last_op_id = 'op'`,
      );
      await context.executor.batch([
        context.mutate(
          removedBlobs(own, operation ? { opId: 'op' } : { kind: 'source', sourceId: 'S' }),
        ),
      ]);
      expect(
        await context.executor.all({
          sql: "SELECT refetchable FROM blob WHERE id = 'B'",
          params: [],
        }),
      ).toEqual([{ refetchable: 1 }]);
    },
  };
}

const variants = [
  { table: 'blob', operation: false },
  { table: 'version', operation: false },
  { table: 'package', operation: false },
  { table: 'blob', operation: true },
  { table: 'version', operation: true },
] as const;

export const entries: readonly MutationEntry[] = [
  {
    builder: 'removedBlobs',
    file: 'repositories/catalogue-reconcile.ts',
    cases: variants.map(({ table, operation }) => foreignCase(table, operation)),
    predicates: variants.map(({ table, operation }) => ({
      name: `${operation ? 'operation' : 'scope'} ${table} organization`,
      locate: new RegExp(`${table}\\.org_id = \\?`),
      neutral: NOT_NULL,
      copies: 1,
      caseName: foreignCase(table, operation).name,
    })),
  },
];
