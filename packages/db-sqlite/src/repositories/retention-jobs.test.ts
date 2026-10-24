import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgContext, SqlExecutor } from '@package-broker/core/db/port';
import { blobStorageKey, type ByteStore, type Sha256 } from '@package-broker/core/platform/blob';
import { createBlobLifecycle } from '@package-broker/core/platform/blob-lifecycle';
import type { JobContext, Jobs } from '@package-broker/core/platform/jobs';
import { createRepositoryJobs } from '@package-broker/core/platform/jobs-port';
import { fixedClock, ulid } from '@package-broker/core/ids';
import { registerCoreJob } from '@package-broker/core/runtime/core-jobs';
import { sourceSyncJob } from '@package-broker/core/ingest/source-sync-job';
import {
  createBlobPurgeJob,
  createRetentionScanJob,
  createSourcePollJob,
} from '@package-broker/core/ingest/retention-jobs';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createBlobRepository } from './blob.js';
import { createBlobReferenceReader } from './blob-references.js';
import { createSourceRepository } from './source.js';
import { createJobRepository } from './job.js';

const D1 = 'a'.repeat(64) as Sha256;
const D2 = 'b'.repeat(64) as Sha256;
const DAY = 86_400_000;

let database: MigratedDatabase;
let a: OrgContext;
let b: OrgContext;
let executor: SqlExecutor;

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('organizations were not seeded');
  ({ a, b } = database.orgs);
  executor = database.executor;
});

afterEach(async () => {
  await database.close();
});

async function exec(sql: string, ...params: (string | number | null)[]): Promise<void> {
  await executor.batch([{ sql, params }]);
}

async function rowOf(sha: Sha256) {
  return (
    await executor.all<{ purge_after: string | null; deleted_at: string | null }>({
      sql: 'SELECT purge_after, deleted_at FROM blob WHERE org_id = ? AND sha256 = ?',
      params: [a.orgId, sha],
    })
  )[0];
}

function harness() {
  const repo = createBlobRepository(executor);
  const remove = vi.fn<ByteStore['remove']>(async () => undefined);
  const observability = { counter: vi.fn(), histogram: vi.fn(), log: vi.fn() };
  const lifecycle = createBlobLifecycle({
    metadata: repo,
    store: { remove } as unknown as ByteStore,
    observability,
    deleteTimeoutMs: 1000,
    leaseMs: 900_000,
  });
  const reader = createBlobReferenceReader(executor);
  const enqueue = vi.fn(async () => ({ id: 'j', created: true }));
  const job = (org: OrgContext = a) =>
    ({
      org,
      jobId: 'j1',
      idempotencyKey: 'schedule:tick',
      attempt: 1,
      fence: 1,
      signal: new AbortController().signal,
      ports: { clock: { now: () => new Date() }, platform: { jobs: { enqueue } } },
      observability,
    }) as unknown as JobContext;
  const scan = createRetentionScanJob({ reader, lifecycle });
  const purge = createBlobPurgeJob({ lifecycle });
  return {
    repo,
    remove,
    lifecycle,
    enqueue,
    runScan: async () => scan.handler(scan.validate({}), job()),
    runPurge: async () => purge.handler(purge.validate({}), job()),
  };
}

async function publish(repo: ReturnType<typeof harness>['repo'], sha = D1, org = a) {
  const generation = await repo.reserve(org, sha);
  await repo.publish(org, {
    sha256: sha,
    size: 10,
    mediaType: 'application/zip',
    refetchable: true,
    generation,
  });
}

async function age(sha: Sha256, days: number): Promise<void> {
  await exec(
    `UPDATE blob SET published_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-${String(days)} days') WHERE sha256 = ?`,
    sha,
  );
}

async function reference(
  status: 'active' | 'tombstoned',
  sha = D1,
  overrideDays: number | null = null,
): Promise<void> {
  await exec(
    "INSERT INTO source (id, org_id, name, ecosystem, type, retention_days_override) VALUES ('S', ?, 's', 'npm', 'npmjs_proxy', ?)",
    a.orgId,
    overrideDays,
  );
  await exec(
    "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('P', ?, 'S', 'npm', 'p')",
    a.orgId,
  );
  await exec(
    "INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json, blob_id, status, tombstoned_at) SELECT 'V', org_id, 'P', '1.0.0', '1.0.0', created_at, 'upstream', '{}', id, ?, ? FROM blob WHERE org_id = ? AND sha256 = ?",
    status,
    status === 'tombstoned' ? '2000-01-01T00:00:00.000Z' : null,
    a.orgId,
    sha,
  );
}

async function deadlineDays(sha = D1): Promise<number> {
  const found = await rowOf(sha);
  return (Date.parse(found?.purge_after ?? '') - Date.now()) / DAY;
}

async function pastDeadline(): Promise<void> {
  await exec(
    "UPDATE blob SET purge_after = strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 days') WHERE purge_after IS NOT NULL",
  );
}

describe('scan, schedule, deadline, claim and removal', () => {
  it('clears an existing schedule once and does not reschedule a reference missing its release stamp', async () => {
    const h = harness();
    await publish(h.repo);
    await reference('tombstoned');
    await exec(
      "UPDATE package SET status = 'removed_upstream', removed_upstream_at = NULL WHERE org_id = ?",
      a.orgId,
    );
    await exec(
      "UPDATE blob SET purge_after = '2999-01-01T00:00:00.000Z' WHERE org_id = ? AND sha256 = ?",
      a.orgId,
      D1,
    );
    const softDelete = vi.spyOn(h.lifecycle, 'softDelete');
    const unschedule = vi.spyOn(h.lifecycle, 'unschedule');
    await h.runScan();
    await h.runScan();
    expect(softDelete).not.toHaveBeenCalled();
    expect(unschedule).toHaveBeenCalledExactlyOnceWith(a, D1);
    expect((await rowOf(D1))?.purge_after).toBeNull();
    expect(h.remove).not.toHaveBeenCalled();
  });

  it('keeps a removed-upstream blob for the retention, then removes it after the deadline', async () => {
    const h = harness();
    await publish(h.repo);
    await age(D1, 30);
    await reference('tombstoned');
    await h.runScan();
    expect(await deadlineDays()).toBeGreaterThan(364.9);
    await h.runPurge();
    expect(h.remove).not.toHaveBeenCalled();
    expect((await rowOf(D1))?.deleted_at).toBeNull();

    await pastDeadline();
    await h.runPurge();
    expect(h.remove).toHaveBeenCalledExactlyOnceWith(blobStorageKey(a.orgId, D1));
    expect((await rowOf(D1))?.deleted_at).not.toBeNull();
  });

  it('removes an unreferenced refetchable blob past grace in the scan pass', async () => {
    const h = harness();
    await publish(h.repo);
    await age(D1, 8);
    await h.runScan();
    expect(h.remove).toHaveBeenCalledExactlyOnceWith(blobStorageKey(a.orgId, D1));
    expect((await rowOf(D1))?.deleted_at).not.toBeNull();
  });

  it('keeps an unreferenced blob that is inside the grace period', async () => {
    const h = harness();
    await publish(h.repo);
    await age(D1, 3);
    await h.runScan();
    await h.runPurge();
    expect(h.remove).not.toHaveBeenCalled();
    expect((await rowOf(D1))?.purge_after).toBeNull();
  });

  it('honours a longer source override and never shortens below the organization value', async () => {
    const h = harness();
    await publish(h.repo);
    await age(D1, 30);
    await reference('tombstoned', D1, 500);
    await h.runScan();
    expect(await deadlineDays()).toBeGreaterThan(499.9);
  });

  it('does not let a shorter source override shorten the deadline', async () => {
    const h = harness();
    await publish(h.repo);
    await age(D1, 30);
    await reference('tombstoned', D1, 10);
    await h.runScan();
    expect(await deadlineDays()).toBeGreaterThan(364.9);
  });
});

describe('a version reactivated after scheduling', () => {
  async function reactivate(): Promise<void> {
    await exec("UPDATE version SET status = 'active', tombstoned_at = NULL WHERE id = 'V'");
  }

  it('keeps its bytes when the deadline has passed, and the next scan clears the schedule', async () => {
    const h = harness();
    await publish(h.repo);
    await age(D1, 30);
    await reference('tombstoned');
    await h.runScan();
    await reactivate();
    await pastDeadline();
    await h.runPurge();
    expect(h.remove).not.toHaveBeenCalled();
    expect((await rowOf(D1))?.deleted_at).toBeNull();

    await h.runScan();
    expect((await rowOf(D1))?.purge_after).toBeNull();
  });

  it('is not purged when an active reference is attached between scheduling and the scan', async () => {
    const h = harness();
    await publish(h.repo);
    await age(D1, 8);
    expect(await h.lifecycle.scheduleOrphan(a, D1)).toBe(true);
    await reference('active');
    await h.runScan();
    await h.runPurge();
    expect(h.remove).not.toHaveBeenCalled();
    expect((await rowOf(D1))?.purge_after).toBeNull();
  });
});

describe('a tombstoned reference attached to an orphan-scheduled blob', () => {
  async function attach(tombstonedDaysAgo: number): Promise<void> {
    await reference('tombstoned');
    await exec(
      `UPDATE version SET tombstoned_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-${String(tombstonedDaysAgo)} days')`,
    );
  }

  async function scheduled() {
    const h = harness();
    await publish(h.repo);
    await age(D1, 8);
    expect(await h.lifecycle.scheduleOrphan(a, D1)).toBe(true);
    return h;
  }

  it('is not purged before the release time plus the retention', async () => {
    const h = await scheduled();
    await attach(0);
    await h.runPurge();
    expect(h.remove).not.toHaveBeenCalled();
    expect((await rowOf(D1))?.deleted_at).toBeNull();
  });

  it('has its schedule cleared by the sweep and is rescheduled with the full retention', async () => {
    const h = await scheduled();
    await attach(0);
    await h.runScan();
    expect((await rowOf(D1))?.purge_after).toBeNull();
    await h.runScan();
    await h.runPurge();
    expect(h.remove).not.toHaveBeenCalled();
    expect(await deadlineDays()).toBeGreaterThan(364.9);
  });

  it('is purged once the retention has passed', async () => {
    const h = await scheduled();
    await attach(366);
    await h.runPurge();
    expect(h.remove).toHaveBeenCalledExactlyOnceWith(blobStorageKey(a.orgId, D1));
    expect((await rowOf(D1))?.deleted_at).not.toBeNull();
  });
});

describe('organization scope', () => {
  it('never touches another organization blob', async () => {
    const h = harness();
    await publish(h.repo, D2, b);
    await exec("UPDATE blob SET published_at = '2000-01-01T00:00:00.000Z'");
    await h.runScan();
    await h.runPurge();
    expect(h.remove).not.toHaveBeenCalled();
    const [foreign] = await executor.all<{ purge_after: string | null; deleted_at: string | null }>(
      { sql: 'SELECT purge_after, deleted_at FROM blob WHERE org_id = ?', params: [b.orgId] },
    );
    expect(foreign).toEqual({ purge_after: null, deleted_at: null });
  });
});

describe('source poll', () => {
  const clock = fixedClock(new Date().toISOString());
  async function source(id: string, org: OrgContext, nextPollAt: string, status = 'active') {
    await exec(
      'INSERT INTO source (id, org_id, name, ecosystem, type, status, next_poll_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      org.orgId,
      id,
      'npm',
      'npmjs_proxy',
      status,
      nextPollAt,
    );
  }

  function dedupingJobs() {
    const seen = new Set<string>();
    const created: unknown[] = [];
    const jobs: Pick<Jobs, 'enqueue'> = {
      async enqueue(_ctx, type, payload, input) {
        const fresh = !seen.has(`${type}:${input.idempotencyKey}`);
        seen.add(`${type}:${input.idempotencyKey}`);
        if (fresh) created.push(payload);
        return { id: input.idempotencyKey, created: fresh };
      },
    };
    return { jobs, created };
  }

  it('enqueues one sync per due source over two ticks in the same minute', async () => {
    await source('s1', a, '2020-01-01T00:00:00.000Z');
    await source('s2', a, '2020-01-01T00:00:00.000Z');
    await source('s3', a, '2999-01-01T00:00:00.000Z');
    await source('s4', a, '2020-01-01T00:00:00.000Z', 'paused');
    await source('s5', b, '2020-01-01T00:00:00.000Z');
    const { jobs, created } = dedupingJobs();
    const poll = createSourcePollJob({ sources: createSourceRepository(executor) });
    const tick = () =>
      poll.handler(poll.validate({}), {
        org: a,
        signal: new AbortController().signal,
        ports: { clock, platform: { jobs } },
      } as unknown as JobContext);
    await tick();
    await tick();
    expect(created).toEqual([
      { sourceId: 's1', reason: 'poll' },
      { sourceId: 's2', reason: 'poll' },
    ]);
  });

  async function nextPollAt(id: string): Promise<string | null> {
    return (
      (
        await executor.all<{ next_poll_at: string | null }>({
          sql: 'SELECT next_poll_at FROM source WHERE id = ?',
          params: [id],
        })
      )[0]?.next_poll_at ?? null
    );
  }

  it.each(['rejects', 'skips'] as const)(
    'dedupes the second tick through SQLite when the first deferPoll %s',
    async (failure) => {
      const original = '2020-01-01T00:00:00.000Z';
      await source('s1', a, original);
      const sources = createSourceRepository(executor);
      const defer = vi.spyOn(sources, 'deferPoll');
      if (failure === 'rejects') defer.mockRejectedValueOnce(new Error('down'));
      else defer.mockResolvedValueOnce(false);
      const jobs = createRepositoryJobs({
        store: createJobRepository(executor),
        jobs: [
          registerCoreJob({
            ...sourceSyncJob,
            handler: (input, job) => sourceSyncJob.handler(sourceSyncJob.validate(input), job),
          }),
        ],
        clock,
        ids: { ulid },
      })('core', { projectId: null, tokenId: null });
      const enqueue = vi.fn(jobs.enqueue);
      const poll = createSourcePollJob({ sources });
      const tick = () =>
        poll.handler(poll.validate({}), {
          org: a,
          signal: new AbortController().signal,
          ports: { clock, platform: { jobs: { ...jobs, enqueue } } },
          observability: { counter: vi.fn(), histogram: vi.fn(), log: vi.fn() },
        } as unknown as JobContext);

      await tick();
      expect(await nextPollAt('s1')).toBe(original);
      await tick();
      expect(enqueue).toHaveBeenCalledTimes(2);
      const first = await enqueue.mock.results[0]?.value;
      expect(first).toEqual({ id: expect.any(String), created: true });
      expect(await enqueue.mock.results[1]?.value).toEqual({ id: first?.id, created: false });
      expect(await nextPollAt('s1')).not.toBe(original);
      expect(
        await executor.all({
          sql: 'SELECT type, payload_json FROM job WHERE org_id = ?',
          params: [a.orgId],
        }),
      ).toEqual([
        { type: 'core:source-sync:v1', payload_json: '{"reason":"poll","sourceId":"s1"}' },
      ]);
    },
  );

  it('defers a source by its interval only while next_poll_at is unchanged, in its own organization', async () => {
    await source('s1', a, '2020-01-01T00:00:00.000Z');
    await source('s5', b, '2020-01-01T00:00:00.000Z');
    await exec('UPDATE source SET poll_interval_seconds = 3600');
    const sources = createSourceRepository(executor);
    expect(await sources.deferPoll(a, 's5', '2020-01-01T00:00:00.000Z')).toBe(false);
    expect(await nextPollAt('s5')).toBe('2020-01-01T00:00:00.000Z');
    expect(await sources.deferPoll(a, 's1', '2019-01-01T00:00:00.000Z')).toBe(false);
    expect(await sources.deferPoll(a, 's1', '2020-01-01T00:00:00.000Z')).toBe(true);
    const next = Date.parse((await nextPollAt('s1')) ?? '');
    expect(next - Date.now()).toBeGreaterThan(3_590_000);
    expect(next - Date.now()).toBeLessThan(3_610_000);
    expect(await sources.deferPoll(a, 's1', '2020-01-01T00:00:00.000Z')).toBe(false);
  });

  it('does not defer a paused source', async () => {
    await source('s1', a, '2020-01-01T00:00:00.000Z', 'paused');
    expect(
      await createSourceRepository(executor).deferPoll(a, 's1', '2020-01-01T00:00:00.000Z'),
    ).toBe(false);
  });

  it('reaches every source over successive ticks when no sync ever advances next_poll_at', async () => {
    for (let n = 0; n < 60; n += 1) {
      await source(
        `s${String(n).padStart(2, '0')}`,
        a,
        `2020-01-01T00:00:${String(n).padStart(2, '0')}.000Z`,
      );
    }
    const { jobs, created } = dedupingJobs();
    const poll = createSourcePollJob({ sources: createSourceRepository(executor) });
    const tick = () =>
      poll.handler(poll.validate({}), {
        org: a,
        signal: new AbortController().signal,
        ports: { clock, platform: { jobs } },
      } as unknown as JobContext);
    for (let round = 0; round < 3; round += 1) await tick();
    expect(new Set(created.map((payload) => (payload as { sourceId: string }).sourceId)).size).toBe(
      60,
    );
    expect(created).toHaveLength(60);
  });
});
