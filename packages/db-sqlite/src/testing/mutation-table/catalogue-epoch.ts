import { expect } from 'vitest';
import type { ScalarSqlExecutor } from '@package-broker/core/db/port';
import { createCatalogueEpochReader } from '../../repositories/catalogue-epoch.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { NOT_NULL, ref, seedPackage, seedSource } from './fixtures.js';

function scopedRead(layer: 'epoch' | 'package'): ContractCase {
  return {
    name: `the live catalogue epoch reader rejects a foreign ${layer}`,
    async run(context) {
      const { own, foreign } = orgOf(context);
      const seed = seeder(context.executor);
      await seedSource(seed, 'S', foreign.orgId, 'vcs');
      await seedPackage(seed, 'K', foreign.orgId, 'S', 'acme/widget');
      await seed('UPDATE cache_epoch SET version = ? WHERE org_id = ?', 'A'.repeat(32), own.orgId);
      await seed(
        'UPDATE cache_epoch SET version = ? WHERE org_id = ?',
        'B'.repeat(32),
        foreign.orgId,
      );
      const executor: ScalarSqlExecutor = {
        driver: context.executor.driver,
        all: (statement) => context.executor.all(context.mutate(statement)),
        batch: (statements) => context.executor.batch(statements),
      };
      const reader = createCatalogueEpochReader(executor, 'K');
      expect(await reader.read(layer === 'epoch' ? foreign : own)).toBe(
        layer === 'epoch' ? 'B'.repeat(32) : null,
      );
    },
  };
}

export const entries: readonly MutationEntry[] = [
  {
    builder: 'createCatalogueEpochReader',
    file: 'repositories/catalogue-epoch.ts',
    cases: [scopedRead('epoch'), scopedRead('package')],
    predicates: [
      {
        name: 'the live epoch belongs to the organization',
        locate: ref('cache_epoch', 'org_id', '\\?'),
        neutral: NOT_NULL,
        caseName: scopedRead('epoch').name,
      },
      {
        name: 'the resolved package belongs to the organization',
        locate: ref('package', 'org_id', '\\?'),
        neutral: NOT_NULL,
        caseName: scopedRead('package').name,
      },
    ],
  },
];
