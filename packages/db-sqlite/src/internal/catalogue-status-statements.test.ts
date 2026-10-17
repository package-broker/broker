import { afterEach, beforeEach, expect, it } from 'vitest';
import type { OrgContext } from '@package-broker/core/db/port';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { conditionalEpochBumpStatement } from './catalogue-status-statements.js';

let database: MigratedDatabase;
let org: OrgContext;
let other: OrgContext;

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('organizations were not seeded');
  org = database.orgs.a;
  other = database.orgs.b;
  await database.executor.batch([
    {
      sql: 'INSERT OR REPLACE INTO cache_epoch (org_id, version) VALUES (?, ?), (?, ?)',
      params: [org.orgId, 'epoch-a', other.orgId, 'epoch-b'],
    },
    {
      sql: `INSERT INTO source (id, org_id, name, ecosystem, type)
        VALUES ('source', ?, 'main', 'composer', 'composer_repository')`,
      params: [org.orgId],
    },
    {
      sql: `INSERT INTO package (id, org_id, source_id, ecosystem, name)
        VALUES ('package', ?, 'source', 'composer', 'acme/widget')`,
      params: [org.orgId],
    },
    {
      sql: `INSERT INTO version (id, org_id, package_id, version, version_normalized,
        published_at, published_at_basis, metadata_json, status, last_op_id)
        VALUES ('version', ?, 'package', '1.0.0', '1.0.0.0',
          '2020-01-01T00:00:00.000Z', 'release_date', '{}', 'quarantined', 'operation')`,
      params: [org.orgId],
    },
  ]);
});

afterEach(async () => {
  await database.close();
});

const epochs = () =>
  database.executor.all<{ orgId: string; version: string }>({
    sql: 'SELECT org_id AS orgId, version FROM cache_epoch ORDER BY org_id',
    params: [],
  });

it('bumps only the epoch of the organization whose version has the operation id', async () => {
  const result = await database.executor.batch([
    conditionalEpochBumpStatement(org, 'version', 'operation'),
  ]);
  expect(result[0]?.changes).toBe(1);
  const rows = await epochs();
  expect(rows.find((row) => row.orgId === org.orgId)?.version).not.toBe('epoch-a');
  expect(rows.find((row) => row.orgId === other.orgId)?.version).toBe('epoch-b');
});

it('leaves both epochs unchanged for a foreign version with a matching operation id', async () => {
  const before = await epochs();
  const result = await database.executor.batch([
    conditionalEpochBumpStatement(other, 'version', 'operation'),
  ]);
  expect(result[0]?.changes).toBe(0);
  expect(await epochs()).toEqual(before);
});

it.each([
  ['version', 'different-operation'],
  ['missing-version', 'operation'],
])('leaves epochs unchanged for %s and %s', async (versionId, opId) => {
  const before = await epochs();
  const result = await database.executor.batch([
    conditionalEpochBumpStatement(org, versionId, opId),
  ]);
  expect(result[0]?.changes).toBe(0);
  expect(await epochs()).toEqual(before);
});

it('accepts a missing epoch row without creating one', async () => {
  await database.executor.batch([
    { sql: 'DELETE FROM cache_epoch WHERE org_id = ?', params: [org.orgId] },
  ]);
  const before = await epochs();
  const result = await database.executor.batch([
    conditionalEpochBumpStatement(org, 'version', 'operation'),
  ]);
  expect(result[0]?.changes).toBe(0);
  expect(await epochs()).toEqual(before);
});
