import { describe, expect, it, vi } from 'vitest';
import { fenceKind } from '../authz/fence.js';
import { orgContext } from '../db/port.js';
import { fixedClock, ulid } from '../ids.js';
import { parseSha256, type BlobStore } from '../platform/blob.js';
import { jobFences } from '../platform/job-fences.js';
import { JobError, type JobContext } from '../platform/jobs.js';
import { importVerificationJob } from './jobs.js';
import { canonicalManifest, parseManifest, planHash } from './manifest.js';
import { IMPORT_VERIFICATION_JOB } from './run-service.js';
import type { ImportVerificationStore } from './verification.js';

const ctx = orgContext('org');
const runId = ulid();
const now = '2026-10-20T00:00:00.000Z';
const lease = { id: 'job', owner: 'owner', fence: 3 };
const parsed = parseManifest({ version: 1, source_system: 'test', items: [], widening: [] });
if (!parsed.ok) throw new Error('invalid manifest fixture');
const manifest = parsed.data;

async function setup(text = canonicalManifest(manifest), hash?: string, get?: BlobStore['get']) {
  const loadRun = vi.fn(async () => ({
    id: runId,
    state: 'verifying' as const,
    planHash: hash ?? (await planHash(manifest)),
    approvedAt: now,
    approvedByUserId: 'actor',
    manifestBlobSha256: parseSha256('a'.repeat(64)),
  }));
  const store = {
    loadRun,
    verify: vi.fn<ImportVerificationStore['verify']>().mockResolvedValue({ ok: true, results: [] }),
    fail: vi.fn<ImportVerificationStore['fail']>().mockResolvedValue({ ok: true, results: [] }),
  };
  const job = importVerificationJob({
    store,
    blobs: {
      get:
        get ??
        (async () => ({
          body: new Response(text).body!,
          info: {
            generation: '',
            sha256: parseSha256('a'.repeat(64)),
            size: text.length,
            mediaType: 'application/json',
            purgeAfter: null,
          },
        })),
    },
    clock: fixedClock(now),
  });
  const context = { org: ctx, fences: jobFences(lease) } as JobContext;
  return { store, job, context };
}

describe('import verification job', () => {
  it('validates exactly the lifecycle payload and qualifies to the queue contract', async () => {
    const { job } = await setup();
    expect(`core:${job.name}:v${job.version}`).toBe(IMPORT_VERIFICATION_JOB.type);
    expect(job.validate(IMPORT_VERIFICATION_JOB.payload(runId))).toEqual({ runId });
    for (const value of [null, [], {}, { runId: 'bad' }, { runId, extra: 1 }])
      expect(() => job.validate(value)).toThrow();
  });
  it('requires job context fences before any store call', async () => {
    const { job, store } = await setup();
    await expect(job.handler({ runId }, { org: ctx } as JobContext)).rejects.toBeInstanceOf(
      JobError,
    );
    expect(store.loadRun).not.toHaveBeenCalled();
  });
  it('passes the manifest to the store with a verifier fence from the lease', async () => {
    const { job, store, context } = await setup();
    await job.handler({ runId }, context);
    expect(store.verify).toHaveBeenCalledWith(ctx, expect.anything(), { runId, manifest, now });
    const fence = store.verify.mock.calls[0]![1];
    expect(fenceKind(fence)).toBe('system');
    expect(fence.writer).toBe('verifier');
    expect(fence.job).toEqual(lease);
    expect(store.fail).not.toHaveBeenCalled();
  });
  it.each([
    ['invalid JSON', '{', undefined, 'manifest_unavailable'],
    ['invalid manifest', '{}', undefined, 'manifest_unavailable'],
    ['different digest', canonicalManifest(manifest), 'b'.repeat(64), 'plan_hash_mismatch'],
  ])('audits safe failure for %s', async (_name, text, hash, reason) => {
    const { job, store, context } = await setup(text, hash);
    await job.handler({ runId }, context);
    expect(store.fail).toHaveBeenCalledWith(ctx, expect.anything(), { runId, now, reason });
    expect(store.verify).not.toHaveBeenCalled();
  });
  it.each(['get', 'stream'] as const)(
    'retries a transient %s failure without semantic failure or audit',
    async (failure) => {
      const { job, store, context } = await setup(undefined, undefined, async () => {
        if (failure === 'get') throw new Error('storage unavailable');
        return {
          body: new ReadableStream({
            start(controller) {
              controller.error(new Error('read failed'));
            },
          }),
          info: {},
        } as Awaited<ReturnType<BlobStore['get']>>;
      });
      await expect(job.handler({ runId }, context)).rejects.toMatchObject({
        code: 'handler_error',
      });
      expect(store.verify).not.toHaveBeenCalled();
      expect(store.fail).not.toHaveBeenCalled();
    },
  );
  it('records a semantic failure for a truly missing manifest', async () => {
    const { job, store, context } = await setup(undefined, undefined, async () => null);
    await job.handler({ runId }, context);
    expect(store.fail).toHaveBeenCalledWith(ctx, expect.anything(), {
      runId,
      now,
      reason: 'manifest_unavailable',
    });
  });
  it('throws a retryable job error when completion loses its fence', async () => {
    const { job, store, context } = await setup();
    store.verify.mockResolvedValue({ ok: false, reason: 'authority' });
    await expect(job.handler({ runId }, context)).rejects.toMatchObject({ code: 'handler_error' });
    expect(store.fail).not.toHaveBeenCalled();
  });
});
