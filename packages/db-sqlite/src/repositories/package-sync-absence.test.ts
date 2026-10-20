import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CatalogueWriteGuard } from '@package-broker/core/db/catalogue';
import type { OrgContext } from '@package-broker/core/db/port';
import { jobFences } from '@package-broker/core/platform/job-fences';
import type { JobContext } from '@package-broker/core/platform/jobs';
import { createPackageSyncJob } from '@package-broker/core/ingest/package-sync-job';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createCatalogueWriteGuard } from './catalogue-write-package.js';
import { createCatalogueWriter } from './catalogue-writer.js';
import { createUpstreamStateRepository } from './upstream-state.js';

const OLD = '2020-01-01T00:00:00.000Z';
let database: MigratedDatabase;
let ctx: OrgContext;
let guard: CatalogueWriteGuard;

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  ctx = database.orgs!.a;
  const run = (sql: string, ...params: (string | number)[]) =>
    database.executor.batch([{ sql, params }]);
  await run(
    "INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence) VALUES ('J', ?, 'sync:v1', 'J', 'running', 'worker', '2099-01-01T00:00:00.000Z', 1)",
    ctx.orgId,
  );
  await run(
    "INSERT INTO source (id, org_id, name, ecosystem, type, removal_policy) VALUES ('S', ?, 'source', 'composer', 'packagist_proxy', 'exclude')",
    ctx.orgId,
  );
  await run(
    "INSERT INTO package (id, org_id, source_id, ecosystem, name, updated_at) VALUES ('P', ?, 'S', 'composer', 'acme/lib', ?)",
    ctx.orgId,
    OLD,
  );
  await run(
    "INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json, updated_at) VALUES ('V', ?, 'P', '1.0.0', '1.0.0', ?, 'release_date', '{}', ?)",
    ctx.orgId,
    OLD,
    OLD,
  );
  for (const form of ['composer-p2', 'composer-p2-dev']) {
    await run(
      "INSERT INTO upstream_state (org_id, package_id, form, checked_at, fresh_until) VALUES (?, 'P', ?, ?, ?)",
      ctx.orgId,
      form,
      OLD,
      OLD,
    );
  }
  guard = createCatalogueWriteGuard(ctx, { id: 'J', owner: 'worker', fence: 1 });
});
afterEach(async () => {
  await database.close();
});

const status = async () =>
  (
    await database.executor.all<{ status: string }>({
      sql: "SELECT status FROM package WHERE id = 'P'",
      params: [],
    })
  )[0]!.status;

it('two Composer 404s an hour apart reach the real absence transition', async () => {
  const session = {
    id: 'sess',
    scopeKey: 'scope',
    owner: 'worker',
    fence: 1,
    leaseSeconds: 60,
    generation: 1,
    stamp: null,
    snapshotId: null,
    snapshotBlobSha256: null,
    cursor: null,
    seenCount: 0,
    pagesSoFar: 0,
    pendingValidators: null,
  };
  const sessions = {
    acquire: async () => session,
    abandon: async () => true,
    release: async () => true,
  };
  const job = createPackageSyncJob({
    sessions,
    apply: { writer: createCatalogueWriter(database.executor) },
    jobs: { enqueue: vi.fn() },
    upstreamState: createUpstreamStateRepository(database.executor),
    executor: database.executor,
    sourceMetadata: async () => ({ type: 'packagist_proxy' }),
    findPackageId: async () => 'P',
    planFill: async () => ({
      describe: async () => ({ kind: 'not_found', definitive: true }),
      publishedValidators: {},
      validatorTtlSeconds: 300,
    }),
    writeGuard: () => guard,
    clock: { now: () => new Date() },
  } as never);
  const context = {
    org: ctx,
    jobId: 'J',
    signal: new AbortController().signal,
    fences: jobFences({ id: 'J', owner: 'worker', fence: 1 }),
  } as JobContext;
  const run = () => job.handler({ sourceId: 'S', key: 'acme/lib' }, context);

  await run();
  await run();
  expect(await status()).toBe('active');

  await database.executor.batch([
    { sql: 'UPDATE upstream_state SET first_not_found_at = ?', params: [OLD] },
  ]);
  await run();
  expect(await status()).toBe('removed_upstream');
});
