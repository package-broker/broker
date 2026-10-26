import { beforeEach, expect, it, vi } from 'vitest';
import { orgContext } from '@package-broker/core/db/port';
import type { CatalogueWriteGuard } from '@package-broker/core/db/catalogue';
import type { IngestFinalizeResult } from '@package-broker/core/ingest/finalize';
import type { IngestSessionHandle } from '@package-broker/core/ingest/session';
import { applyChunk } from '@package-broker/core/ingest/apply-description';
import {
  createPackageSyncJob,
  type PackageSyncDeps,
} from '@package-broker/core/ingest/package-sync-job';
import {
  createSourceSyncJob,
  type SourceSyncDeps,
} from '@package-broker/core/ingest/source-sync-job';
import { jobFences } from '@package-broker/core/platform/job-fences';
import type { JobContext } from '@package-broker/core/platform/jobs';
import { noopObservability } from '@package-broker/core/platform/observability';
import { createPackageDescription, snapshotRef } from '@package-broker/core/sources/provider';

vi.mock('@package-broker/core/ingest/apply-description', async (original) => ({
  ...(await original<typeof import('@package-broker/core/ingest/apply-description')>()),
  applyChunk: vi.fn(),
}));

const ctx = orgContext('org');
const session: IngestSessionHandle = {
  id: 'session',
  scopeKey: 'scope',
  owner: 'worker',
  fence: 1,
  leaseSeconds: 60,
  generation: 1,
  stamp: '2026-10-21T00:00:00.000Z',
  snapshotId: '"snapshot"',
  snapshotBlobSha256: null,
  cursor: '{"c":null,"o":0,"d":1}',
  seenCount: 2,
  pagesSoFar: 1,
  pendingValidators: null,
};
const guard = [] as unknown as CatalogueWriteGuard;

function context() {
  const counter = vi.fn();
  const job = {
    org: ctx,
    jobId: 'job',
    idempotencyKey: 'poll',
    attempt: 1,
    fence: 1,
    signal: new AbortController().signal,
    fences: jobFences({ id: 'job', owner: 'worker', fence: 1 }),
    observability: { ...noopObservability, counter },
    ports: {} as JobContext['ports'],
  } as JobContext;
  return { job, counter };
}

beforeEach(() => {
  vi.mocked(applyChunk).mockReset();
});

for (const leaseHeldBack of [0, 2]) {
  it(`source job succeeds and records ${leaseHeldBack} held-back leases`, async () => {
    const { job, counter } = context();
    const pollState = vi.fn(async () => 'written' as const);
    const abandon = vi.fn();
    const release = vi.fn(async () => true);
    const deps = {
      sources: {
        get: async () => ({ id: 'source', type: 'composer_repository', credentialId: null }),
        pollState,
      },
      sessions: { acquire: async () => session, abandon, release },
      toProviderSource: () => ({ id: 'source' }),
      providers: { forSource: () => ({ listPackages: vi.fn() }) },
      providerContext: () => ({}),
      markedCount: async () => 2,
      unseenExistingCount: async () => 0,
      finalizer: {
        finalize: async (): Promise<IngestFinalizeResult> => ({
          status: 'complete',
          empty: false,
          validatorsPublished: 0,
          leaseHeldBack,
        }),
      },
      writeGuard: () => guard,
      jobGuard: () => ({ id: 'job', owner: 'worker', fence: 1 }),
    } as unknown as SourceSyncDeps;
    const definition = createSourceSyncJob(deps);
    await expect(
      definition.handler({ sourceId: 'source', reason: 'poll' }, job),
    ).resolves.toBeUndefined();
    expect(pollState).toHaveBeenCalledTimes(2);
    expect(pollState).toHaveBeenNthCalledWith(1, ctx, expect.anything(), {
      id: 'source',
      outcome: 'started',
      reset: true,
      generation: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(pollState).toHaveBeenLastCalledWith(ctx, expect.anything(), {
      id: 'source',
      outcome: 'success',
      listingHash: '"snapshot"',
    });
    expect(abandon).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(counter).toHaveBeenCalledExactlyOnceWith(
      'pb.ingest.lease_held_back',
      undefined,
      leaseHeldBack,
    );
  });

  it(`package job succeeds and records ${leaseHeldBack} held-back leases`, async () => {
    const { job, counter } = context();
    const abandon = vi.fn();
    const release = vi.fn(async () => true);
    const enqueue = vi.fn();
    const finalized: IngestFinalizeResult = {
      status: 'complete',
      empty: false,
      validatorsPublished: 0,
      leaseHeldBack,
    };
    const description = createPackageDescription({
      name: 'acme/p',
      snapshot: snapshotRef('"snapshot"'),
      members: (async function* () {})(),
      validators: {},
      documentsComplete: true,
      skippedMembers: [],
    });
    const deps = {
      sessions: {
        acquire: async () => session,
        setPendingValidators: async () => true,
        abandon,
        release,
      },
      apply: { finalizer: { finalize: async () => finalized } },
      jobs: { enqueue },
      sourceMetadata: async () => ({ type: 'npmjs_proxy' }),
      planFill: async () => ({
        describe: async () => ({ kind: 'found', description }),
        validatorTtlSeconds: 0,
      }),
      findPackageId: async () => null,
      writeGuard: () => guard,
    } as unknown as PackageSyncDeps;
    vi.mocked(applyChunk).mockImplementationOnce(async (_ctx, apply) => {
      expect(
        await apply.finalizer.finalize(
          ctx,
          session,
          {
            expectedCount: 2,
            attemptedCandidates: 2,
            successfulCandidates: 2,
            definitiveAbsent: 0,
            upstreamComplete: true,
            validatorTtlSeconds: 0,
          },
          guard,
        ),
      ).toEqual(finalized);
      return {
        done: true,
        status: 'complete',
        session,
        cursor: null,
        planned: 0,
        skipped: [],
        refused: [],
        duplicates: [],
        tagsSkipped: false,
        skippedTags: [],
      };
    });
    const definition = createPackageSyncJob(deps);
    await expect(
      definition.handler({ sourceId: 'source', key: 'acme/p' }, job),
    ).resolves.toBeUndefined();
    expect(applyChunk).toHaveBeenCalledTimes(1);
    expect(abandon).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(counter).toHaveBeenCalledExactlyOnceWith(
      'pb.ingest.lease_held_back',
      undefined,
      leaseHeldBack,
    );
  });
}
