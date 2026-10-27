import { afterEach, beforeEach, expect, it } from 'vitest';
import { PACKAGE_SYNC_JOB_TYPE } from '@package-broker/core/ingest/package-sync-job';
import type { JobEnqueue } from '@package-broker/core/platform/job-repository';
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

function syncJob(org: { orgId: string }, overrides: Partial<JobEnqueue> = {}): JobEnqueue {
  return {
    id: '01JA00000000000000000000J1',
    type: PACKAGE_SYNC_JOB_TYPE,
    payloadJson: JSON.stringify({ key: 'widget', sourceId: 'SOURCE' }),
    idempotencyKey: `${PACKAGE_SYNC_JOB_TYPE}:${org.orgId}-op`,
    resourceKey: 'resource',
    runAt: null,
    maxAttempts: 25,
    projectId: 'PROJECT',
    initiatorTokenId: null,
    ...overrides,
  };
}

const jobs = () =>
  database.executor.all({
    sql: 'SELECT id, org_id, type, project_id, state, max_attempts, resource_key FROM job',
    params: [],
  });
const audits = () => database.executor.all({ sql: 'SELECT id FROM audit_pending', params: [] });

it('queues the package sync job together with its audit row in the organization', async () => {
  const { org, fence, input } = await seedRequest(context);
  const store = createSourcePackageStore(database.executor, ANCHORS);
  expect(await store.request(org, fence, { ...input, job: syncJob(org) })).toBe('accepted');
  expect(await jobs()).toEqual([
    {
      id: '01JA00000000000000000000J1',
      org_id: org.orgId,
      type: PACKAGE_SYNC_JOB_TYPE,
      project_id: 'PROJECT',
      state: 'queued',
      max_attempts: 25,
      resource_key: 'resource',
    },
  ]);
  expect(await audits()).toHaveLength(1);
});

it('leaves no queued job when the audit write fails', async () => {
  const { org, fence, input } = await seedRequest(context);
  const store = createSourcePackageStore(database.executor, ANCHORS);
  expect(await store.request(org, fence, input)).toBe('accepted');
  expect(await audits()).toHaveLength(1);
  expect(
    await store.request(org, fence, {
      ...input,
      job: syncJob(org, { id: '01JA00000000000000000000J2' }),
    }),
  ).toBe('unavailable');
  expect(await jobs()).toEqual([]);
  expect(await audits()).toHaveLength(1);
});

it('leaves no audit row when the job insert fails', async () => {
  const { org, fence, input } = await seedRequest(context);
  await database.executor.batch([
    {
      sql: "INSERT INTO job (id, org_id, type) VALUES ('01JA00000000000000000000J1', ?, 'other')",
      params: [org.orgId],
    },
  ]);
  expect(
    await createSourcePackageStore(database.executor, ANCHORS).request(org, fence, {
      ...input,
      job: syncJob(org),
    }),
  ).toBe('unavailable');
  expect(await audits()).toEqual([]);
  expect(await jobs()).toHaveLength(1);
});

it.each([
  ["DELETE FROM role_permission WHERE role_id = 'R-package-request'", 'forbidden'],
  ["UPDATE session SET expires_at = '2000-01-01T00:00:00.000Z'", 'forbidden'],
  ['DELETE FROM project_source', 'not_found'],
  ["UPDATE source SET status = 'paused'", 'not_found'],
] as const)(
  'leaves no job and no audit when authority changes after the probe: %s',
  async (change, expected) => {
    const { org, fence, input } = await seedRequest(context);
    const store = createSourcePackageStore(database.executor, ANCHORS);
    const probe = { projectId: input.projectId, sourceId: input.sourceId };
    expect(await store.request(org, fence, probe)).toBe('accepted');
    await database.executor.batch([{ sql: change, params: [] }]);
    expect(await store.request(org, fence, { ...input, job: syncJob(org) })).toBe(expected);
    expect(await jobs()).toEqual([]);
    expect(await audits()).toEqual([]);
  },
);

it('refuses a job that does not match the requested source or project', async () => {
  const { org, fence, input } = await seedRequest(context);
  const store = createSourcePackageStore(database.executor, ANCHORS);
  for (const job of [
    syncJob(org, { payloadJson: JSON.stringify({ key: 'widget', sourceId: 'OTHER' }) }),
    syncJob(org, { projectId: 'OTHER' }),
    syncJob(org, { type: 'core:source-sync:v1' }),
    syncJob(org, { initiatorTokenId: 'token' }),
  ]) {
    await expect(store.request(org, fence, { ...input, job })).rejects.toThrow(TypeError);
  }
  const withoutAudit = { projectId: input.projectId, sourceId: input.sourceId };
  await expect(store.request(org, fence, { ...withoutAudit, job: syncJob(org) })).rejects.toThrow(
    TypeError,
  );
  expect(await jobs()).toEqual([]);
  expect(await audits()).toEqual([]);
});

it('refuses malformed job rows with the same TypeError before any write', async () => {
  const { org, fence, input } = await seedRequest(context);
  const store = createSourcePackageStore(database.executor, ANCHORS);
  for (const overrides of [
    { runAt: '2026-10-27T00:00:00.000Z' },
    { maxAttempts: 0 },
    { maxAttempts: 101 },
    { maxAttempts: 1.5 },
    { idempotencyKey: '' },
    { idempotencyKey: 'k'.repeat(513) },
    { resourceKey: null },
    { resourceKey: '' },
    { id: '' },
    { payloadJson: '{not json' },
    { payloadJson: 'null' },
    { payloadJson: JSON.stringify({ sourceId: 'SOURCE', key: 123 }) },
    { payloadJson: JSON.stringify({ sourceId: 'SOURCE' }) },
    { payloadJson: JSON.stringify({ sourceId: 'SOURCE', key: 'é'.repeat(65536) }) },
  ] satisfies Partial<JobEnqueue>[]) {
    await expect(
      store.request(org, fence, { ...input, job: syncJob(org, overrides) }),
    ).rejects.toThrow(TypeError);
  }
  expect(await jobs()).toEqual([]);
  expect(await audits()).toEqual([]);
  expect(
    await store.request(org, fence, { ...input, job: syncJob(org, { maxAttempts: 100 }) }),
  ).toBe('accepted');
  expect(await jobs()).toHaveLength(1);
  expect(await audits()).toHaveLength(1);
});
