import { expect } from 'vitest';
import { blobLeaseNotLive } from '../../repositories/blob-lease-guard.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
const hash = 'a'.repeat(64);
const FUTURE = '2099-01-01T00:00:00.000Z';

const blobCase: ContractCase = {
  name: 'a foreign blob purge lease does not block the version',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seed(
      "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('S', ?, 's', 'npm', 'npm_registry')",
      own.orgId,
    );
    await seed(
      "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('K', ?, 'S', 'npm', 'widget')",
      own.orgId,
    );
    await seed(
      "INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key, purge_lease_until) VALUES ('B', ?, ?, 1, 'b', ?)",
      foreign.orgId,
      hash,
      FUTURE,
    );
    await seed(
      "INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json, blob_id) VALUES ('V', ?, 'K', '1.0.0', '1.0.0', '2026-01-01T00:00:00.000Z', 'upstream', '{}', 'B')",
      own.orgId,
    );
    const guard = blobLeaseNotLive(own, 'v');
    const rows = await context.executor.all(
      context.mutate({
        sql: `SELECT v.id FROM version v WHERE v.id = 'V' AND ${guard.sql}`,
        params: guard.params,
      }),
    );
    expect(rows).toEqual([{ id: 'V' }]);
  },
};

export const entries: readonly MutationEntry[] = [
  {
    builder: 'blobLeaseNotLive',
    file: 'repositories/blob-lease-guard.ts',
    cases: [blobCase],
    predicates: [
      {
        name: 'purge lease belongs to the organization',
        locate: /bls_blob.org_id = \?/i,
        neutral: '(? is not null)',
        copies: 1,
        caseName: blobCase.name,
      },
    ],
  },
];
