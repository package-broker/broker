import { expect } from 'vitest';
import { sql } from 'kysely';
import { compile, db } from '../../kysely.js';
import { blobLeaseNotLive, leaseLive } from '../../repositories/blob-lease-guard.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
const hash = 'a'.repeat(64);
const FUTURE = '2099-01-01T00:00:00.000Z';

const leaseBoundaries = [
  ['absent', null, 0],
  ['one tick before', '2026-10-17T11:59:59.999Z', 0],
  ['equal to now', '2026-10-17T12:00:00.000Z', 0],
  ['one tick after', '2026-10-17T12:00:00.001Z', 1],
] as const;

const leaseCases: ContractCase[] = leaseBoundaries.map(([label, lease, live]) => ({
  name: `a purge lease ${label} has liveness ${live}`,
  async run(context) {
    const statement = compile(
      db
        .selectFrom(sql`(select ${lease} as purge_lease_until)`.as('lease'))
        .select(leaseLive('lease.purge_lease_until').as('live')),
    );
    const rows = await context.executor.all(
      context.mutate({
        ...statement,
        sql: statement.sql.replaceAll("'now'", "'2026-10-17T12:00:00.000Z'"),
      }),
    );
    expect(rows).toEqual([{ live }]);
  },
}));

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
    builder: 'leaseLive',
    file: 'repositories/blob-lease-guard.ts',
    cases: leaseCases,
    predicates: [],
    sqlDecisions: [
      ...leaseCases.map((boundaryCase, index) => ({
        name: boundaryCase.name,
        pattern: index === 0 ? /is not null/ : /> strftime/,
        replacement: index === 0 ? 'is null' : index === 2 ? '>= strftime' : '<= strftime',
        expected: 1,
        case: boundaryCase,
      })),
      {
        name: 'a lease equal to database time is expired',
        pattern: /> strftime/,
        replacement: '>= strftime',
        expected: 1,
        case: {
          name: 'lease equality is not live',
          async run(context) {
            const now = '2026-10-17T12:00:00.000Z';
            const statement = compile(
              db
                .selectFrom(sql`(SELECT ${now} AS purge_lease_until)`.as('lease'))
                .select(leaseLive('lease.purge_lease_until').as('live')),
            );
            const rows = await context.executor.all(
              context.mutate({
                ...statement,
                sql: statement.sql.replaceAll("'now'", `'${now}'`),
              }),
            );
            expect(rows).toEqual([{ live: 0 }]);
          },
        },
      },
    ],
  },
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
