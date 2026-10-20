import { describe, expect, it, vi } from 'vitest';
import { fenceKind, type DelegatedMutationFence } from '@package-broker/core/authz/fence';
import type { OrgContext, SqlValue, Statement } from '@package-broker/core/db/port';
import type { ImportApplyStore } from '@package-broker/core/import/apply';
import type { ImportRollbackStore } from '@package-broker/core/import/rollback';
import { IMPORT_RUN_JOB } from '@package-broker/core/import/run-service';
import { systemClock, ulid } from '@package-broker/core/ids';
import type { PluginPorts } from '@package-broker/core/plugin';
import type { PlatformPortConfig } from '@package-broker/core/platform/port-config';
import type { JobClaim } from '@package-broker/core/platform/job-repository';
import { seedTwoOrganizations } from '@package-broker/db-sqlite/contract/two-organizations';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { createJobRepository } from '@package-broker/db-sqlite/repositories/job';
import { discoveredMigrations } from '@package-broker/db-sqlite/testing/migrated-database';
import { openNodeSqliteExecutor } from '@package-broker/db-sqlite/testing/node-sqlite-executor';
import type { R2BucketLike } from './blob/r2.js';
import {
  createD1Executor,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
} from './db/d1-executor.js';
import { createWorker, type Env } from './index.js';
import { createImportJobHolder, importJobRegistrations } from './import-jobs.js';
import { createQueueHandler, jobNotification } from './jobs/consumer.js';

const org = { orgId: '01J00000000000000000000A0A' } as OrgContext;
const APPROVER = ulid();
const REQUESTER = ulid();
const platformPorts: PlatformPortConfig = {
  blob: { adapter: 'r2', binding: 'STORAGE', maxBytes: 1024 },
  cache: { adapter: 'cache-api', namespace: 'import-test' },
  jobs: { adapter: 'queues', binding: 'JOBS', maxRunning: 2 },
  observability: { adapter: 'workers', deploymentIdEnv: 'DEPLOYMENT_ID' },
};
const ports: PluginPorts = {
  organizations: { get: () => Promise.resolve(null) } as unknown as PluginPorts['organizations'],
  clock: systemClock,
  ids: { ulid },
};
const observability = {
  log: () => undefined,
  counter: () => undefined,
  histogram: () => undefined,
};

function claimOf(type: string, payload: unknown, fence: number): JobClaim {
  return {
    id: ulid(),
    owner: ulid(),
    fence,
    type,
    payloadJson: JSON.stringify(payload),
    idempotencyKey: 'k',
    resourceKey: null,
    projectId: null,
    initiatorTokenId: null,
    attempt: 1,
    maxAttempts: 5,
    leaseUntil: new Date(Date.now() + 60_000).toISOString(),
  };
}

function stores() {
  const fences: { apply: DelegatedMutationFence[]; rollback: DelegatedMutationFence[] } = {
    apply: [],
    rollback: [],
  };
  const applyStore = {
    loadRun: async (_ctx: unknown, runId: string) => ({
      id: runId,
      state: 'applying',
      planHash: null,
      approvedAt: new Date().toISOString(),
      approvedByUserId: APPROVER,
      manifestBlobSha256: null,
    }),
    finish: async (_ctx: unknown, fence: DelegatedMutationFence) => {
      fences.apply.push(fence);
    },
  } as unknown as ImportApplyStore;
  const rollbackStore = {
    loadRun: async (_ctx: unknown, runId: string) => ({
      id: runId,
      state: 'applied',
      approvedByUserId: APPROVER,
    }),
    rollbackRefs: async () => [],
    finish: async (_ctx: unknown, fence: DelegatedMutationFence) => {
      fences.rollback.push(fence);
    },
  } as unknown as ImportRollbackStore;
  return { fences, applyStore, rollbackStore, blobs: { get: async () => null } };
}

async function deliver(
  holder: ReturnType<typeof createImportJobHolder>,
  claim: JobClaim,
): Promise<ReturnType<typeof vi.fn>> {
  const settle = vi.fn(() => Promise.resolve());
  const fail = () => Promise.reject(new Error('unexpected call'));
  const handle = createQueueHandler({
    repository: {
      enqueue: fail,
      status: fail,
      claim: () => Promise.resolve(claim),
      heartbeat: () => Promise.resolve(),
      settle,
      reap: fail,
    },
    jobs: { jobs: importJobRegistrations(holder) },
    observability,
    scope: () => ({ ports, observability }),
  });
  await handle(
    {
      messages: [
        {
          body: jobNotification(org, claim.id),
          ack: () => undefined,
          retry: () => undefined,
        },
      ],
    },
    {},
  );
  return settle;
}

describe('import job holder', () => {
  it('accepts exactly one set', () => {
    const holder = createImportJobHolder();
    const set = stores();
    holder.set(set);
    expect(() => holder.set(set)).toThrow();
  });

  it('registers both core job types under their queue names', () => {
    expect(importJobRegistrations(createImportJobHolder()).map((job) => job.qualifiedName)).toEqual(
      [IMPORT_RUN_JOB.apply, IMPORT_RUN_JOB.rollback],
    );
  });
});

describe('import jobs on the queue consumer', () => {
  it.each([
    [IMPORT_RUN_JOB.apply, { runId: ulid() }],
    [IMPORT_RUN_JOB.rollback, { runId: ulid(), requestedBy: REQUESTER }],
  ] as const)(
    'fails a %s claim made before the holder is set as a retryable handler_error',
    async (type, payload) => {
      const settle = await deliver(createImportJobHolder(), claimOf(type, payload, 1));
      expect(settle).toHaveBeenCalledWith(
        org,
        expect.anything(),
        expect.objectContaining({
          outcome: 'failed',
          errorCode: 'handler_error',
          permanent: false,
        }),
      );
    },
  );

  it('hands the claim fence to the apply and rollback stores once the holder is set', async () => {
    const holder = createImportJobHolder();
    const set = stores();
    holder.set(set);
    const runId = ulid();
    const apply = claimOf(IMPORT_RUN_JOB.apply, { runId }, 4);
    const rollback = claimOf(IMPORT_RUN_JOB.rollback, { runId, requestedBy: REQUESTER }, 9);
    for (const claim of [apply, rollback]) {
      expect(await deliver(holder, claim)).toHaveBeenCalledWith(org, expect.anything(), {
        outcome: 'succeeded',
      });
    }
    expect(set.fences.apply).toHaveLength(1);
    expect(set.fences.rollback).toHaveLength(1);
    expect(fenceKind(set.fences.apply[0]!)).toBe('delegated');
    expect(set.fences.apply[0]).toMatchObject({
      approverUserId: APPROVER,
      runId,
      job: { id: apply.id, owner: apply.owner, fence: 4 },
    });
    expect(set.fences.rollback[0]).toMatchObject({
      approverUserId: REQUESTER,
      runId,
      job: { id: rollback.id, owner: rollback.owner, fence: 9 },
    });
  });

  it('refuses a rollback payload without requestedBy as invalid_payload', async () => {
    const holder = createImportJobHolder();
    holder.set(stores());
    const settle = await deliver(holder, claimOf(IMPORT_RUN_JOB.rollback, { runId: ulid() }, 1));
    expect(settle).toHaveBeenCalledWith(
      org,
      expect.anything(),
      expect.objectContaining({ outcome: 'failed', errorCode: 'invalid_payload', permanent: true }),
    );
  });
});

async function localBinding() {
  const opened = openNodeSqliteExecutor(undefined, { d1PatternLimit: true });
  const statements = new WeakMap<D1PreparedStatementLike, Statement>();
  function prepare(statement: Statement): D1PreparedStatementLike {
    const bound: D1PreparedStatementLike = {
      bind: (...params) => prepare({ sql: statement.sql, params: params as SqlValue[] }),
      all: async () => ({ results: await opened.executor.all(statement) }),
    };
    statements.set(bound, statement);
    return bound;
  }
  const db: D1DatabaseLike = {
    prepare: (sql) => prepare({ sql, params: [] }),
    batch: async (batch) =>
      (await opened.executor.batch(batch.map((statement) => statements.get(statement)!))).map(
        (result) => ({ results: result.rows, meta: { changes: result.changes } }),
      ),
  };
  return { db, close: opened.close };
}

describe('import jobs in the Worker assembly', () => {
  it('registers both jobs with real stores and completes a claim for an unknown run', async () => {
    const { db, close } = await localBinding();
    try {
      const executor = createD1Executor(db);
      await migrate(executor, await discoveredMigrations(), { holder: 'import-jobs-test' });
      const { a } = await seedTwoOrganizations(executor);
      const worker = createWorker([], {
        platformPorts,
        console: { log: () => undefined, error: () => undefined },
        cacheStorage: {
          open: async () => ({
            match: async () => undefined,
            put: async () => undefined,
            delete: async () => false,
          }),
        },
      });
      const env: Env = {
        DB: db,
        STORAGE: {
          head: async () => null,
          get: async () => null,
          put: async () => null,
          delete: async () => undefined,
        } as unknown as R2BucketLike,
        JOBS: { send: async () => undefined, sendBatch: async () => undefined },
        DEPLOYMENT_ID: 'import-test',
        PB_MASTER_KEY: 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
        PB_PUBLIC_URL: 'https://broker.test',
      };
      expect((await worker.fetch(new Request('https://broker.test/health/live'), env)).status).toBe(
        200,
      );
      const repository = createJobRepository(executor);
      const enqueue = (type: string, payload: unknown) =>
        repository.enqueue(a, {
          id: ulid(),
          type,
          payloadJson: JSON.stringify(payload),
          idempotencyKey: crypto.randomUUID(),
          maxAttempts: 2,
          resourceKey: null,
          projectId: null,
          initiatorTokenId: null,
          runAt: new Date().toISOString(),
        });
      for (const [type, payload] of [
        [IMPORT_RUN_JOB.apply, { runId: ulid() }],
        [IMPORT_RUN_JOB.rollback, { runId: ulid(), requestedBy: REQUESTER }],
      ] as const) {
        const job = await enqueue(type, payload);
        const ack = vi.fn();
        const retry = vi.fn();
        await worker.queue(
          { messages: [{ body: { v: 1, org: a.orgId, job: job.id }, ack, retry }] },
          env,
        );
        expect(retry).not.toHaveBeenCalled();
        expect(await repository.status(a, job.id)).toMatchObject({ state: 'succeeded' });
      }
    } finally {
      await close();
    }
  }, 60_000);
});
