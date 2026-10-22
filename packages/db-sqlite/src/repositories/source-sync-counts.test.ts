import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACCESS_MUTATION_GUARD_CONSTRAINT, DbError } from '@package-broker/core/db/errors';
import { completeSourceListing } from '@package-broker/core/catalogue/version-rules';
import type { OrgContext, Statement } from '@package-broker/core/db/port';
import { withForeignKeysOff } from '../testing/foreign-keys-off.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createCatalogueWriteGuard } from './catalogue-write-package.js';
import { createCatalogueWriter } from './catalogue-writer.js';
import { createSourceSyncCounts } from './source-sync-counts.js';

const OLD = '2020-01-01T00:00:00.000Z';
let database: MigratedDatabase;
let own: OrgContext;
let foreign: OrgContext;
const stmt = (sql: string, ...params: Statement['params']): Statement => ({ sql, params });
const scope = { kind: 'source', sourceId: 'S' } as const;

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  own = database.orgs!.a;
  foreign = database.orgs!.b;
  const statements = [
    stmt(
      "INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence) VALUES ('job', ?, 'sync', 'sync', 'running', 'worker', '2999-01-01T00:00:00.000Z', 1)",
      own.orgId,
    ),
    ...['S', 'T'].map((id) =>
      stmt(
        "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, ?, ?, 'composer', 'composer_repository')",
        id,
        own.orgId,
        id,
      ),
    ),
    ...[own, foreign].flatMap((org, index) =>
      ['S', 'T'].flatMap((source) =>
        Array.from({ length: 5 }, (_, i) =>
          stmt(
            "INSERT INTO package (id, org_id, source_id, ecosystem, name, updated_at) VALUES (?, ?, ?, 'composer', ?, ?)",
            `${index === 0 ? 'o' : 'f'}-${source}${String(i + 1)}`,
            org.orgId,
            source,
            `${index === 0 ? 'acme' : 'other'}/${source.toLowerCase()}${String(i + 1)}`,
            OLD,
          ),
        ),
      ),
    ),
  ];
  await withForeignKeysOff(database.executor, () => database.executor.batch(statements));
});
afterEach(async () => {
  await database.close();
});

const guard = () => createCatalogueWriteGuard(own, { id: 'job', owner: 'worker', fence: 1 });
const writer = () => createCatalogueWriter(database.executor);
const counts = () => createSourceSyncCounts(database.executor);

async function markedSession(marked: number) {
  const { stamp } = await writer().openListing(own, guard(), scope);
  await writer().markListing(own, guard(), {
    scope,
    stamp,
    present: Array.from({ length: marked }, (_, i) => `acme/s${String(i + 1)}`),
  });
  await database.executor.batch([
    stmt(
      "UPDATE package SET listing_seen_stamp = ? WHERE source_id = 'T' OR org_id = ?",
      stamp,
      foreign.orgId,
    ),
  ]);
  return stamp;
}

const setStatus = (id: string, status: 'active' | 'removed_upstream') =>
  database.executor.batch([
    stmt(
      "UPDATE package SET status = ?, removed_upstream_at = CASE WHEN ? = 'removed_upstream' THEN ? END WHERE id = ?",
      status,
      status,
      OLD,
      id,
    ),
  ]);

const finalize = (stamp: string, marked: number) =>
  writer().finalizeListing(
    own,
    guard(),
    completeSourceListing({ sourceId: 'S', stamp, count: marked }),
    { attemptedCandidates: marked, successfulCandidates: marked, definitiveAbsent: 0 },
  );

describe('source sync counts', () => {
  it('markedCount counts this listing stamp in the own source only', async () => {
    const stamp = await markedSession(3);
    expect(await counts().markedCount(own, 'S', stamp)).toBe(3);
    expect(await counts().markedCount(own, 'S', OLD)).toBe(0);
    expect(await counts().markedCount(foreign, 'S', stamp)).toBe(0);
  });

  it('unseenExistingCount equals the number at which finalizeListing refuses or accepts', async () => {
    const stamp = await markedSession(3);
    await setStatus('o-S5', 'removed_upstream');
    expect(await counts().unseenExistingCount(own, 'S', stamp)).toBe(1);
    await setStatus('o-S5', 'active');
    expect(await counts().unseenExistingCount(own, 'S', stamp)).toBe(2);
    await expect(finalize(stamp, 3)).rejects.toBeInstanceOf(DbError);
    await expect(finalize(stamp, 3)).rejects.toMatchObject({
      constraint: ACCESS_MUTATION_GUARD_CONSTRAINT,
    });
    await setStatus('o-S5', 'removed_upstream');
    expect(await counts().unseenExistingCount(own, 'S', stamp)).toBe(1);
    expect(await finalize(stamp, 3)).toMatchObject({ removed: 1 });
  });

  it('does not count foreign organization or other source rows', async () => {
    const stamp = await markedSession(3);
    expect(await counts().markedCount(own, 'S', stamp)).toBe(3);
    expect(await counts().unseenExistingCount(own, 'S', stamp)).toBe(2);
  });

  it('rejects without an open listing and for a stamp that is not the open one', async () => {
    await expect(counts().unseenExistingCount(own, 'S', OLD)).rejects.toThrow();
    const stamp = await markedSession(3);
    await expect(counts().unseenExistingCount(own, 'S', OLD)).rejects.toThrow();
    await expect(counts().unseenExistingCount(foreign, 'S', stamp)).rejects.toThrow();
    await expect(counts().unseenExistingCount(own, 'T', stamp)).rejects.toThrow();
  });

  it('rejects an empty source id', async () => {
    await expect(counts().markedCount(own, '', OLD)).rejects.toThrow();
    await expect(counts().unseenExistingCount(own, '', OLD)).rejects.toThrow();
  });
});
