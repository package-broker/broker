import type { SourceRepository } from '../db/source.js';
import { sourceErrorCode } from './sync-error.js';
import type { CatalogueWriteGuard } from '../db/catalogue.js';
import { ACCESS_MUTATION_GUARD_CONSTRAINT, DbError } from '../db/errors.js';
import type { OrgContext, SqlExecutor, Statement } from '../db/port.js';
import type { UpstreamForm, UpstreamStateRepository } from '../db/upstream-state.js';
import type { Clock } from '../ids.js';
import { jobLeaseOf } from '../platform/job-fences.js';
import { JobRelease } from '../platform/job-release.js';
import {
  JOB_HANDLER_BUDGET_SECONDS,
  JOB_RELEASE_DELAY_SECONDS,
} from '../platform/job-repository.js';
import type { JobGuard } from '../platform/job-repository.js';
import { canonicalPayload, defineJob, JobError } from '../platform/jobs.js';
import type { EnqueueInput, Jobs } from '../platform/jobs.js';
import type { SourceType } from '../sources/config.js';
import { assertDescribeResult } from '../sources/provider.js';
import { applyChunk, type ApplyDeps } from './apply-description.js';
import {
  describeOptions,
  isSnapshotGone,
  isUpstreamFailure,
  pendingValidators,
  upstreamForm,
} from './fill-shared.js';
import type { PackageFillPlan, PackageSyncPayload } from './on-demand.js';
import type { IngestSessionHandle, IngestSessionRelease, IngestSessions } from './session.js';
import { parsePendingValidators } from './validators.js';

export const PACKAGE_SYNC_JOB_TYPE = 'core:package-sync:v1';
const NOT_FOUND_TTL_SECONDS = 30;
const MAX_ATTEMPTS = 25;
const ABANDONED_RESYNC_DELAY_MS = 60_000;
const ABANDONED_RESYNC_WINDOW_MS = 3_600_000;
const MAX_TEXT = 512;

export interface PackageSyncDeps {
  readonly sourceErrorStatements?: SourceRepository['packageErrorStatements'];
  readonly sessions: IngestSessions & IngestSessionRelease;
  readonly apply: ApplyDeps;
  readonly jobs: Pick<Jobs, 'enqueue'>;
  readonly upstreamState: Pick<
    UpstreamStateRepository,
    'touchStatements' | 'notFoundStatements' | 'resetNotFoundStatements'
  >;
  readonly executor: Pick<SqlExecutor, 'batch'>;
  readonly sourceMetadata: (
    ctx: OrgContext,
    sourceId: string,
  ) => Promise<{
    readonly type: SourceType;
    readonly form?: Exclude<UpstreamForm, 'composer-p2-dev'>;
  }>;
  readonly planFill: (
    ctx: OrgContext,
    sourceId: string,
    key: string,
  ) => Promise<PackageFillPlan | null>;
  readonly findPackageId: (
    ctx: OrgContext,
    sourceId: string,
    key: string,
  ) => Promise<string | null>;
  readonly writeGuard: (
    ctx: OrgContext,
    session: IngestSessionHandle,
    job: JobGuard,
  ) => CatalogueWriteGuard;
  readonly clock: Clock;
  readonly leaseSeconds?: number;
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= MAX_TEXT;
}

function count(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
}

function validate(input: unknown): PackageSyncPayload {
  const payload = JSON.parse(canonicalPayload(input)) as Record<string, unknown> | null;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new JobError('invalid_payload');
  }
  const { sourceId, key, sessionId, generation, step, syncGeneration, ...rest } = payload;
  const continuation = sessionId !== undefined || generation !== undefined;
  if (
    Object.keys(rest).length > 0 ||
    !text(sourceId) ||
    !text(key) ||
    (syncGeneration !== undefined &&
      (typeof syncGeneration !== 'string' || !/^[a-f0-9]{64}$/.test(syncGeneration))) ||
    (continuation && (!text(sessionId) || !count(generation, 1))) ||
    (step !== undefined && (!continuation || !count(step, 0)))
  ) {
    throw new JobError('invalid_payload');
  }
  return {
    sourceId,
    key,
    ...(syncGeneration === undefined ? {} : { syncGeneration: syncGeneration as string }),
    ...(continuation ? { sessionId: sessionId as string, generation: generation as number } : {}),
    ...(step === undefined ? {} : { step }),
  };
}

async function sha256Hex(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function packageSyncEnqueueInput(
  payload: PackageSyncPayload,
  freshKey?: string,
): Promise<EnqueueInput> {
  const resourceKey = await sha256Hex(['v1', payload.sourceId, payload.key]);
  if (payload.sessionId === undefined) {
    if (freshKey === undefined) throw new TypeError('a fresh sync needs a caller-supplied key');
    return { idempotencyKey: freshKey, resourceKey };
  }
  return {
    idempotencyKey: await sha256Hex([payload.sessionId, payload.generation, payload.step ?? 0]),
    resourceKey,
  };
}

const retry = () => new JobError('handler_error');

/** Bind the dependencies with createPackageSyncJob before dispatching jobs. */
export const packageSyncJob = defineJob<unknown>({
  name: 'package-sync',
  version: 1,
  maxAttempts: MAX_ATTEMPTS,
  validate,
  async handler(_payload, context) {
    if (context.signal.aborted) return;
    throw new JobError('invalid_definition');
  },
});

export function createPackageSyncJob(deps: PackageSyncDeps) {
  return defineJob<unknown>({
    ...packageSyncJob,
    validate,
    async handler(input: unknown, context) {
      if (context.signal.aborted) return;
      const lease = jobLeaseOf(context);
      if (lease === null) throw new JobError('invalid_definition');
      const payload = validate(input);
      const { sourceId, key } = payload;
      const ctx = context.org;
      const plan = await deps.planFill(ctx, sourceId, key);
      if (plan === null) return;
      const handle = await deps.sessions.acquire(
        ctx,
        { scope: 'package', sourceId, packageKey: key },
        lease.owner,
        deps.leaseSeconds ?? JOB_HANDLER_BUDGET_SECONDS,
      );
      if (handle === 'held') throw new JobRelease(JOB_RELEASE_DELAY_SECONDS);
      let session = handle;
      let open = true;
      const end = async (abandon: boolean) => {
        open = false;
        if (abandon) await deps.sessions.abandon(ctx, session);
        else await deps.sessions.release(ctx, session);
      };
      const leaseChecked = async <T>(write: () => Promise<T>): Promise<T> => {
        try {
          return await write();
        } catch (error) {
          if (error instanceof DbError && error.constraint === ACCESS_MUTATION_GUARD_CONSTRAINT) {
            throw new JobError('lease_lost');
          }
          throw error;
        }
      };
      const guarded = (statements: readonly Statement[]) =>
        leaseChecked(() =>
          deps.executor.batch([...deps.writeGuard(ctx, session, lease), ...statements]),
        );
      try {
        if (
          payload.sessionId !== undefined &&
          (session.id !== payload.sessionId || session.generation !== payload.generation)
        ) {
          await end(session.stamp === null);
          return;
        }
        const metadata = await deps.sourceMetadata(ctx, sourceId);
        const form = upstreamForm(metadata.type, metadata.form);
        const forms: UpstreamForm[] =
          form === 'composer-p2' ? ['composer-p2', 'composer-p2-dev'] : [form];
        const describeInput = describeOptions(session, plan.publishedValidators);
        const described = await plan.describe(describeInput, context.signal);
        context.signal.throwIfAborted();
        try {
          assertDescribeResult(describeInput, described);
        } catch {
          throw retry();
        }
        if (described.kind === 'not_modified') {
          const packageId = await deps.findPackageId(ctx, sourceId, key);
          if (packageId !== null) {
            await guarded(
              forms.flatMap((each) =>
                deps.upstreamState.touchStatements(ctx, packageId, each, plan.validatorTtlSeconds),
              ),
            );
          }
          await end(session.stamp === null);
          return;
        }
        if (described.kind === 'not_found') {
          if (!described.definitive) throw retry();
          const packageId = await deps.findPackageId(ctx, sourceId, key);
          if (packageId !== null) {
            await guarded(
              forms.flatMap((each) =>
                deps.upstreamState.notFoundStatements(ctx, packageId, each, NOT_FOUND_TTL_SECONDS),
              ),
            );
            await leaseChecked(() =>
              deps.apply.writer.markPackageAbsent(ctx, deps.writeGuard(ctx, session, lease), {
                packageId,
              }),
            );
          }
          await end(true);
          return;
        }
        const validators =
          session.snapshotBlobSha256 !== null &&
          session.snapshotId === described.description.snapshot.id &&
          session.pendingValidators !== null
            ? parsePendingValidators(session.pendingValidators)
            : pendingValidators(described.description.validators, form);
        const heldId = await deps.findPackageId(ctx, sourceId, key);
        if (heldId !== null) {
          await guarded(deps.upstreamState.resetNotFoundStatements(ctx, heldId));
        }
        const apply: ApplyDeps = {
          ...deps.apply,
          finalizer: {
            // applyChunk reserves four validator statements: at most two publishes plus this write.
            async finalize(finalizeCtx, finalizing, finalInput, finalGuard) {
              if (!(await deps.sessions.setPendingValidators(finalizeCtx, finalizing, validators)))
                return { status: 'refused', reason: 'superseded' };
              const result = await deps.apply.finalizer.finalize(
                finalizeCtx,
                finalizing,
                finalInput,
                finalGuard,
              );
              if (result.status === 'complete') {
                context.observability.counter(
                  'pb.ingest.lease_held_back',
                  undefined,
                  result.leaseHeldBack,
                );
              }
              return result;
            },
          },
        };
        const applied = await leaseChecked(() =>
          applyChunk(ctx, apply, {
            ...plan,
            description: described.description,
            session,
            guard: deps.writeGuard(ctx, session, lease),
          }),
        );
        session = applied.session;
        if (applied.status === 'abandoned') {
          open = false;
          const fresh: PackageSyncPayload = {
            sourceId,
            key,
            ...(payload.syncGeneration === undefined
              ? {}
              : { syncGeneration: payload.syncGeneration }),
          };
          const now = deps.clock.now().getTime();
          await deps.jobs.enqueue(ctx, PACKAGE_SYNC_JOB_TYPE, fresh, {
            ...(await packageSyncEnqueueInput(
              fresh,
              await sha256Hex([
                'abandoned',
                sourceId,
                key,
                ...(payload.syncGeneration === undefined ? [] : [payload.syncGeneration]),
                Math.floor(now / ABANDONED_RESYNC_WINDOW_MS),
              ]),
            )),
            runAt: new Date(now + ABANDONED_RESYNC_DELAY_MS).toISOString(),
          });
          return;
        }
        if (applied.status === 'superseded') {
          open = false;
          throw retry();
        }
        if (applied.status === 'progress') {
          if (!(await deps.sessions.setPendingValidators(ctx, session, validators))) {
            open = false;
            throw retry();
          }
          await end(false);
          const next: PackageSyncPayload = {
            sourceId,
            key,
            ...(payload.syncGeneration === undefined
              ? {}
              : { syncGeneration: payload.syncGeneration }),
            sessionId: session.id,
            generation: session.generation,
            step: session.pagesSoFar,
          };
          await deps.jobs.enqueue(
            ctx,
            PACKAGE_SYNC_JOB_TYPE,
            next,
            await packageSyncEnqueueInput(next),
          );
          return;
        }
        if (applied.status === 'refused' || applied.status === 'incomplete') {
          if (!applied.done) await end(true);
          open = false;
          throw retry();
        }
        open = false;
      } catch (error) {
        if (
          payload.syncGeneration !== undefined &&
          !context.signal.aborted &&
          !(error instanceof JobRelease) &&
          deps.sourceErrorStatements !== undefined
        ) {
          await deps.executor.batch(deps.sourceErrorStatements(ctx, lease, sourceErrorCode(error)));
        }
        if (open) {
          await end(isSnapshotGone(error) || session.stamp === null).catch(() => undefined);
        }
        if (error instanceof JobError) throw error;
        if (context.signal.aborted) throw error;
        if (isSnapshotGone(error) || isUpstreamFailure(error)) throw retry();
        throw error;
      }
    },
  });
}
