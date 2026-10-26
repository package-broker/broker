import { afterEach, beforeEach, expect, it } from 'vitest';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { seedRequest } from '../testing/mutation-table/source-package-request.js';
import { ANCHORS } from '../testing/mutation-table/fixtures.js';
import type { CaseContext } from '../testing/mutation-table/harness.js';
import { createSourcePackageStore } from './source-package-request.js';

let database: MigratedDatabase;
let context: CaseContext;
beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
  context = {
    executor: database.executor,
    orgs: database.orgs!,
    mutate: (s) => s,
    mutateBatch: (s) => s,
  };
});
afterEach(async () => {
  await database.close();
});

it('accepts an attached organization source using project authority and records audit', async () => {
  const { org, fence, input } = await seedRequest(context);
  const store = createSourcePackageStore(database.executor, ANCHORS);
  expect(await store.request(org, fence, input)).toBe('accepted');
  expect(
    await database.executor.all({
      sql: 'SELECT org_id, action, target_id, project_id FROM audit_pending',
      params: [],
    }),
  ).toEqual([
    {
      org_id: org.orgId,
      action: 'source.package_requested',
      target_id: 'SOURCE',
      project_id: 'PROJECT',
    },
  ]);
});

it.each([
  ['DELETE FROM project_source', 'not_found'],
  ["UPDATE source SET status = 'paused'", 'not_found'],
  ["UPDATE source SET type = 'hosted'", 'not_found'],
  ["DELETE FROM role_permission WHERE role_id = 'R-package-request'", 'forbidden'],
  ["UPDATE session SET expires_at = '2000-01-01T00:00:00.000Z'", 'forbidden'],
  ["UPDATE project SET status = 'archived'", 'forbidden'],
] as const)('rechecks live authority and target: %s', async (sql, expected) => {
  const { org, fence, input } = await seedRequest(context);
  await database.executor.batch([{ sql, params: [] }]);
  expect(
    await createSourcePackageStore(database.executor, ANCHORS).request(org, fence, input),
  ).toBe(expected);
  expect(await database.executor.all({ sql: 'SELECT id FROM audit_pending', params: [] })).toEqual(
    [],
  );
});

it('only reports complete active packages from the selected source in the organization', async () => {
  const { org } = await seedRequest(context);
  const store = createSourcePackageStore(database.executor, ANCHORS);
  await database.executor.batch([
    {
      sql: "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('PKG', ?, 'SOURCE', 'npm', 'widget')",
      params: [org.orgId],
    },
  ]);
  expect(await store.present(org, 'SOURCE', 'widget')).toBe(false);
  await database.executor.batch([
    { sql: "UPDATE package SET last_synced_at = '2026-10-26T00:00:00.000Z'", params: [] },
  ]);
  expect(await store.present(org, 'SOURCE', 'widget')).toBe(true);
  expect(await store.present(database.orgs!.b, 'SOURCE', 'widget')).toBe(false);
  expect(await store.present(org, 'OTHER', 'widget')).toBe(false);
  await database.executor.batch([
    { sql: "UPDATE package SET status = 'removed_upstream'", params: [] },
  ]);
  expect(await store.present(org, 'SOURCE', 'widget')).toBe(false);
});

it('checks authority without audit before queueing or for an already present package', async () => {
  const { org, fence, input } = await seedRequest(context);
  expect(
    await createSourcePackageStore(database.executor, ANCHORS).request(org, fence, {
      projectId: input.projectId,
      sourceId: input.sourceId,
    }),
  ).toBe('accepted');
  expect(await database.executor.all({ sql: 'SELECT id FROM audit_pending', params: [] })).toEqual(
    [],
  );
});

it('refuses an organization proxy attached only to another project', async () => {
  const { org, fence, input } = await seedRequest(context);
  await database.executor.batch([
    {
      sql: "INSERT INTO project (id, org_id, slug, name) VALUES ('OTHER', ?, 'other', 'Other')",
      params: [org.orgId],
    },
    { sql: "UPDATE project_source SET project_id = 'OTHER'", params: [] },
  ]);
  expect(
    await createSourcePackageStore(database.executor, ANCHORS).request(org, fence, input),
  ).toBe('not_found');
  expect(await database.executor.all({ sql: 'SELECT id FROM audit_pending', params: [] })).toEqual(
    [],
  );
});
