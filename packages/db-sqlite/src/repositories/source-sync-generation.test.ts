import { afterEach, beforeEach, expect, it } from 'vitest';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import type { PackageSyncDeps } from '@package-broker/core/ingest/package-sync-job';
import { createPackageSyncJob } from '@package-broker/core/ingest/package-sync-job';
import { jobFences } from '@package-broker/core/platform/job-fences';
import { JobError, type JobContext } from '@package-broker/core/platform/jobs';
import { UpstreamError } from '@package-broker/core/sources/policy-fetch';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createJobRepository } from './job.js';
import { createSourceRepository } from './source.js';
import { createIngestSessions } from './ingest-session.js';

let database: MigratedDatabase;
let org: OrgContext;
let executor: SqlExecutor;
const generation = 'a'.repeat(64);
const otherGeneration = 'b'.repeat(64);
const statement = (sql: string, ...params: Statement['params']): Statement => ({ sql, params });
let owner = 0;
const jobs = () => createJobRepository(executor, { random: () => 0 });
const sources = () => createSourceRepository(executor);
const claim = async (id: string) => {
  const result = await jobs().claim(
    org,
    `01J0000000000000000000${String(++owner).padStart(4, '0')}`,
    {
      id,
      types: ['core:package-sync:v1'],
      leaseSeconds: 60,
      maxRunning: 20,
    },
  );
  expect(result).not.toBeNull();
  return result!;
};
const status = async () => (await sources().get(org, 'source'))!.sync!;
const enqueue = (id: string, key: string, syncGeneration = generation, extra = {}) =>
  jobs().enqueue(org, {
    id,
    type: 'core:package-sync:v1',
    payloadJson: JSON.stringify({ sourceId: 'source', key, syncGeneration, ...extra }),
    idempotencyKey: id,
    resourceKey: key,
    runAt: null,
    maxAttempts: 5,
    projectId: null,
    initiatorTokenId: null,
  });

beforeEach(async () => {
  owner = 0;
  database = await openMigratedDatabase({ twoOrganizations: true });
  org = database.orgs!.a;
  executor = {
    driver: database.executor.driver,
    all: (s) => database.executor.all(s),
    batch: (statements) => {
      expect(statements.length).toBeLessThanOrEqual(200);
      for (const s of statements) expect(s.params.length).toBeLessThanOrEqual(100);
      return database.executor.batch(statements);
    },
  };
  await executor.batch([
    statement(
      "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('source', ?, 'source', 'npm', 'npm_registry')",
      org.orgId,
    ),
    statement(
      "INSERT INTO job (id, org_id, type, state, resource_key, lease_owner, lease_until, fence) VALUES ('listing', ?, 'core:source-sync:v1', 'running', 'source:source', 'listing-owner', '2999-01-01T00:00:00.000Z', 1)",
      org.orgId,
    ),
  ]);
  expect(
    await sources().pollState(
      org,
      { id: 'listing', owner: 'listing-owner', fence: 1 },
      {
        id: 'source',
        outcome: 'started',
        generation,
      },
    ),
  ).toBe('written');
});
afterEach(async () => database.close());

it('records two completed packages and one stable child failure, then clears it on successful retry', async () => {
  for (const key of ['one', 'two', 'three']) await enqueue(key, key);
  expect(await status()).toMatchObject({
    generation,
    queued: 3,
    running: 0,
    failed: 0,
    completed: 0,
  });
  for (const key of ['one', 'two'])
    await jobs().settle(org, await claim(key), { outcome: 'succeeded' });
  const failed = await claim('three');
  expect(await status()).toMatchObject({ queued: 0, running: 1, completed: 2 });
  const deps = {
    sourceErrorStatements: sources().packageErrorStatements,
    sessions: createIngestSessions(executor),
    executor,
    planFill: async () => ({
      describe: async () => {
        throw new UpstreamError('http_status', 429);
      },
    }),
    sourceMetadata: async () => ({ type: 'npm_registry' }),
  } as unknown as PackageSyncDeps;
  const context = {
    org,
    jobId: failed.id,
    attempt: failed.attempt,
    fence: failed.fence,
    idempotencyKey: failed.idempotencyKey,
    signal: new AbortController().signal,
    fences: jobFences(failed),
  } as unknown as JobContext;
  await expect(
    createPackageSyncJob(deps).handler(JSON.parse(failed.payloadJson), context),
  ).rejects.toBeInstanceOf(JobError);
  await jobs().settle(org, failed, {
    outcome: 'failed',
    errorCode: 'handler_error',
    permanent: false,
  });
  expect(await status()).toMatchObject({
    queued: 1,
    running: 0,
    completed: 2,
    failed: 1,
    errors: [{ code: 'rate_limited', count: 1 }],
  });
  await executor.batch([
    statement(
      "UPDATE job SET run_at = '2000-01-01T00:00:00.000Z' WHERE org_id = ? AND id = 'three'",
      org.orgId,
    ),
  ]);
  const retried = await claim('three');
  const success = {
    ...deps,
    planFill: async () => ({ describe: async () => ({ kind: 'not_modified' }) }),
    findPackageId: async () => null,
  } as unknown as PackageSyncDeps;
  await createPackageSyncJob(success).handler(JSON.parse(retried.payloadJson), {
    ...context,
    fences: jobFences(retried),
  });
  await jobs().settle(org, retried, { outcome: 'succeeded' });
  expect(await status()).toMatchObject({
    queued: 0,
    running: 0,
    failed: 0,
    completed: 3,
    errors: [],
  });
});

it('resets an empty new generation and ignores late jobs from the previous generation', async () => {
  await enqueue('old', 'one');
  const old = await claim('old');
  await sources().pollState(
    org,
    { id: 'listing', owner: 'listing-owner', fence: 1 },
    { id: 'source', outcome: 'started', generation: otherGeneration },
  );
  expect(await status()).toMatchObject({
    generation: otherGeneration,
    queued: 0,
    running: 0,
    failed: 0,
    completed: 0,
    errors: [],
  });
  await jobs().settle(org, old, { outcome: 'failed', errorCode: 'handler_error', permanent: true });
  await enqueue('late', 'two');
  expect(await status()).toMatchObject({
    generation: otherGeneration,
    failed: 0,
    completed: 0,
    queued: 0,
  });
  await enqueue('new', 'one', otherGeneration);
  expect(await status()).toMatchObject({ queued: 1, completed: 0 });
});

it('counts continuation jobs once per package and does not let parent settlement finish the child', async () => {
  await enqueue('first', 'one');
  const first = await claim('first');
  await enqueue('next', 'one', generation, { sessionId: 'session', generation: 1, step: 1 });
  await jobs().settle(org, first, { outcome: 'succeeded' });
  expect(await status()).toMatchObject({ queued: 1, running: 0, completed: 0 });
  await jobs().settle(org, await claim('next'), { outcome: 'succeeded' });
  expect(await status()).toMatchObject({ queued: 0, completed: 1 });
});

it('publishes expiry failures in the reaper batch and refuses stale settlement', async () => {
  await enqueue('expired', 'one');
  const expired = await claim('expired');
  await executor.batch([
    statement(
      "UPDATE job SET lease_until = '2000-01-01T00:00:00.000Z' WHERE org_id = ? AND id = 'expired'",
      org.orgId,
    ),
  ]);
  await executor.batch(sources().packageErrorStatements!(org, expired, 'network'));
  expect(
    await executor.all(
      statement("SELECT sync_error FROM job WHERE org_id = ? AND id = 'expired'", org.orgId),
    ),
  ).toEqual([{ sync_error: null }]);
  await jobs().reap(org, 1);
  expect(await status()).toMatchObject({
    queued: 1,
    running: 0,
    failed: 1,
    errors: [{ code: 'internal', count: 1 }],
  });
  await expect(jobs().settle(org, expired, { outcome: 'succeeded' })).rejects.toThrow();
  expect(await status()).toMatchObject({ completed: 0, failed: 1 });
});

it('cannot attribute a foreign organization job to this source', async () => {
  const foreign = database.orgs!.b;
  await createJobRepository(executor).enqueue(foreign, {
    id: 'foreign',
    type: 'core:package-sync:v1',
    payloadJson: JSON.stringify({ sourceId: 'source', key: 'secret', syncGeneration: generation }),
    idempotencyKey: 'foreign',
    resourceKey: null,
    runAt: null,
    maxAttempts: 2,
    projectId: null,
    initiatorTokenId: null,
  });
  expect(await status()).toMatchObject({ queued: 0, running: 0, failed: 0 });
  expect(await sources().get(foreign, 'source')).toBeNull();
});

it('uses returned rows for exact counts when D1 metadata includes trigger writes', async () => {
  const original = executor;
  executor = {
    ...original,
    async batch(statements) {
      const results = await original.batch(statements);
      return results.map((result, index) => ({
        ...result,
        changes:
          /^(UPDATE job SET|update "source" set)/i.test(statements[index]!.sql) &&
          result.changes > 0
            ? result.changes + 7
            : result.changes,
      }));
    },
  };
  expect(
    await sources().pollState(
      org,
      { id: 'listing', owner: 'listing-owner', fence: 1 },
      {
        id: 'source',
        outcome: 'started',
        generation: otherGeneration,
      },
    ),
  ).toBe('written');
  await enqueue('d1', 'one', otherGeneration);
  await claim('d1');
  await executor.batch([
    statement(
      "UPDATE job SET lease_until = '2000-01-01T00:00:00.000Z' WHERE org_id = ? AND id = 'd1'",
      org.orgId,
    ),
  ]);
  expect(await jobs().reap(org, 1)).toBe(1);
  expect(await status()).toMatchObject({ queued: 1, running: 0, failed: 1 });
});

it('groups child codes by failed package and decrements a shared code on retry success', async () => {
  for (const [index, code] of ['rate_limited', 'rate_limited', 'network'].entries()) {
    const id = `group-${index}`;
    await enqueue(id, id);
    const held = await claim(id);
    await executor.batch(
      sources().packageErrorStatements!(org, held, code as 'rate_limited' | 'network'),
    );
    expect((await status()).failed).toBe(index);
    await jobs().settle(org, held, {
      outcome: 'failed',
      errorCode: 'handler_error',
      permanent: false,
    });
  }
  expect(await status()).toMatchObject({
    failed: 3,
    queued: 3,
    errors: [
      { code: 'rate_limited', count: 2 },
      { code: 'network', count: 1 },
    ],
  });
  await executor.batch([
    statement(
      "UPDATE job SET run_at = '2000-01-01T00:00:00.000Z' WHERE org_id = ? AND id = 'group-0'",
      org.orgId,
    ),
  ]);
  await jobs().settle(org, await claim('group-0'), { outcome: 'succeeded' });
  expect(await status()).toMatchObject({
    completed: 1,
    failed: 2,
    queued: 2,
    errors: [
      { code: 'network', count: 1 },
      { code: 'rate_limited', count: 1 },
    ],
  });
});
