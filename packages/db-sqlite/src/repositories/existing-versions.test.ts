import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrgContext, SqlExecutor } from '@package-broker/core/db/port';
import { countCalls } from '../contract/count-calls.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import {
  createExistingVersionsReader,
  EXISTING_VERSIONS_METADATA_BYTES,
  EXISTING_VERSIONS_METADATA_ROWS,
  type ExistingVersion,
} from './existing-versions.js';

const PACKAGE_A = '01J0000000000000000000PKGA';
const PACKAGE_B = '01J0000000000000000000PKGB';

let database: MigratedDatabase;
let a: OrgContext;
let b: OrgContext;
let executor: SqlExecutor;

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('organizations were not seeded');
  ({ a, b } = database.orgs);
  executor = database.executor;
  for (const [org, source, pkg] of [
    [a, '01J0000000000000000000SRCA', PACKAGE_A],
    [b, '01J0000000000000000000SRCB', PACKAGE_B],
  ] as const) {
    await executor.batch([
      {
        sql: "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, ?, 'upstream', 'npm', 'npmjs_proxy')",
        params: [source, org.orgId],
      },
      {
        sql: "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES (?, ?, ?, 'npm', 'pkg')",
        params: [pkg, org.orgId, source],
      },
    ]);
  }
});

afterEach(async () => {
  await database.close();
});

async function seed(
  org: OrgContext,
  packageId: string,
  count: number,
  metadataBytes = 2,
): Promise<void> {
  const metadata = metadataBytes <= 2 ? '{}' : `{"p":"${'x'.repeat(metadataBytes - 8)}"}`;
  await executor.batch([
    {
      sql: `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json, npm_integrity, composer_shasum)
SELECT ? || printf('%05d', i), ?, ?, '1.0.' || i, printf('%05d', i), '2026-01-01T00:00:00.000Z', 'upstream', ?, 'sha512-' || i, 'sum' || i FROM n`,
      params: [count, `V${packageId.slice(-1)}`, org.orgId, packageId, metadata],
    },
  ]);
}

async function drain(
  reader: ReturnType<typeof createExistingVersionsReader>,
  ctx: OrgContext,
  packageId: string,
  withMetadata: boolean,
  limit: number,
): Promise<ExistingVersion[][]> {
  const pages: ExistingVersion[][] = [];
  let after: string | null = null;
  do {
    expect(pages.length).toBeLessThan(50);
    const page = await reader.existingVersions(ctx, { packageId, after, withMetadata, limit });
    pages.push([...page.rows]);
    after = page.next;
  } while (after !== null);
  return pages;
}

describe('existingVersions', () => {
  it('reads a 3,000-version package in 3 key-only pages, one query each', async () => {
    await seed(a, PACKAGE_A, 3000);
    const counted = countCalls(executor);
    const reader = createExistingVersionsReader(counted.executor);

    const pages = await drain(reader, a, PACKAGE_A, false, 1000);

    expect(pages.map((page) => page.length)).toEqual([1000, 1000, 1000]);
    expect(counted.counts()).toEqual({ all: 3, batch: 0 });
    const keys = pages.flat().map((row) => row.versionNormalized);
    expect(keys).toEqual([...keys].sort());
    expect(new Set(keys).size).toBe(3000);
    expect(pages[0]?.[0]).toEqual({
      versionNormalized: '00001',
      id: 'VA00001',
      revision: 1,
      status: 'active',
      npmIntegrity: 'sha512-1',
      composerShasum: 'sum1',
    });
    expect('metadataJson' in (pages[0]?.[0] ?? {})).toBe(false);
  });

  it('returns no rows for a package of another organization', async () => {
    await seed(b, PACKAGE_B, 5);
    const reader = createExistingVersionsReader(executor);
    const page = await reader.existingVersions(a, {
      packageId: PACKAGE_B,
      after: null,
      withMetadata: false,
      limit: 1000,
    });
    expect(page).toEqual({ rows: [], next: null });
    expect(
      (
        await reader.existingVersions(b, {
          packageId: PACKAGE_B,
          after: null,
          withMetadata: false,
          limit: 1000,
        })
      ).rows,
    ).toHaveLength(5);
  });

  it('resumes strictly after the cursor and ends with a null cursor', async () => {
    await seed(a, PACKAGE_A, 5);
    const reader = createExistingVersionsReader(executor);
    const page = await reader.existingVersions(a, {
      packageId: PACKAGE_A,
      after: '00002',
      withMetadata: false,
      limit: 10,
    });
    expect(page.rows.map((row) => row.versionNormalized)).toEqual(['00003', '00004', '00005']);
    expect(page.next).toBeNull();
  });

  it('returns a cursor only when more rows remain', async () => {
    await seed(a, PACKAGE_A, 4);
    const reader = createExistingVersionsReader(executor);
    const first = await reader.existingVersions(a, {
      packageId: PACKAGE_A,
      after: null,
      withMetadata: false,
      limit: 2,
    });
    expect(first.next).toBe('00002');
    const last = await reader.existingVersions(a, {
      packageId: PACKAGE_A,
      after: first.next,
      withMetadata: false,
      limit: 2,
    });
    expect(last.rows).toHaveLength(2);
    expect(last.next).toBeNull();
  });

  it('includes metadata and caps a metadata page at 200 rows', async () => {
    await seed(a, PACKAGE_A, 450);
    const reader = createExistingVersionsReader(executor);
    const pages = await drain(reader, a, PACKAGE_A, true, 1000);
    expect(pages.map((page) => page.length)).toEqual([200, 200, 50]);
    expect(EXISTING_VERSIONS_METADATA_ROWS).toBe(200);
    expect(pages[0]?.[0]?.metadataJson).toBe('{}');
  });

  it('cuts a metadata page at 4 MiB and still makes progress on an oversized row', async () => {
    const big = 1024 * 1024 + 100;
    await seed(a, PACKAGE_A, 10, big);
    const reader = createExistingVersionsReader(executor);
    const pages = await drain(reader, a, PACKAGE_A, true, 200);
    expect(EXISTING_VERSIONS_METADATA_BYTES).toBe(4 * 1024 * 1024);
    expect(pages.map((page) => page.length)).toEqual([3, 3, 3, 1]);
    expect(pages.flat()).toHaveLength(10);

    await executor.batch([
      {
        sql: 'UPDATE version SET metadata_json = ? WHERE package_id = ? AND version_normalized = ?',
        params: [`{"p":"${'y'.repeat(5 * 1024 * 1024)}"}`, PACKAGE_A, '00001'],
      },
    ]);
    const first = await reader.existingVersions(a, {
      packageId: PACKAGE_A,
      after: null,
      withMetadata: true,
      limit: 200,
    });
    expect(first.rows).toHaveLength(1);
    expect(first.next).toBe('00001');
  });

  it('returns rows in key order whatever the insertion order or id order', async () => {
    await executor.batch(
      ['00003', '00001', '00002'].map((key, index) => ({
        sql: `INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json)
VALUES (?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z', 'upstream', '{}')`,
        params: [`ID${3 - index}`, a.orgId, PACKAGE_A, key, key],
      })),
    );
    const reader = createExistingVersionsReader(executor);
    for (const withMetadata of [false, true]) {
      const page = await reader.existingVersions(a, {
        packageId: PACKAGE_A,
        after: null,
        withMetadata,
        limit: 10,
      });
      expect(page.rows.map((row) => row.versionNormalized)).toEqual(['00001', '00002', '00003']);
      expect(page.rows.map((row) => row.id)).toEqual(['ID2', 'ID1', 'ID3']);
    }
  });

  it('keeps a page whose bytes equal the budget exactly and cuts one byte over', async () => {
    const half = EXISTING_VERSIONS_METADATA_BYTES / 2;
    await seed(a, PACKAGE_A, 3, half);
    const reader = createExistingVersionsReader(executor);
    const page = await reader.existingVersions(a, {
      packageId: PACKAGE_A,
      after: null,
      withMetadata: true,
      limit: 200,
    });
    expect(page.rows).toHaveLength(2);
    expect(page.next).toBe('00002');

    await executor.batch([
      {
        sql: `UPDATE version SET metadata_json = replace(metadata_json, '{"p":"', '{"p":"z') WHERE version_normalized = '00002' AND package_id = ?`,
        params: [PACKAGE_A],
      },
    ]);
    const over = await reader.existingVersions(a, {
      packageId: PACKAGE_A,
      after: null,
      withMetadata: true,
      limit: 200,
    });
    expect(over.rows).toHaveLength(1);
    expect(over.next).toBe('00001');
  });

  it('rejects an invalid limit, cursor, flag, package id or query', async () => {
    const reader = createExistingVersionsReader(executor);
    const ok = { packageId: PACKAGE_A, after: null, withMetadata: false, limit: 10 };
    const bad: unknown[] = [
      { ...ok, limit: 0 },
      { ...ok, limit: -1 },
      { ...ok, limit: Number.NaN },
      { ...ok, limit: 1001 },
      { ...ok, limit: 1.5 },
      { ...ok, packageId: '' },
      { ...ok, packageId: undefined },
      { ...ok, packageId: 7 },
      { ...ok, after: 1 },
      { ...ok, after: '' },
      { ...ok, withMetadata: 'yes' },
      { ...ok, withMetadata: undefined },
      null,
    ];
    for (const query of bad) {
      await expect(
        reader.existingVersions(a, query as Parameters<typeof reader.existingVersions>[1]),
      ).rejects.toThrow(TypeError);
    }
  });
});
