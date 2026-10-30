import { afterEach, describe, expect, it, vi } from 'vitest';
import { fenceKind, type DelegatedMutationFence } from '@package-broker/core/authz/fence';
import { orgContext, type SqlExecutor } from '@package-broker/core/db/port';
import type { ImportApplyStore } from '@package-broker/core/import/apply';
import type { ImportRollbackStore } from '@package-broker/core/import/rollback';
import { IMPORT_RUN_JOB, IMPORT_VERIFICATION_JOB } from '@package-broker/core/import/run-service';
import { systemClock, ulid } from '@package-broker/core/ids';
import type { PluginPorts } from '@package-broker/core/plugin';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { parseMasterKey } from '@package-broker/core/secrets/master-key';
import { createJobRepository } from '@package-broker/db-sqlite/repositories/job';
import { openMigratedDatabase } from '@package-broker/db-sqlite/testing/migrated-database';
import { createNodeServer } from './index.js';
import { createImportJobHolder, importJobRegistrations } from './import-jobs.js';
import { createJobLoop, type JobLoop } from './jobs/loop.js';

const ORG = orgContext('01J0000000000000000000ORG1');
const KEY = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const APPROVER = ulid();
const REQUESTER = ulid();
const WAIT = { timeout: 15_000, interval: 50 };

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function database() {
  const opened = await openMigratedDatabase();
  cleanup.push(() => opened.close());
  await opened.executor.batch([
    {
      sql: 'INSERT INTO organization (id, slug, name) VALUES (?, ?, ?)',
      params: [ORG.orgId, 'org', 'Org'],
    },
    {
      sql: 'INSERT INTO cache_epoch (org_id, version) VALUES (?, hex(randomblob(16))) ON CONFLICT (org_id) DO NOTHING',
      params: [ORG.orgId],
    },
  ]);
  return opened.executor;
}

function enqueue(executor: SqlExecutor, type: string, payload: unknown, key: string) {
  return createJobRepository(executor).enqueue(ORG, {
    id: ulid(),
    type,
    payloadJson: JSON.stringify(payload),
    idempotencyKey: key,
    resourceKey: null,
    runAt: null,
    maxAttempts: 5,
    projectId: null,
    initiatorTokenId: null,
  });
}

function spies() {
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
  return {
    fences,
    applyStore,
    rollbackStore,
    verificationStore: {
      loadRun: async () => null,
    } as unknown as import('@package-broker/core/import/verification').ImportVerificationStore,
  };
}

function loopOf(executor: SqlExecutor, jobs: ReturnType<typeof importJobRegistrations>): JobLoop {
  const observability = {
    log: () => undefined,
    counter: () => undefined,
    histogram: () => undefined,
  };
  const loop = createJobLoop({
    executor,
    jobs,
    scope: () => ({
      ports: {
        organizations: { get: async () => null },
        clock: systemClock,
        ids: { ulid },
      } as unknown as PluginPorts,
      observability,
    }),
    observability,
  });
  cleanup.push(async () => {
    await loop.stop();
  });
  return loop;
}

describe('import job holder', () => {
  it('accepts exactly one set', () => {
    const holder = createImportJobHolder();
    const { applyStore, rollbackStore, verificationStore } = spies();
    const stores = {
      applyStore,
      rollbackStore,
      verificationStore,
      blobs: { get: async () => null },
    };
    holder.set(stores);
    expect(() => holder.set(stores)).toThrow();
  });

  it('registers all core import job types under their queue names', () => {
    const jobs = importJobRegistrations(createImportJobHolder());
    expect(jobs.map((job) => job.qualifiedName)).toEqual([
      IMPORT_VERIFICATION_JOB.type,
      IMPORT_RUN_JOB.apply,
      IMPORT_RUN_JOB.rollback,
    ]);
  });
});

describe('import jobs on the Node job loop', () => {
  it('fails a claim made before the holder is set as a retryable handler_error', async () => {
    const executor = await database();
    const holder = createImportJobHolder();
    const apply = await enqueue(executor, IMPORT_RUN_JOB.apply, { runId: ulid() }, 'apply-early');
    const rollback = await enqueue(
      executor,
      IMPORT_RUN_JOB.rollback,
      { runId: ulid(), requestedBy: REQUESTER },
      'rollback-early',
    );
    loopOf(executor, importJobRegistrations(holder)).start();
    const repository = createJobRepository(executor);
    for (const id of [apply.id, rollback.id]) {
      await vi.waitFor(async () => {
        expect(await repository.status(ORG, id)).toMatchObject({
          state: 'queued',
          lastErrorCode: 'handler_error',
        });
      }, WAIT);
    }
  });

  it('hands the claim fence to the apply and rollback stores once the holder is set', async () => {
    const executor = await database();
    const holder = createImportJobHolder();
    const { fences, applyStore, rollbackStore, verificationStore } = spies();
    holder.set({ applyStore, rollbackStore, verificationStore, blobs: { get: async () => null } });
    const runId = ulid();
    const apply = await enqueue(executor, IMPORT_RUN_JOB.apply, { runId }, 'apply');
    const rollback = await enqueue(
      executor,
      IMPORT_RUN_JOB.rollback,
      { runId, requestedBy: REQUESTER },
      'rollback',
    );
    loopOf(executor, importJobRegistrations(holder)).start();
    const repository = createJobRepository(executor);
    for (const id of [apply.id, rollback.id]) {
      await vi.waitFor(async () => {
        expect(await repository.status(ORG, id)).toMatchObject({ state: 'succeeded' });
      }, WAIT);
    }
    const [applied] = fences.apply;
    const [rolledBack] = fences.rollback;
    expect(fences.apply).toHaveLength(1);
    expect(fences.rollback).toHaveLength(1);
    expect(fenceKind(applied!)).toBe('delegated');
    expect(applied).toMatchObject({ approverUserId: APPROVER, runId, job: { id: apply.id } });
    expect(rolledBack).toMatchObject({
      approverUserId: REQUESTER,
      runId,
      job: { id: rollback.id },
    });
  });

  it('rejects a rollback payload without requestedBy as invalid_payload', async () => {
    const executor = await database();
    const holder = createImportJobHolder();
    const { applyStore, rollbackStore, verificationStore } = spies();
    holder.set({ applyStore, rollbackStore, verificationStore, blobs: { get: async () => null } });
    const job = await enqueue(executor, IMPORT_RUN_JOB.rollback, { runId: ulid() }, 'legacy');
    loopOf(executor, importJobRegistrations(holder)).start();
    await vi.waitFor(async () => {
      expect(await createJobRepository(executor).status(ORG, job.id)).toMatchObject({
        state: 'dead',
        lastErrorCode: 'invalid_payload',
      });
    }, WAIT);
  });
});

describe('import jobs in the Node server assembly', () => {
  it('registers all import jobs with real stores and completes a claim for an unknown run', async () => {
    const executor = await database();
    const broker = createNodeServer([], {
      executor,
      log: () => undefined,
      auth: {
        keyring: createKeyring([parseMasterKey(KEY, 'PB_MASTER_KEY')]),
        publicOrigin: 'http://127.0.0.1',
        env: {},
      },
      platformServices: {
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
      },
    });
    cleanup.push(() => broker.close());
    const kernel = await broker.ready();
    const jobs = kernel.registration.jobs;
    expect(jobs.map((job) => job.qualifiedName)).toEqual(
      expect.arrayContaining([IMPORT_RUN_JOB.apply, IMPORT_RUN_JOB.rollback]),
    );
    const apply = await enqueue(executor, IMPORT_RUN_JOB.apply, { runId: ulid() }, 'real-apply');
    const rollback = await enqueue(
      executor,
      IMPORT_RUN_JOB.rollback,
      { runId: ulid(), requestedBy: REQUESTER },
      'real-rollback',
    );
    loopOf(executor, jobs as ReturnType<typeof importJobRegistrations>).start();
    const repository = createJobRepository(executor);
    for (const id of [apply.id, rollback.id]) {
      await vi.waitFor(async () => {
        expect(await repository.status(ORG, id)).toMatchObject({ state: 'succeeded' });
      }, WAIT);
    }
  });
});
