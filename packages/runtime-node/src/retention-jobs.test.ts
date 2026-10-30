import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import type { Kernel } from '@package-broker/core/kernel/kernel';
import {
  BlobBusyError,
  blobStorageKey,
  type ByteStore,
  type Sha256,
} from '@package-broker/core/platform/blob';
import { jobFences } from '@package-broker/core/platform/job-fences';
import { createBlobRepository } from '@package-broker/db-sqlite/repositories/blob';
import { createJobRepository } from '@package-broker/db-sqlite/repositories/job';
import { openMigratedDatabase } from '@package-broker/db-sqlite/testing/migrated-database';
import { createNodeServer } from './index.js';

const SHA = 'a'.repeat(64) as Sha256;
const OTHER = 'b'.repeat(64) as Sha256;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function gate(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const CANCEL_PURGE = /set "purge_after" = \?, "purge_lease_until" = \?/i;

async function boot({ deleteTimeoutMs = 30_000 } = {}) {
  const database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
  cleanup.push(() => database.close());
  const raw = database.executor;
  const { a, b } = database.orgs!;
  let beforeBatch: ((statements: readonly Statement[]) => Promise<void>) | undefined;
  let afterBatch: ((statements: readonly Statement[]) => Promise<void>) | undefined;
  let afterRead: ((statement: Statement) => Promise<void>) | undefined;
  const writes: string[] = [];
  const executor: SqlExecutor = {
    driver: raw.driver,
    async all<R>(statement: Statement) {
      const rows = await raw.all<R>(statement);
      await afterRead?.(statement);
      return rows;
    },
    async batch(statements) {
      writes.push(...statements.map((s) => s.sql));
      await beforeBatch?.(statements);
      const results = await raw.batch(statements);
      await afterBatch?.(statements);
      return results;
    },
  };
  const bytes = new Map<string, Uint8Array>();
  const remove = vi.fn<ByteStore['remove']>(async (key) => {
    bytes.delete(key);
  });
  const retentionBytes: ByteStore = {
    async putStaged() {
      throw new Error('not_implemented');
    },
    async openStaged() {
      throw new Error('not_implemented');
    },
    async promote() {
      throw new Error('not_implemented');
    },
    async discardStaged() {
      throw new Error('not_implemented');
    },
    async listStaged() {
      return [];
    },
    remove,
    head: async () => null,
    get: async () => null,
    putVerified: async () => {
      throw new Error('unused');
    },
  };
  const platformServices = {
    retention: { store: retentionBytes, deleteTimeoutMs, leaseMs: 900_000 },
    jobStore: createJobRepository(executor),
    blob: {
      async stage() {
        throw new Error('not_implemented');
      },
      async openStaged() {
        throw new Error('not_implemented');
      },
      async promote() {
        throw new Error('not_implemented');
      },
      async discard() {
        throw new Error('not_implemented');
      },
      head: async () => null,
      get: async () => null,
      put: async () => {
        throw new Error('unused');
      },
    },
    cache: { get: async () => null, set: async () => undefined, delete: async () => undefined },
  };
  const records: unknown[] = [];
  const broker = createNodeServer([], {
    executor,
    platformServices,
    observability: {
      deploymentId: 'retention-test',
      sink: { emit: (record) => records.push(record) },
    },
  });
  cleanup.push(() => broker.close());
  const kernel: Kernel = await broker.ready();
  const jobs = createJobRepository(executor);
  const exec = async (sql: string, ...params: Statement['params']) => {
    await raw.batch([{ sql, params }]);
  };
  const publish = async (org = a, sha = SHA, days = 8) => {
    const repo = createBlobRepository(raw);
    const generation = await repo.reserve(org, sha);
    const published = await repo.publish(org, {
      sha256: sha,
      size: 1,
      mediaType: 'application/zip',
      refetchable: true,
      generation,
    });
    expect(published).not.toBeNull();
    bytes.set(blobStorageKey(org.orgId, sha), new Uint8Array([1]));
    await exec(
      "UPDATE blob SET published_at = strftime('%Y-%m-%dT%H:%M:%fZ','now', ?) WHERE org_id = ? AND sha256 = ?",
      `-${days} days`,
      org.orgId,
      sha,
    );
  };
  const released = async (days = 400) => {
    await publish();
    await exec(
      "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('S', ?, 's', 'npm', 'npmjs_proxy')",
      a.orgId,
    );
    await exec(
      "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('P', ?, 'S', 'npm', 'p')",
      a.orgId,
    );
    await exec(
      "INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json, blob_id, status, tombstoned_at) SELECT 'V', org_id, 'P', '1.0.0', '1.0.0', created_at, 'upstream', '{}', id, 'tombstoned', strftime('%Y-%m-%dT%H:%M:%fZ','now', ?) FROM blob WHERE org_id = ? AND sha256 = ?",
      `-${days} days`,
      a.orgId,
      SHA,
    );
  };
  const due = () =>
    exec(
      "UPDATE blob SET purge_after = strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 days') WHERE org_id = ? AND sha256 = ?",
      a.orgId,
      SHA,
    );
  const rows = (org: OrgContext = a) =>
    raw.all({ sql: 'SELECT * FROM blob WHERE org_id = ? ORDER BY sha256', params: [org.orgId] });
  const claim = async (name: 'retention-scan' | 'blob-purge') => {
    const type = `core:${name}:v1`;
    const job = kernel.registration.jobs.find((job) => job.qualifiedName === type);
    expect(job, `${type} is registered`).toBeDefined();
    const { id } = await jobs.enqueue(a, {
      id: ulid(),
      type,
      payloadJson: '{}',
      idempotencyKey: ulid(),
      maxAttempts: 2,
      resourceKey: null,
      projectId: null,
      initiatorTokenId: null,
      runAt: null,
    });
    const claimed = await jobs.claim(a, ulid(), {
      id,
      types: [type],
      leaseSeconds: 60,
      maxRunning: 10,
    });
    expect(claimed).not.toBeNull();
    const context = {
      ...kernel.jobScope(job!, { jobId: id, attempt: claimed!.attempt }),
      org: a,
      jobId: id,
      idempotencyKey: claimed!.idempotencyKey,
      attempt: claimed!.attempt,
      fence: claimed!.fence,
      signal: new AbortController().signal,
      fences: jobFences(claimed!),
    };
    return {
      id,
      run: () => job!.definition.handler(job!.definition.validate({}), context),
      lose: () => exec('UPDATE job SET fence = fence + 1 WHERE org_id = ? AND id = ?', a.orgId, id),
    };
  };
  return {
    a,
    b,
    kernel,
    remove,
    bytes,
    publish,
    released,
    due,
    rows,
    claim,
    exec,
    records,
    retentionBytes,
    cancels: () => writes.filter((sql) => CANCEL_PURGE.test(sql)).length,
    beforeBatch: (hook: typeof beforeBatch) => {
      beforeBatch = hook;
    },
    afterBatch: (hook: typeof afterBatch) => {
      afterBatch = hook;
    },
    afterRead: (hook: typeof afterRead) => {
      afterRead = hook;
    },
  };
}

const fast = () => boot({ deleteTimeoutMs: 1000 });

describe('Node retention jobs', () => {
  it('registers daily scan and hourly purge, excluding the deferred source poll', async () => {
    const h = await boot();
    expect(
      h.kernel.registration.jobs
        .filter((job) => /retention-scan|blob-purge/.test(job.qualifiedName))
        .map((job) => [job.qualifiedName, job.definition.schedule]),
    ).toEqual([
      ['core:retention-scan:v1', { everySeconds: 86400 }],
      ['core:blob-purge:v1', { everySeconds: 3600 }],
    ]);
    expect(
      h.kernel.registration.jobs.some((job) => job.qualifiedName.includes('source-poll')),
    ).toBe(false);
  });

  it('claims a scan and removes only the old orphan in its organization in the same pass', async () => {
    const h = await boot();
    await h.publish();
    await h.publish(h.a, OTHER, 1);
    await h.publish(h.b);
    const foreign = await h.rows(h.b);
    await (await h.claim('retention-scan')).run();
    expect(h.remove.mock.calls).toEqual([
      [`npm-publish/${blobStorageKey(h.a.orgId, SHA)}`],
      [blobStorageKey(h.a.orgId, SHA)],
    ]);
    expect((await h.rows())[0]).toMatchObject({ deleted_at: expect.any(String) });
    expect((await h.rows())[1]).toMatchObject({ deleted_at: null, purge_after: null });
    expect(await h.rows(h.b)).toEqual(foreign);
  });

  it('schedules released content and a claimed purge keeps it until its deadline', async () => {
    const h = await boot();
    await h.released(1);
    await (await h.claim('retention-scan')).run();
    const [row] = await h.rows();
    expect(Date.parse(row!.purge_after as string)).toBeGreaterThan(Date.now() + 364 * 86400000);
    await (await h.claim('blob-purge')).run();
    expect(h.remove).not.toHaveBeenCalled();
  });

  it('claims a due purge and removes bytes through the runtime store', async () => {
    const h = await boot();
    await h.released();
    await h.due();
    await (await h.claim('blob-purge')).run();
    expect(h.remove.mock.calls).toEqual([
      [`npm-publish/${blobStorageKey(h.a.orgId, SHA)}`],
      [blobStorageKey(h.a.orgId, SHA)],
    ]);
    expect((await h.rows())[0]).toMatchObject({ deleted_at: expect.any(String) });
  });

  it('unschedules a premature deadline without removing bytes', async () => {
    const h = await boot();
    await h.released(1);
    await h.due();
    await (await h.claim('blob-purge')).run();
    expect(h.remove).not.toHaveBeenCalled();
    await (await h.claim('retention-scan')).run();
    expect((await h.rows())[0]).toMatchObject({ deleted_at: null, purge_after: null });
  });

  it('rechecks premature purge after the claim when a release timestamp changes', async () => {
    const h = await boot();
    await h.released();
    await h.due();
    h.afterBatch(async (statements) => {
      if (!statements.some((s) => /RETURNING purge_generation/i.test(s.sql))) return;
      h.afterBatch(undefined);
      await h.exec(
        "UPDATE version SET tombstoned_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE org_id = ? AND id = 'V'",
        h.a.orgId,
      );
    });
    await (await h.claim('blob-purge')).run();
    expect(h.remove).not.toHaveBeenCalled();
    expect((await h.rows())[0]).toMatchObject({ deleted_at: null, purge_lease_until: null });
  });

  it.each(['retention-scan', 'blob-purge'] as const)(
    'atomically refuses every metadata write with a bumped fence: %s',
    async (name) => {
      const h = await boot();
      await h.publish();
      if (name === 'blob-purge') await h.due();
      const claimed = await h.claim(name);
      const before = await h.rows();
      h.beforeBatch(async (statements) => {
        if (!statements.some((s) => /UPDATE ["`]?blob/i.test(s.sql))) return;
        h.beforeBatch(undefined);
        await claimed.lose();
      });
      await expect(claimed.run()).rejects.toThrow();
      expect(await h.rows()).toEqual(before);
      expect(h.remove).not.toHaveBeenCalled();
    },
  );

  it('checks the job lease again immediately before byte removal', async () => {
    const h = await boot();
    await h.publish();
    await h.due();
    const claimed = await h.claim('blob-purge');
    h.afterRead(async (statement) => {
      if (!/purge_generation/.test(statement.sql) || !/select/i.test(statement.sql)) return;
      h.afterRead(undefined);
      await claimed.lose();
    });
    await expect(claimed.run()).rejects.toThrow();
    expect(h.remove).not.toHaveBeenCalled();
    expect((await h.rows())[0]).toMatchObject({ deleted_at: null });
  });

  it('keeps the purge lease when byte removal stalls past the timeout, so a republish cannot touch the bytes', async () => {
    const h = await fast();
    await h.publish();
    await h.due();
    const key = blobStorageKey(h.a.orgId, SHA);
    const original = h.bytes.get(key);
    const started = gate();
    const stalled = gate();
    h.remove.mockImplementationOnce(async (storageKey) => {
      started.resolve();
      await stalled.promise;
      h.bytes.delete(storageKey);
    });
    try {
      await (await h.claim('blob-purge')).run();
      await started.promise;
      const [leased] = await h.rows();
      expect(leased).toMatchObject({
        deleted_at: null,
        purge_after: expect.any(String),
        purge_lease_until: expect.any(String),
      });
      expect(h.cancels()).toBe(0);
      await expect(h.publish()).rejects.toThrow(BlobBusyError);
      expect(h.bytes.get(key)).toBe(original);

      stalled.resolve();
      await h.remove.mock.results[0]!.value;
      expect(await h.rows()).toEqual([leased]);
      expect(h.cancels()).toBe(0);

      await h.exec(
        "UPDATE blob SET purge_lease_until = strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 seconds') WHERE org_id = ? AND sha256 = ?",
        h.a.orgId,
        SHA,
      );
      await (await h.claim('blob-purge')).run();
      expect((await h.rows())[0]).toMatchObject({ deleted_at: expect.any(String) });
      await h.publish();
      expect(h.bytes.get(key)).toEqual(new Uint8Array([1]));
      expect((await h.rows())[0]).toMatchObject({ deleted_at: null, purge_lease_until: null });
    } finally {
      stalled.resolve();
    }
  }, 45_000);

  it('keeps the purge lease when the byte store throws', async () => {
    const h = await boot();
    await h.publish();
    await h.due();
    const key = blobStorageKey(h.a.orgId, SHA);
    const original = h.bytes.get(key);
    h.remove.mockRejectedValueOnce(new Error('storage down'));
    await (await h.claim('blob-purge')).run();
    expect(h.remove).toHaveBeenCalledOnce();
    expect(h.cancels()).toBe(0);
    expect((await h.rows())[0]).toMatchObject({
      deleted_at: null,
      purge_lease_until: expect.any(String),
    });
    await expect(h.publish()).rejects.toThrow(BlobBusyError);
    expect(h.bytes.get(key)).toBe(original);
  });

  it('leaves a short purge lease to expire without removing or cancelling', async () => {
    const h = await boot();
    await h.publish();
    await h.due();
    h.afterBatch(async (statements) => {
      if (!statements.some((s) => /RETURNING purge_generation/i.test(s.sql))) return;
      h.afterBatch(undefined);
      await h.exec(
        "UPDATE blob SET purge_lease_until = strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 seconds') WHERE org_id = ? AND sha256 = ?",
        h.a.orgId,
        SHA,
      );
    });
    await (await h.claim('blob-purge')).run();
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.cancels()).toBe(0);
    expect((await h.rows())[0]).toMatchObject({
      deleted_at: null,
      purge_after: expect.any(String),
      purge_lease_until: expect.any(String),
    });
  });

  it('cancels the purge of a row that gained an active reference after the claim', async () => {
    const h = await boot();
    await h.publish();
    await h.due();
    h.afterBatch(async (statements) => {
      if (!statements.some((s) => /RETURNING purge_generation/i.test(s.sql))) return;
      h.afterBatch(undefined);
      await h.exec(
        "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('S', ?, 's', 'npm', 'npmjs_proxy')",
        h.a.orgId,
      );
      await h.exec(
        "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('P', ?, 'S', 'npm', 'p')",
        h.a.orgId,
      );
      await h.exec(
        "INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json, blob_id, status) SELECT 'V', org_id, 'P', '1.0.0', '1.0.0', created_at, 'upstream', '{}', id, 'active' FROM blob WHERE org_id = ? AND sha256 = ?",
        h.a.orgId,
        SHA,
      );
    });
    await (await h.claim('blob-purge')).run();
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.cancels()).toBe(1);
    expect((await h.rows())[0]).toMatchObject({
      deleted_at: null,
      purge_after: null,
      purge_lease_until: null,
    });
    expect(h.bytes.get(blobStorageKey(h.a.orgId, SHA))).toEqual(new Uint8Array([1]));
  });

  it('a cancel with a stale generation leaves the newer lease alone', async () => {
    const h = await boot();
    await h.publish();
    await h.due();
    const newer = 'e'.repeat(32);
    h.afterBatch(async (statements) => {
      if (!statements.some((s) => /RETURNING purge_generation/i.test(s.sql))) return;
      h.afterBatch(undefined);
      await h.exec(
        'UPDATE blob SET purge_generation = ? WHERE org_id = ? AND sha256 = ?',
        newer,
        h.a.orgId,
        SHA,
      );
    });
    await (await h.claim('blob-purge')).run();
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.cancels()).toBe(1);
    expect((await h.rows())[0]).toMatchObject({
      deleted_at: null,
      purge_generation: newer,
      purge_after: expect.any(String),
      purge_lease_until: expect.any(String),
    });
  });

  it('keeps the lease and never removes when the job lease response arrives after the lifecycle timeout', async () => {
    const h = await fast();
    await h.publish();
    await h.due();
    const claimed = await h.claim('blob-purge');
    const key = blobStorageKey(h.a.orgId, SHA);
    const original = h.bytes.get(key);
    const checkingLease = gate();
    const releaseLease = gate();
    h.afterBatch(async (statements) => {
      if (statements.length === 1 && /access_mutation_guard/.test(statements[0]!.sql)) {
        checkingLease.resolve();
        await releaseLease.promise;
      }
    });
    const running = claimed.run();
    try {
      await checkingLease.promise;
      await running;
      expect(h.cancels()).toBe(0);
      const [leased] = await h.rows();
      expect(leased).toMatchObject({ deleted_at: null, purge_lease_until: expect.any(String) });
      await expect(h.publish()).rejects.toThrow(BlobBusyError);
      releaseLease.resolve();
      // Drain the released response and the removal continuation before inspecting bytes.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(h.remove).not.toHaveBeenCalled();
      expect(h.bytes.get(key)).toBe(original);
      expect(await h.rows()).toEqual([leased]);
    } finally {
      releaseLease.resolve();
      await running;
      h.afterBatch(undefined);
    }
  }, 45_000);
});

it('Round 4 real Node observability emits a staged sweep failure', async () => {
  const h = await fast();
  h.retentionBytes.listStaged = async () => {
    throw new Error('listing failed');
  };
  await (await h.claim('blob-purge')).run();
  expect(h.records).toContainEqual({
    kind: 'log',
    record: expect.objectContaining({ level: 'warn', event: 'staged_blob_sweep_failed' }),
  });
});
