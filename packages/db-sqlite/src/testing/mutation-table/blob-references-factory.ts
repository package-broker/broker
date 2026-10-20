import { expect } from 'vitest';
import { createBlobReferenceReader } from '../../repositories/blob-references.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { HASH } from './fixtures.js';
import { executing, factoryEntry } from './factory-cases.js';
const foreignBlob: ContractCase = {
  name: 'the reference reader does not collect an unreferenced foreign blob',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await seeder(context.executor)(
      "INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key, created_at) VALUES ('B', ?, ?, 1, 'b', '2000-01-01T00:00:00.000Z')",
      foreign.orgId,
      HASH,
    );
    expect(await createBlobReferenceReader(executing(context)).stillEligible(own, HASH)).toBe(
      false,
    );
  },
};
export const entries: readonly MutationEntry[] = [
  factoryEntry('blob-references', 'createBlobReferenceReader', foreignBlob, /b\.org_id = \?/, [
    {
      locate: /bref_\w+\.org_id = /,
      reason:
        'blobEligibleCondition is delegated unchanged; its version, package, source, revision, ingest and upstream child scopes are independently mutation-tested in blob-references.ts.',
    },
  ]),
];
