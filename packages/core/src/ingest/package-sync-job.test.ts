import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ABSENCE_MIN_NOT_FOUND, ABSENCE_MIN_SPAN_MS } from '../db/catalogue.js';
import type { CatalogueWriteGuard } from '../db/catalogue.js';
import { ACCESS_MUTATION_GUARD_CONSTRAINT, DbError } from '../db/errors.js';
import type { OrgId, Statement } from '../db/port.js';
import { jobSourceError } from '../platform/job-source-error.js';
import { jobFences, jobLeaseOf } from '../platform/job-fences.js';
import { JobRelease, releaseDelayOf } from '../platform/job-release.js';
import { JOB_HANDLER_BUDGET_SECONDS } from '../platform/job-repository.js';
import { defineJob, JobError, type JobContext } from '../platform/jobs.js';
import { registerCoreJob } from '../runtime/core-jobs.js';
import { UpstreamError } from '../sources/policy-fetch.js';
import { createPackageDescription, snapshotRef } from '../sources/provider.js';
import type { DescribeResult } from '../sources/provider.js';
import type { ApplyOutcome } from './apply-description.js';
import { applyChunk } from './apply-description.js';
import {
  createPackageSyncJob,
  packageSyncEnqueueInput,
  packageSyncJob,
  type PackageSyncDeps,
} from './package-sync-job.js';
import type { IngestSessionHandle } from './session.js';
import { SnapshotCorruptError } from './snapshot.js';

vi.mock('./apply-description.js', async (original) => ({
  ...(await original<typeof import('./apply-description.js')>()),
  applyChunk: vi.fn(),
}));

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const org = { orgId: 'org' as OrgId };
const lease = Object.freeze({ id: 'job-1', owner: 'claim-owner', fence: 3 });
const guard = Object.freeze([{ sql: 'guard', params: [] }]) as unknown as CatalogueWriteGuard;
const fresh: IngestSessionHandle = {
  id: 'session',
  scopeKey: 'scope',
  owner: 'owner',
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
const staged: IngestSessionHandle = {
  ...fresh,
  stamp: 'stamp',
  snapshotId: '"snapshot"',
  cursor: '{}',
  pagesSoFar: 1,
};
const description = () =>
  createPackageDescription({
    name: 'name',
    snapshot: snapshotRef('"snapshot"'),
    members: (async function* () {})(),
    validators: { 'npm-full': { etag: '"e"', lastModified: 'Mon' } },
    documentsComplete: true,
    skippedMembers: [],
  });
const outcome = (extra: Partial<ApplyOutcome>): ApplyOutcome => ({
  done: false,
  cursor: null,
  status: 'progress',
  session: staged,
  skipped: [],
  refused: [],
  duplicates: [],
  tagsSkipped: false,
  skippedTags: [],
  planned: 0,
  ...extra,
});

function setup() {
  let now = Date.UTC(2026, 9, 20, 10, 30);
  const events: string[] = [];
  let describeResult: DescribeResult = { kind: 'not_modified' };
  const describePackage = vi.fn(async () => describeResult);
  const sessions = {
    acquire: vi.fn(async (): Promise<IngestSessionHandle | 'held'> => fresh),
    start: vi.fn(async () => true),
    advance: vi.fn(async () => null),
    setPendingValidators: vi.fn(async () => {
      events.push('pending');
      return true;
    }),
    abandon: vi.fn(async () => {
      events.push('abandon');
      return true;
    }),
    release: vi.fn(async () => {
      events.push('release');
      return true;
    }),
    latest: vi.fn(async () => null),
  };
  const markPackageAbsent = vi.fn(async () => ({ changed: false, statements: 1 }));
  const batch = vi.fn(async (statements: readonly Statement[]) => {
    events.push(`batch:${statements.map((s) => s.sql).join('|')}`);
    return [];
  });
  const deps = {
    sessions,
    apply: { writer: { markPackageAbsent }, sessions, finalizer: {} },
    jobs: {
      enqueue: vi.fn(async () => {
        events.push('enqueue');
        return { id: 'job', created: true };
      }),
    },
    upstreamState: {
      touchStatements: vi.fn((_c, id: string) => [{ sql: `touch:${id}`, params: [] }]),
      notFoundStatements: vi.fn((_c, id: string, form: string) => [
        { sql: `notfound:${id}:${form}`, params: [] },
      ]),
      resetNotFoundStatements: vi.fn((_c, id: string) => [{ sql: `reset:${id}`, params: [] }]),
    },
    executor: { batch },
    sourceMetadata: vi.fn(async () => ({ type: 'npmjs_proxy' as const })),
    findPackageId: vi.fn(async (): Promise<string | null> => 'pkg'),
    planFill: vi.fn(async () => ({
      source: {
        id: 'A',
        key: 'name',
        type: 'npmjs_proxy' as const,
        ecosystem: 'npm' as const,
        covered: false,
      },
      describe: describePackage,
      toVersion: () => null,
      packageDescription: null,
      validatorTtlSeconds: 300,
      publishedValidators: { 'npm-full': { etag: '"old"' } },
    })),
    writeGuard: vi.fn(() => guard),
    clock: { now: () => new Date(now) },
  } as unknown as PackageSyncDeps & {
    sessions: typeof sessions;
    jobs: { enqueue: ReturnType<typeof vi.fn> };
  };
  const job = createPackageSyncJob(deps);
  const context = {
    org,
    jobId: 'job-1',
    signal: new AbortController().signal,
    fences: jobFences(lease),
    observability: { log: () => {}, counter: () => {}, histogram: () => {} },
  } as unknown as JobContext;
  const run = (payload: unknown = { sourceId: 'A', key: 'name' }) =>
    job.handler(job.validate(payload), context);
  return {
    deps,
    job,
    context,
    events,
    run,
    markPackageAbsent,
    batch,
    describePackage,
    sessions,
    setNow: (value: number) => {
      now = value;
    },
    setDescribe: (result: DescribeResult) => {
      describeResult = result;
    },
  };
}

beforeEach(() => {
  vi.mocked(applyChunk).mockReset();
});

describe('definition', () => {
  it('registers as core:package-sync:v1 and validates the payload', () => {
    expect(registerCoreJob(packageSyncJob).qualifiedName).toBe('core:package-sync:v1');
    expect(() => defineJob(packageSyncJob)).not.toThrow();
    expect(packageSyncJob.validate({ sourceId: 'A', key: 'name' })).toEqual({
      sourceId: 'A',
      key: 'name',
    });
    expect(
      packageSyncJob.validate({
        sourceId: 'A',
        key: 'name',
        sessionId: 's',
        generation: 2,
        step: 3,
      }),
    ).toEqual({ sourceId: 'A', key: 'name', sessionId: 's', generation: 2, step: 3 });
  });

  it.each([
    {},
    { sourceId: 'A' },
    { sourceId: 'A', key: '' },
    { sourceId: 'A', key: 'n', extra: 1 },
    { sourceId: 'A', key: 'n', sessionId: 's' },
    { sourceId: 'A', key: 'n', generation: 1 },
    { sourceId: 'A', key: 'n', sessionId: 's', generation: 0 },
    { sourceId: 'A', key: 'n', sessionId: 's', generation: 1, step: -1 },
    { sourceId: 'A', key: 'n', sessionId: 's', generation: 1.5 },
  ])('rejects payload %#', (payload) => {
    expect(() => packageSyncJob.validate(payload)).toThrow(JobError);
  });

  it('refuses to run unbound', async () => {
    await expect(
      packageSyncJob.handler({ sourceId: 'A', key: 'n' }, {
        signal: new AbortController().signal,
      } as JobContext),
    ).rejects.toThrow('invalid_definition');
  });

  it('hashes the resource and continuation keys and takes the fresh key from the caller', async () => {
    const first = await packageSyncEnqueueInput({ sourceId: 'A', key: 'n' }, 'generation-1');
    expect(first).toEqual({ idempotencyKey: 'generation-1', resourceKey: sha(['v1', 'A', 'n']) });
    const again = await packageSyncEnqueueInput({ sourceId: 'A', key: 'n' }, 'generation-2');
    expect(again.idempotencyKey).not.toBe(first.idempotencyKey);
    await expect(packageSyncEnqueueInput({ sourceId: 'A', key: 'n' })).rejects.toThrow(TypeError);
    const next = await packageSyncEnqueueInput({
      sourceId: 'A',
      key: 'n',
      sessionId: 's',
      generation: 2,
      step: 3,
    });
    expect(next).toEqual({ idempotencyKey: sha(['s', 2, 3]), resourceKey: sha(['v1', 'A', 'n']) });
  });
});

describe('job lease', () => {
  it('fails closed before any read, acquire or write when the context carries no lease', async () => {
    const h = setup();
    const bare: { fences?: unknown } = { ...h.context };
    delete bare.fences;
    await expect(
      h.job.handler(h.job.validate({ sourceId: 'A', key: 'name' }), bare as JobContext),
    ).rejects.toMatchObject({ code: 'invalid_definition' });
    expect(h.deps.planFill).not.toHaveBeenCalled();
    expect(h.sessions.acquire).not.toHaveBeenCalled();
    expect(h.describePackage).not.toHaveBeenCalled();
    expect(h.batch).not.toHaveBeenCalled();
    expect(h.deps.jobs.enqueue).not.toHaveBeenCalled();
  });

  it('hands the lease to every guard it builds', async () => {
    const h = setup();
    expect(jobLeaseOf(h.context)).toEqual(lease);
    h.setDescribe({ kind: 'not_found', definitive: true });
    await h.run();
    h.setDescribe({ kind: 'not_modified' });
    await h.run();
    h.setDescribe({ kind: 'found', description: description() });
    vi.mocked(applyChunk).mockResolvedValue(outcome({ done: true, status: 'complete' }));
    await h.run();
    const calls = vi.mocked(h.deps.writeGuard).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const call of calls) expect(call[2]).toEqual(lease);
  });

  it('allows 25 attempts', () => {
    expect(setup().job.maxAttempts).toBe(25);
    expect(packageSyncJob.maxAttempts).toBe(25);
  });
});

describe('describe and touch', () => {
  it('describes a new session with the published validators and touches on not_modified', async () => {
    const h = setup();
    await h.run();
    expect(h.describePackage).toHaveBeenCalledWith(
      { validators: { 'npm-full': { etag: '"old"' } } },
      expect.any(AbortSignal),
    );
    expect(h.deps.upstreamState.touchStatements).toHaveBeenCalledWith(
      org,
      'pkg',
      'npm-packument',
      300,
    );
    expect(h.batch).toHaveBeenCalledWith([
      { sql: 'guard', params: [] },
      { sql: 'touch:pkg', params: [] },
    ]);
    expect(h.sessions.abandon).toHaveBeenCalledTimes(1);
    expect(applyChunk).not.toHaveBeenCalled();
    expect(h.markPackageAbsent).not.toHaveBeenCalled();
  });

  it('acquires the package session as the claim owner for the handler budget', async () => {
    const h = setup();
    await h.run();
    expect(JOB_HANDLER_BUDGET_SECONDS).toBe(240);
    expect(h.sessions.acquire).toHaveBeenCalledWith(
      org,
      { scope: 'package', sourceId: 'A', packageKey: 'name' },
      'claim-owner',
      240,
    );
  });

  it('honours an explicit session lease length', async () => {
    const h = setup();
    Object.assign(h.deps, { leaseSeconds: 90 });
    await h.run();
    expect(h.sessions.acquire).toHaveBeenCalledWith(org, expect.anything(), 'claim-owner', 90);
  });

  it('does nothing when the source has no plan', async () => {
    const h = setup();
    vi.mocked(h.deps.planFill).mockResolvedValue(null);
    await h.run();
    expect(h.sessions.acquire).not.toHaveBeenCalled();
  });

  it('does nothing once the job is aborted', async () => {
    const h = setup();
    const controller = new AbortController();
    controller.abort();
    await h.job.handler(h.job.validate({ sourceId: 'A', key: 'name' }), {
      ...h.context,
      signal: controller.signal,
    });
    expect(h.sessions.acquire).not.toHaveBeenCalled();
  });
});

describe('apply', () => {
  it('applies a found description under the job guard and ends quietly when complete', async () => {
    const h = setup();
    h.setDescribe({ kind: 'found', description: description() });
    vi.mocked(applyChunk).mockResolvedValue(outcome({ done: true, status: 'complete' }));
    await h.run();
    expect(h.deps.writeGuard).toHaveBeenCalledWith(org, fresh, lease);
    expect(vi.mocked(applyChunk).mock.calls[0]![2]).toMatchObject({ guard, session: fresh });
    expect(h.deps.jobs.enqueue).not.toHaveBeenCalled();
  });

  it('persists the validators before the handoff and re-enqueues the continuation', async () => {
    const h = setup();
    h.setDescribe({ kind: 'found', description: description() });
    vi.mocked(applyChunk).mockResolvedValue(outcome({ session: { ...staged, pagesSoFar: 4 } }));
    await h.run();
    expect(h.sessions.setPendingValidators).toHaveBeenCalledWith(
      org,
      expect.objectContaining({ id: 'session' }),
      { 'npm-packument': { etag: '"e"', lastModified: 'Mon', contentSha256: null } },
    );
    expect(h.events.filter((event) => !event.startsWith('batch'))).toEqual([
      'pending',
      'release',
      'enqueue',
    ]);
    expect(h.deps.jobs.enqueue).toHaveBeenCalledWith(
      org,
      'core:package-sync:v1',
      {
        sourceId: 'A',
        key: 'name',
        parentJob: lease,
        sessionId: 'session',
        generation: 1,
        step: 4,
      },
      {
        idempotencyKey: sha(['session', 1, 4, lease.id, lease.owner, lease.fence]),
        resourceKey: sha(['v1', 'A', 'name']),
      },
    );
  });

  it('does not hand off when the validators cannot be persisted', async () => {
    const h = setup();
    h.setDescribe({ kind: 'found', description: description() });
    vi.mocked(applyChunk).mockResolvedValue(outcome({}));
    h.sessions.setPendingValidators.mockResolvedValue(false);
    await expect(h.run()).rejects.toThrow(JobError);
    expect(h.deps.jobs.enqueue).not.toHaveBeenCalled();
  });

  it('continues with the session snapshot and never the published validators', async () => {
    const h = setup();
    h.sessions.acquire.mockResolvedValue(staged);
    h.setDescribe({ kind: 'found', description: description() });
    vi.mocked(applyChunk).mockResolvedValue(outcome({ done: true, status: 'complete' }));
    await h.run({ sourceId: 'A', key: 'name', sessionId: 'session', generation: 1, step: 1 });
    expect(h.describePackage).toHaveBeenCalledWith(
      { snapshot: { id: '"snapshot"' } },
      expect.any(AbortSignal),
    );
  });

  it('ignores a continuation whose session was replaced', async () => {
    const h = setup();
    h.sessions.acquire.mockResolvedValue({ ...fresh, id: 'newer', generation: 2 });
    await h.run({ sourceId: 'A', key: 'name', sessionId: 'session', generation: 1, step: 1 });
    expect(h.describePackage).not.toHaveBeenCalled();
    expect(applyChunk).not.toHaveBeenCalled();
    expect(h.batch).not.toHaveBeenCalled();
    expect(h.deps.jobs.enqueue).not.toHaveBeenCalled();
  });

  it('releases without writing when a request fill holds the session', async () => {
    const h = setup();
    h.sessions.acquire.mockResolvedValue('held');
    const error = await h.run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobRelease);
    expect(releaseDelayOf(error)).toBe(60);
    expect(h.describePackage).not.toHaveBeenCalled();
    expect(applyChunk).not.toHaveBeenCalled();
    expect(h.batch).not.toHaveBeenCalled();
    expect(h.markPackageAbsent).not.toHaveBeenCalled();
    expect(h.deps.jobs.enqueue).not.toHaveBeenCalled();
  });

  it('retries without enqueueing when the job was superseded', async () => {
    const h = setup();
    h.setDescribe({ kind: 'found', description: description() });
    vi.mocked(applyChunk).mockResolvedValue(outcome({ done: true, status: 'superseded' }));
    await expect(h.run()).rejects.toThrow(JobError);
    expect(h.deps.jobs.enqueue).not.toHaveBeenCalled();
  });

  it('keeps a started session on an upstream error and removes nothing', async () => {
    const h = setup();
    h.sessions.acquire.mockResolvedValue(staged);
    h.describePackage.mockRejectedValue(new UpstreamError('http_status', 503));
    await expect(h.run()).rejects.toThrow(JobError);
    expect(h.sessions.release).toHaveBeenCalledTimes(1);
    expect(h.sessions.abandon).not.toHaveBeenCalled();
    expect(h.batch).not.toHaveBeenCalled();
    expect(h.markPackageAbsent).not.toHaveBeenCalled();
  });

  it('abandons an unstarted session on an upstream error', async () => {
    const h = setup();
    h.describePackage.mockRejectedValue(new UpstreamError('http_status', 503));
    await expect(h.run()).rejects.toThrow(JobError);
    expect(h.sessions.abandon).toHaveBeenCalledTimes(1);
    expect(h.sessions.release).not.toHaveBeenCalled();
  });

  it('abandons a corrupt snapshot so the next run starts a new generation', async () => {
    const h = setup();
    h.sessions.acquire.mockResolvedValue(staged);
    h.setDescribe({ kind: 'found', description: description() });
    vi.mocked(applyChunk).mockRejectedValue(new SnapshotCorruptError());
    await expect(h.run()).rejects.toThrow(JobError);
    expect(h.sessions.abandon).toHaveBeenCalledTimes(1);
    expect(h.deps.jobs.enqueue).not.toHaveBeenCalled();
  });
});

describe('refused and incomplete chunks', () => {
  it.each(['incomplete', 'refused'] as const)(
    'ends the %s chunk as a retryable failure, never as success',
    async (status) => {
      const h = setup();
      h.sessions.acquire.mockResolvedValue(staged);
      h.setDescribe({ kind: 'found', description: description() });
      vi.mocked(applyChunk).mockResolvedValue(outcome({ status }));
      const error = await h.run().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(JobError);
      expect((error as JobError).code).toBe('handler_error');
      expect(h.sessions.release).not.toHaveBeenCalled();
    },
  );

  it('abandons a session a non-abandoning refusal left running so the next attempt can acquire', async () => {
    const h = setup();
    let held = false;
    h.sessions.acquire.mockImplementation(async () => (held ? 'held' : staged));
    h.sessions.abandon.mockImplementation(async () => {
      held = false;
      return true;
    });
    h.setDescribe({ kind: 'found', description: description() });
    vi.mocked(applyChunk).mockImplementationOnce(async () => {
      held = true;
      return outcome({ status: 'refused', done: false });
    });
    await expect(h.run()).rejects.toMatchObject({ code: 'handler_error' });
    expect(h.sessions.abandon).toHaveBeenCalledTimes(1);
    expect(held).toBe(false);
    vi.mocked(applyChunk).mockResolvedValue(outcome({ done: true, status: 'complete' }));
    await expect(h.run()).resolves.toBeUndefined();
  });

  it('does not succeed silently when a continuation is answered with not_modified', async () => {
    const h = setup();
    h.sessions.acquire.mockResolvedValue(staged);
    h.setDescribe({ kind: 'not_modified' });
    await expect(
      h.run({ sourceId: 'A', key: 'name', sessionId: 'session', generation: 1, step: 1 }),
    ).rejects.toMatchObject({ code: 'handler_error' });
    expect(h.sessions.release).toHaveBeenCalledTimes(1);
    expect(h.deps.upstreamState.touchStatements).not.toHaveBeenCalled();
    expect(h.deps.jobs.enqueue).not.toHaveBeenCalled();
  });
});

describe('release only when held', () => {
  it.each([
    ['an upstream failure', new UpstreamError('http_status', 503)],
    ['a snapshot loss', new SnapshotCorruptError()],
  ])('never releases on %s', async (_name, failure) => {
    const h = setup();
    h.describePackage.mockRejectedValue(failure);
    const error = await h.run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobError);
    expect(error).not.toBeInstanceOf(JobRelease);
    expect(releaseDelayOf(error)).toBeNull();
  });

  it('propagates an unexpected error from a malformed describe result without releasing the job', async () => {
    const h = setup();
    h.setDescribe({ kind: 'found' } as DescribeResult);
    const error = await h.run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(JobRelease);
    expect(releaseDelayOf(error)).toBeNull();
    expect(h.sessions.abandon).toHaveBeenCalledTimes(1);
    expect(applyChunk).not.toHaveBeenCalled();
    expect(h.batch).not.toHaveBeenCalled();
    expect(h.deps.jobs.enqueue).not.toHaveBeenCalled();
  });

  it.each(['refused', 'incomplete', 'superseded'] as const)(
    'never releases on a %s chunk and on a non-definitive 404',
    async (status) => {
      const h = setup();
      h.setDescribe({ kind: 'found', description: description() });
      vi.mocked(applyChunk).mockResolvedValue(outcome({ status, done: true }));
      const error = await h.run().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(JobError);
      expect(error).not.toBeInstanceOf(JobRelease);
      h.setDescribe({ kind: 'not_found', definitive: false });
      const notFound = await h.run().catch((e: unknown) => e);
      expect(notFound).toBeInstanceOf(JobError);
      expect(notFound).not.toBeInstanceOf(JobRelease);
    },
  );
});

describe('upstream 404 rule', () => {
  it('records a definitive 404 and asks the writer for the absence transition', async () => {
    const h = setup();
    h.setDescribe({ kind: 'not_found', definitive: true });
    await h.run();
    expect(h.deps.upstreamState.notFoundStatements).toHaveBeenCalledWith(
      org,
      'pkg',
      'npm-packument',
      expect.any(Number),
    );
    expect(h.events.slice(0, 1)).toEqual(['batch:guard|notfound:pkg:npm-packument']);
    expect(h.markPackageAbsent).toHaveBeenCalledWith(org, guard, { packageId: 'pkg' });
    expect(h.sessions.abandon).toHaveBeenCalledTimes(1);
    expect(applyChunk).not.toHaveBeenCalled();
  });

  it('changes nothing visible after one 404 and reaches absence after two an hour apart', async () => {
    const h = setup();
    h.setDescribe({ kind: 'not_found', definitive: true });
    let count = 0;
    let first = 0;
    let now = 1_000_000;
    h.batch.mockImplementation(async (statements) => {
      if (statements.some((s) => s.sql.startsWith('notfound'))) {
        count += 1;
        if (count === 1) first = now;
      }
      return [];
    });
    let removed = false;
    h.markPackageAbsent.mockImplementation(async () => {
      const changed = count >= ABSENCE_MIN_NOT_FOUND && first <= now - ABSENCE_MIN_SPAN_MS;
      removed ||= changed;
      return { changed, statements: 1 };
    });
    await h.run();
    expect(removed).toBe(false);
    now += 60_000;
    await h.run();
    expect(removed).toBe(false);
    now += ABSENCE_MIN_SPAN_MS;
    await h.run();
    expect(removed).toBe(true);
    expect(h.markPackageAbsent).toHaveBeenCalledTimes(3);
  });

  it('ignores a 404 for a package the catalogue does not hold', async () => {
    const h = setup();
    h.setDescribe({ kind: 'not_found', definitive: true });
    vi.mocked(h.deps.findPackageId).mockResolvedValue(null);
    await h.run();
    expect(h.batch).not.toHaveBeenCalled();
    expect(h.markPackageAbsent).not.toHaveBeenCalled();
    expect(h.sessions.abandon).toHaveBeenCalledTimes(1);
  });

  it('treats a non-definitive 404 as an error', async () => {
    const h = setup();
    h.setDescribe({ kind: 'not_found', definitive: false });
    await expect(h.run()).rejects.toThrow(JobError);
    expect(h.batch).not.toHaveBeenCalled();
    expect(h.markPackageAbsent).not.toHaveBeenCalled();
  });

  it('writes nothing when the fence advanced before the 404 was recorded', async () => {
    const h = setup();
    h.setDescribe({ kind: 'not_found', definitive: true });
    h.batch.mockRejectedValue(
      new DbError('unique', 'guard', { constraint: ACCESS_MUTATION_GUARD_CONSTRAINT }),
    );
    await expect(h.run()).rejects.toMatchObject({ code: 'lease_lost' });
    expect(h.markPackageAbsent).not.toHaveBeenCalled();
    expect(h.deps.jobs.enqueue).not.toHaveBeenCalled();
  });

  it('writes nothing when the fence advanced before a touch', async () => {
    const h = setup();
    h.batch.mockRejectedValue(
      new DbError('unique', 'guard', { constraint: ACCESS_MUTATION_GUARD_CONSTRAINT }),
    );
    await expect(h.run()).rejects.toMatchObject({ code: 'lease_lost' });
  });
});

describe('fix round 1', () => {
  it('records the 404 for every upstream form of a Composer package', async () => {
    const h = setup();
    vi.mocked(h.deps.sourceMetadata).mockResolvedValue({ type: 'packagist_proxy' });
    h.setDescribe({ kind: 'not_found', definitive: true });
    await h.run();
    expect(h.deps.upstreamState.notFoundStatements).toHaveBeenCalledTimes(2);
    expect(h.events[0]).toBe('batch:guard|notfound:pkg:composer-p2|notfound:pkg:composer-p2-dev');
  });

  it('resets the 404 evidence under the guard before applying a found description', async () => {
    const h = setup();
    h.setDescribe({ kind: 'found', description: description() });
    vi.mocked(applyChunk).mockImplementation(async () => {
      h.events.push('apply');
      return outcome({ done: true, status: 'complete' });
    });
    await h.run();
    expect(h.events).toEqual(['batch:guard|reset:pkg', 'apply']);
  });

  it('does not reset for a package the catalogue does not hold yet', async () => {
    const h = setup();
    vi.mocked(h.deps.findPackageId).mockResolvedValue(null);
    h.setDescribe({ kind: 'found', description: description() });
    vi.mocked(applyChunk).mockResolvedValue(outcome({ done: true, status: 'complete' }));
    await h.run();
    expect(h.batch).not.toHaveBeenCalled();
  });

  it('enqueues a fresh sync when the apply abandoned the session', async () => {
    const h = setup();
    h.setDescribe({ kind: 'found', description: description() });
    vi.mocked(applyChunk).mockResolvedValue(
      outcome({
        done: true,
        status: 'abandoned',
        session: { ...staged, id: 'gone', generation: 3 },
      }),
    );
    await h.run();
    expect(h.deps.jobs.enqueue).toHaveBeenCalledWith(
      org,
      'core:package-sync:v1',
      { sourceId: 'A', key: 'name' },
      {
        idempotencyKey: sha([
          'abandoned',
          'A',
          'name',
          Math.floor(Date.UTC(2026, 9, 20, 10, 30) / 3_600_000),
        ]),
        resourceKey: sha(['v1', 'A', 'name']),
        runAt: new Date(Date.UTC(2026, 9, 20, 10, 30) + 60_000).toISOString(),
      },
    );
  });

  it('enqueues the same abandoned key within an hour and a new one in the next hour', async () => {
    const h = setup();
    h.setDescribe({ kind: 'found', description: description() });
    vi.mocked(applyChunk).mockImplementation(async () =>
      outcome({ done: true, status: 'abandoned', session: { ...staged, id: `s${Math.random()}` } }),
    );
    const hour = Date.UTC(2026, 9, 20, 10);
    h.setNow(hour + 60_000);
    await h.run();
    h.setNow(hour + 3_599_000);
    await h.run();
    h.setNow(hour + 3_600_000);
    await h.run();
    const calls = h.deps.jobs.enqueue.mock.calls as unknown as [
      unknown,
      unknown,
      unknown,
      { idempotencyKey: string; runAt: string },
    ][];
    expect(calls).toHaveLength(3);
    expect(calls[1]![3].idempotencyKey).toBe(calls[0]![3].idempotencyKey);
    expect(calls[2]![3].idempotencyKey).not.toBe(calls[0]![3].idempotencyKey);
    expect(calls[2]![3].idempotencyKey).toBe(sha(['abandoned', 'A', 'name', hour / 3_600_000 + 1]));
    expect(calls[2]![3].runAt).toBe(new Date(hour + 3_600_000 + 60_000).toISOString());
  });

  it('persists the validators before the finalizer runs', async () => {
    const h = setup();
    h.setDescribe({ kind: 'found', description: description() });
    const finalize = vi.fn(async () => {
      h.events.push('finalize');
      return {
        status: 'complete' as const,
        empty: false,
        validatorsPublished: 1,
        leaseHeldBack: 0,
      };
    });
    (h.deps.apply as { finalizer: unknown }).finalizer = { finalize };
    vi.mocked(applyChunk).mockImplementation(async (_ctx, applyDeps) => {
      await applyDeps.finalizer.finalize(org, staged, {} as never);
      return outcome({ done: true, status: 'complete' });
    });
    await h.run();
    expect(h.events.filter((e) => e === 'pending' || e === 'finalize')).toEqual([
      'pending',
      'finalize',
    ]);
  });

  it('refuses to finalize when the validators cannot be persisted', async () => {
    const h = setup();
    h.setDescribe({ kind: 'found', description: description() });
    const finalize = vi.fn();
    (h.deps.apply as { finalizer: unknown }).finalizer = { finalize };
    h.sessions.setPendingValidators.mockResolvedValue(false);
    let result: unknown;
    vi.mocked(applyChunk).mockImplementation(async (_ctx, applyDeps) => {
      result = await applyDeps.finalizer.finalize(org, staged, {} as never);
      return outcome({ done: true, status: 'complete' });
    });
    await h.run();
    expect(result).toEqual({ status: 'refused', reason: 'superseded' });
    expect(finalize).not.toHaveBeenCalled();
  });

  it('maps a guard failure of the absence transition to lease_lost', async () => {
    const h = setup();
    h.setDescribe({ kind: 'not_found', definitive: true });
    h.markPackageAbsent.mockRejectedValue(
      new DbError('unique', 'guard', { constraint: ACCESS_MUTATION_GUARD_CONSTRAINT }),
    );
    await expect(h.run()).rejects.toMatchObject({ code: 'lease_lost' });
  });
});

it('abandons the acquired stamped session when a continuation generation is stale', async () => {
  const h = setup();
  h.sessions.acquire.mockResolvedValue({ ...staged, generation: 2 });
  await h.run({ sourceId: 'A', key: 'name', sessionId: staged.id, generation: 1 });
  expect(h.sessions.abandon).toHaveBeenCalledExactlyOnceWith(
    org,
    expect.objectContaining({ generation: 2 }),
  );
  expect(h.sessions.release).not.toHaveBeenCalled();
});

it.each([
  [new UpstreamError('http_status', 503), 'http_error'],
  [new SnapshotCorruptError(), 'internal'],
] as const)('retries and annotates expected generation failures: %s', async (failure, code) => {
  const h = setup();
  h.describePackage.mockRejectedValue(failure);
  const error = await h
    .run({ sourceId: 'A', key: 'name', syncGeneration: 'a'.repeat(64) })
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(JobError);
  expect(error).toMatchObject({ code: 'handler_error' });
  expect(jobSourceError(error)).toBe(code);
});

it('annotates and rethrows an unexpected generation failure unchanged', async () => {
  const h = setup();
  const failure = new TypeError('unexpected');
  h.describePackage.mockRejectedValue(failure);
  const error = await h
    .run({ sourceId: 'A', key: 'name', syncGeneration: 'a'.repeat(64) })
    .catch((e: unknown) => e);
  expect(error).toBe(failure);
  expect(jobSourceError(error)).toBe('internal');
});
