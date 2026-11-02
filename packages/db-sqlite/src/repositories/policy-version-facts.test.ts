import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { seeder, type Seed } from '../testing/mutation-table/harness.js';
import { seedPackage, seedSource, seedVersion } from '../testing/mutation-table/fixtures.js';
import { createPolicyVersionFactsReader } from './policy-version-facts.js';

describe('policy version facts reader', () => {
  let database: MigratedDatabase;
  let seed: Seed;
  const org = () => database.orgs!.a;
  const read = (
    query: Parameters<ReturnType<typeof createPolicyVersionFactsReader>['versionFacts']>[1],
  ) => createPolicyVersionFactsReader(database.executor).versionFacts(org(), query);

  beforeEach(async () => {
    database = await openMigratedDatabase({ twoOrganizations: true });
    seed = seeder(database.executor);
    await seedSource(seed, 'S', org().orgId, 'hosted', 'npm');
    await seedPackage(seed, 'K', org().orgId, 'S', 'widget', 'npm');
    for (const n of [1, 2, 3])
      await seedVersion(seed, `V${String(n)}`, org().orgId, 'K', `1.0.${String(n)}`);
  });
  afterEach(() => database.close());

  it('reads the identity and stored dates of each version in id order', async () => {
    const rows = await read({ packageId: 'K', limit: 10 });
    expect(rows.map((row) => row.versionId)).toEqual(['V1', 'V2', 'V3']);
    expect(rows[0]).toMatchObject({
      packageId: 'K',
      sourceId: 'S',
      ecosystem: 'npm',
      packageKey: 'widget',
      version: '1.0.1',
      versionNormalized: '1.0.1',
      revision: 1,
      status: 'active',
      publishedAt: '2020-01-01T00:00:00.000Z',
      publishedAtBasis: 'upstream',
    });
    expect(typeof rows[0]!.createdAt).toBe('string');
  });

  it('pages by version id and narrows to the asked ids', async () => {
    expect((await read({ packageId: 'K', limit: 2 })).map((row) => row.versionId)).toEqual([
      'V1',
      'V2',
    ]);
    expect(
      (await read({ packageId: 'K', limit: 2, after: 'V2' })).map((row) => row.versionId),
    ).toEqual(['V3']);
    expect(
      (await read({ packageId: 'K', limit: 10, versionIds: ['V3', 'V1', 'V9'] })).map(
        (row) => row.versionId,
      ),
    ).toEqual(['V1', 'V3']);
  });

  it('reads newest first by publish date, then id, and refuses a cursor with it', async () => {
    await seed(
      "UPDATE version SET published_at='2021-01-01T00:00:00.000Z' WHERE org_id=? AND id='V1'",
      org().orgId,
    );
    expect(
      (await read({ packageId: 'K', limit: 2, newest: true })).map((row) => row.versionId),
    ).toEqual(['V1', 'V3']);
    await expect(read({ packageId: 'K', limit: 2, newest: true, after: 'V1' })).rejects.toThrow(
      RangeError,
    );
  });

  it('excludes a publish-held version the version lists exclude, but keeps other quarantines', async () => {
    await seed(
      "UPDATE version SET status='quarantined' WHERE org_id=? AND id IN ('V1','V2')",
      org().orgId,
    );
    await seed(
      `INSERT INTO publish_approval (id,org_id,package_id,version_id,source_id,hold_approval,hold_scan,approval_state,scan_state,requested_by_type,requested_by_id,token_id,expires_at)
      VALUES ('approval',?,'K','V1','S',1,0,'pending','not_required','service','principal','token','2099-01-01T00:00:00.000Z')`,
      org().orgId,
    );
    expect(
      (await read({ packageId: 'K', limit: 10 })).map((row) => [row.versionId, row.status]),
    ).toEqual([
      ['V2', 'quarantined'],
      ['V3', 'active'],
    ]);
  });

  it('refuses malformed input before any statement', async () => {
    await expect(read({ packageId: "K' or 1=1", limit: 10 })).rejects.toBeInstanceOf(TypeError);
    await expect(read({ packageId: 'K', limit: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(read({ packageId: 'K', limit: 501 })).rejects.toBeInstanceOf(RangeError);
    await expect(read({ packageId: 'K', limit: 10, after: 'x y' })).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(
      read({
        packageId: 'K',
        limit: 10,
        versionIds: Array.from({ length: 501 }, (_, n) => `V${String(n)}`),
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});
