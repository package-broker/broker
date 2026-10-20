import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrgContext } from '@package-broker/core/db/port';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createPackageIdReads } from './package-id.js';

let database: MigratedDatabase;
let ctx: OrgContext;
let other: OrgContext;

async function exec(sql: string, params: (string | number | null)[] = []): Promise<void> {
  await database.executor.batch([{ sql, params }]);
}

async function source(id: string, org: OrgContext = ctx): Promise<void> {
  await exec(
    "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, ?, ?, 'composer', 'vcs')",
    [id, org.orgId, id],
  );
}

async function pkg(
  id: string,
  sourceId: string,
  name: string,
  org: OrgContext = ctx,
  status = 'active',
): Promise<void> {
  await exec(
    `INSERT INTO package (id, org_id, source_id, ecosystem, name, status, removed_upstream_at)
     VALUES (?, ?, ?, 'composer', ?, ?, ?)`,
    [
      id,
      org.orgId,
      sourceId,
      name,
      status,
      status === 'removed_upstream' ? '2020-01-01T00:00:00.000Z' : null,
    ],
  );
}

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('orgs missing');
  ctx = database.orgs.a;
  other = database.orgs.b;
});

afterEach(async () => {
  await database.close();
});

describe('packageId', () => {
  it('returns the id of the own-organization package', async () => {
    await source('S1');
    await pkg('K1', 'S1', 'acme/widget');
    expect(await createPackageIdReads(database.executor).packageId(ctx, 'S1', 'acme/widget')).toBe(
      'K1',
    );
  });

  it('returns null for the same source id and name in another organization', async () => {
    await source('S1');
    await pkg('K1', 'S1', 'acme/widget');
    expect(
      await createPackageIdReads(database.executor).packageId(other, 'S1', 'acme/widget'),
    ).toBeNull();
  });

  it('does not read a package of another organization through a foreign source', async () => {
    await source('SF', other);
    await pkg('KF', 'SF', 'acme/widget', other);
    const reads = createPackageIdReads(database.executor);
    expect(await reads.packageId(ctx, 'SF', 'acme/widget')).toBeNull();
    expect(await reads.packageId(other, 'SF', 'acme/widget')).toBe('KF');
  });

  it('returns null for another source of the same organization', async () => {
    await source('S1');
    await source('S2');
    await pkg('K1', 'S1', 'acme/widget');
    expect(
      await createPackageIdReads(database.executor).packageId(ctx, 'S2', 'acme/widget'),
    ).toBeNull();
  });

  it('returns null for an absent name', async () => {
    await source('S1');
    expect(
      await createPackageIdReads(database.executor).packageId(ctx, 'S1', 'acme/none'),
    ).toBeNull();
  });

  it('returns the id of a removed_upstream package', async () => {
    await source('S1');
    await pkg('K1', 'S1', 'acme/widget', ctx, 'removed_upstream');
    expect(await createPackageIdReads(database.executor).packageId(ctx, 'S1', 'acme/widget')).toBe(
      'K1',
    );
  });

  it.each([
    ['', 'acme/widget'],
    ['S1', ''],
  ])('throws TypeError for source %j and key %j', async (sourceId, key) => {
    await expect(
      createPackageIdReads(database.executor).packageId(ctx, sourceId, key),
    ).rejects.toThrow(TypeError);
  });
});
