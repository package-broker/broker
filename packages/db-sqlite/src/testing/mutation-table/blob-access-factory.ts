import { expect } from 'vitest';
import { createBlobAccessRepository } from '../../repositories/blob-access.js';

import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { HASH } from './fixtures.js';
import { executing, factoryEntry } from './factory-cases.js';

const foreignRow: ContractCase = {
  name: 'blob access leaves a foreign blob untouched',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seed(
      "INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key) VALUES ('B', ?, ?, 10, 'b')",
      foreign.orgId,
      HASH,
    );
    expect(await createBlobAccessRepository(executing(context)).touch(own, ['B'])).toBe(0);
  },
};
export const entries: readonly MutationEntry[] = [
  factoryEntry('blob-access', 'createBlobAccessRepository', foreignRow, /"org_id" = \?/),
];
