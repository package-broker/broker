import { expect } from 'vitest';
import { createExistingVersionsReader } from '../../repositories/existing-versions.js';

import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { seedSource, seedPackage, seedVersion } from './fixtures.js';
import { executing, factoryEntry } from './factory-cases.js';

const foreignRow: ContractCase = {
  name: 'existing version reads exclude a foreign child of an own package',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedSource(seed, 'S', own.orgId, 'npm_registry', 'npm');
    await seedPackage(seed, 'K', own.orgId, 'S', 'widget', 'npm');
    await seedVersion(seed.forged, 'V', foreign.orgId, 'K', '1.0.0');
    expect(
      await createExistingVersionsReader(executing(context)).existingVersions(own, {
        packageId: 'K',
        after: null,
        limit: 10,
        withMetadata: false,
      }),
    ).toEqual({ rows: [], next: null });
  },
};
export const entries: readonly MutationEntry[] = [
  factoryEntry('existing-versions', 'createExistingVersionsReader', foreignRow, /"org_id" = \?/),
];
