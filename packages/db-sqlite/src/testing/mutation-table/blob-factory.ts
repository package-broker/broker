import { expect } from 'vitest';
import { createBlobRepository } from '../../repositories/blob.js';
import { parseSha256 } from '@package-broker/core/platform/blob';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { HASH } from './fixtures.js';
import { executing, factoryEntry } from './factory-cases.js';

const foreignRow: ContractCase = {
  name: 'blob lookup excludes a foreign digest',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seed(
      "INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key) VALUES ('B', ?, ?, 10, 'b')",
      foreign.orgId,
      HASH,
    );
    expect(await createBlobRepository(executing(context)).find(own, parseSha256(HASH))).toBeNull();
  },
};
const dueForeignRow: ContractCase = {
  name: 'due listing excludes a foreign digest',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seed(
      "INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key, purge_after) VALUES ('B', ?, ?, 10, 'b', '2020-01-01T00:00:00.000Z')",
      foreign.orgId,
      HASH,
    );
    const repo = createBlobRepository(executing(context));
    expect(await repo.listDue(own, { limit: 10 })).toEqual([]);
  },
};

export const entries: readonly MutationEntry[] = [
  factoryEntry('blob', 'dueBlobsStatement', dueForeignRow, /"org_id" = \?/),
  factoryEntry('blob', 'createBlobRepository', foreignRow, /"org_id" = \?/),
];
