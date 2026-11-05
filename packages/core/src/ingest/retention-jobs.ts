import { sha256Hex } from '../auth/primitives.js';
import type { OrgContext } from '../db/port.js';
import type { SourceRepository } from '../db/source.js';
import {
  orgStorageSegment,
  stagedStorageKey,
  type ByteStore,
  type PurgeGeneration,
  type Sha256,
} from '../platform/blob.js';
import type { BlobLifecycleMetadataPort, BlobPurgeOutcome } from '../platform/blob-lifecycle.js';
import {
  canonicalPayload,
  defineJob,
  JobError,
  type JobContext,
  type JobDefinition,
} from '../platform/jobs.js';

const RETENTION_SCAN = 'core:retention-scan:v1';
const BLOB_PURGE = 'core:blob-purge:v1';
const SOURCE_SYNC = 'core:source-sync:v1';
const PAGE = 50;
const HEX_64 = /^[0-9a-f]{64}$/;

export interface RetentionCursor {
  readonly createdAt: string;
  readonly id: string;
}

interface RetentionBlob extends RetentionCursor {
  readonly sha256: string;
}

export interface RetentionCandidate extends RetentionBlob {
  readonly orphan: boolean;
  readonly retentionDaysOverride: number | null;
}

interface RetentionPage {
  readonly limit: number;
  readonly after?: RetentionCursor | null;
}

export interface RetentionReader {
  candidates(ctx: OrgContext, page: RetentionPage): Promise<readonly RetentionCandidate[]>;
  scheduledIneligible(ctx: OrgContext, page: RetentionPage): Promise<readonly RetentionBlob[]>;
}

export interface PurgeLifecycle extends Pick<
  BlobLifecycleMetadataPort,
  'claimPurge' | 'cancelPurge' | 'listDue'
> {
  /** Must carry the lifecycle service's `purgeBytes` outcome; its `removeBytes` reports timeouts as `refused`. */
  removeBytes(ctx: OrgContext, key: Sha256, generation: PurgeGeneration): Promise<BlobPurgeOutcome>;
}

export interface RetentionLifecycle
  extends
    PurgeLifecycle,
    Pick<BlobLifecycleMetadataPort, 'softDelete' | 'scheduleOrphan' | 'unschedule'> {}

export interface RetentionScanPayload {
  readonly scan?: RetentionCursor | null;
  readonly sweep?: RetentionCursor | null;
}

export interface BlobPurgePayload {
  readonly after?: Sha256;
}

function digest(parts: readonly unknown[]): Promise<string> {
  return sha256Hex(JSON.stringify(parts));
}

function record(input: unknown): Record<string, unknown> {
  const value = JSON.parse(canonicalPayload(input)) as unknown;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new JobError('invalid_payload');
  }
  return value as Record<string, unknown>;
}

function cursor(value: unknown): RetentionCursor | null {
  if (value === null) return null;
  const item = value as Record<string, unknown> | undefined;
  if (
    typeof item !== 'object' ||
    Array.isArray(item) ||
    Object.keys(item).length !== 2 ||
    typeof item.createdAt !== 'string' ||
    typeof item.id !== 'string'
  ) {
    throw new JobError('invalid_payload');
  }
  return { createdAt: item.createdAt, id: item.id };
}

function validateScan(input: unknown): RetentionScanPayload {
  const value = record(input);
  const keys = Object.keys(value);
  if (keys.some((key) => key !== 'scan' && key !== 'sweep')) throw new JobError('invalid_payload');
  return {
    ...('scan' in value ? { scan: cursor(value.scan) } : {}),
    ...('sweep' in value ? { sweep: cursor(value.sweep) } : {}),
  };
}

function validatePurge(input: unknown): BlobPurgePayload {
  const value = record(input);
  const { after } = value;
  if (
    Object.keys(value).some((key) => key !== 'after') ||
    (after !== undefined && (typeof after !== 'string' || !HEX_64.test(after)))
  ) {
    throw new JobError('invalid_payload');
  }
  return after === undefined ? {} : { after: after as Sha256 };
}

function validatePoll(input: unknown): Record<string, never> {
  if (Object.keys(record(input)).length !== 0) throw new JobError('invalid_payload');
  return {};
}

function jobsOf(job: JobContext) {
  const jobs = job.ports.platform?.jobs;
  if (jobs === undefined) throw new JobError('handler_error');
  return jobs;
}

function unbound(
  name: string,
  validate: (input: unknown) => unknown,
  everySeconds: number,
): JobDefinition {
  return defineJob<unknown>({
    name,
    version: 1,
    schedule: { everySeconds },
    validate,
    async handler(_payload, context) {
      if (context.signal.aborted) return;
      throw new JobError('invalid_definition');
    },
  });
}

export const retentionScanJob = unbound('retention-scan', validateScan, 86400);
export const blobPurgeJob = unbound('blob-purge', validatePurge, 3600);
export const sourcePollJob = unbound('source-poll', validatePoll, 60);

async function remove(
  lifecycle: PurgeLifecycle,
  ctx: OrgContext,
  key: Sha256,
  generation: PurgeGeneration,
): Promise<void> {
  if ((await lifecycle.removeBytes(ctx, key, generation)) === 'refused') {
    await lifecycle.cancelPurge(ctx, key, generation);
  }
}

async function claimAndRemove(lifecycle: PurgeLifecycle, ctx: OrgContext, key: Sha256) {
  const generation = await lifecycle.claimPurge(ctx, key);
  if (generation !== null) await remove(lifecycle, ctx, key, generation);
}

export function createRetentionScanJob(deps: {
  readonly reader: RetentionReader;
  readonly lifecycle: RetentionLifecycle;
}): JobDefinition {
  const { reader, lifecycle } = deps;
  return defineJob<unknown>({
    ...retentionScanJob,
    validate: validateScan,
    async handler(input, job) {
      const payload = validateScan(input);
      const ctx = job.org;
      const both = Object.keys(payload).length === 0;
      const next: { scan?: RetentionCursor; sweep?: RetentionCursor } = {};

      if (both || payload.scan !== undefined) {
        const page = await reader.candidates(ctx, { limit: PAGE, after: payload.scan ?? null });
        const removedAt = job.ports.clock.now().toISOString();
        for (const item of page) {
          if (job.signal.aborted) return;
          const key = item.sha256 as Sha256;
          if (item.orphan) {
            if (await lifecycle.scheduleOrphan(ctx, key)) {
              await claimAndRemove(lifecycle, ctx, key);
            }
          } else {
            await lifecycle.softDelete(
              ctx,
              key,
              item.retentionDaysOverride === null
                ? { removedAt }
                : { removedAt, retentionDays: item.retentionDaysOverride },
            );
          }
        }
        const last = page[PAGE - 1];
        if (last !== undefined) next.scan = { createdAt: last.createdAt, id: last.id };
      }

      if (both || payload.sweep !== undefined) {
        const page = await reader.scheduledIneligible(ctx, {
          limit: PAGE,
          after: payload.sweep ?? null,
        });
        for (const item of page) {
          if (job.signal.aborted) return;
          await lifecycle.unschedule(ctx, item.sha256 as Sha256);
        }
        const last = page[PAGE - 1];
        if (last !== undefined) next.sweep = { createdAt: last.createdAt, id: last.id };
      }

      if (Object.keys(next).length > 0 && !job.signal.aborted) {
        await jobsOf(job).enqueue(ctx, RETENTION_SCAN, next, {
          idempotencyKey: await digest(['v1', 'retention-next', job.idempotencyKey, next]),
        });
      }
    },
  });
}

export function createBlobPurgeJob(deps: {
  readonly lifecycle: PurgeLifecycle;
  readonly staged?: Pick<ByteStore, 'listStaged' | 'discardStaged'>;
}): JobDefinition {
  const { lifecycle } = deps;
  return defineJob<unknown>({
    ...blobPurgeJob,
    validate: validatePurge,
    async handler(input, job) {
      const payload = validatePurge(input);
      const ctx = job.org;
      const keys = await lifecycle.listDue(ctx, { limit: PAGE, after: payload.after ?? null });
      for (const key of keys) {
        if (job.signal.aborted) return;
        await claimAndRemove(lifecycle, ctx, key);
      }
      if (deps.staged !== undefined && payload.after === undefined) {
        try {
          const cutoff = new Date(job.ports.clock.now().getTime() - 24 * 3600 * 1000).toISOString();
          const org = orgStorageSegment(ctx.orgId);
          for (const item of await deps.staged.listStaged(cutoff, `staging/${org}/`)) {
            if (job.signal.aborted) return;
            try {
              stagedStorageKey(item.handle);
            } catch {
              continue;
            }
            if (
              item.handle.startsWith(`staging/${org}/`) &&
              Date.parse(item.createdAt) < Date.parse(cutoff)
            ) {
              try {
                await deps.staged.discardStaged(item.handle);
              } catch {
                job.observability.counter('pb.blob.staging_sweep', {
                  outcome: 'error',
                  stage: 'discard',
                });
                job.observability.log({
                  level: 'warn',
                  event: 'staged_blob_sweep_failed',
                  stage: 'discard',
                });
              }
            }
          }
        } catch {
          job.observability.counter('pb.blob.staging_sweep', { outcome: 'error', stage: 'list' });
          job.observability.log({
            level: 'warn',
            event: 'staged_blob_sweep_failed',
            stage: 'list',
          });
        }
      }
      const last = keys[PAGE - 1];
      if (last !== undefined && !job.signal.aborted) {
        const next = { after: last };
        await jobsOf(job).enqueue(ctx, BLOB_PURGE, next, {
          idempotencyKey: await digest(['v1', 'purge-next', job.idempotencyKey, next]),
        });
      }
    },
  });
}

export function createSourcePollJob(deps: {
  readonly sources: Pick<SourceRepository, 'listDue' | 'deferPoll'>;
}): JobDefinition {
  return defineJob<unknown>({
    ...sourcePollJob,
    validate: validatePoll,
    async handler(input, job) {
      validatePoll(input);
      const ctx = job.org;
      for (const source of await deps.sources.listDue(ctx, PAGE)) {
        if (job.signal.aborted) return;
        if (source.nextPollAt === null) continue;
        try {
          const jobs = jobsOf(job);
          // A terminal match stays due and gets a fresh key on the next minute tick.
          const minute = job.ports.clock.now().toISOString().slice(0, 16);
          const dueMinute = source.nextPollAt.slice(0, 16);
          const enqueued = await jobs.enqueue(
            ctx,
            SOURCE_SYNC,
            { sourceId: source.id, reason: 'poll' },
            {
              idempotencyKey: await digest([
                'poll',
                source.id,
                dueMinute > minute ? dueMinute : minute,
              ]),
              resourceKey: `source:${source.id}`,
            },
          );
          if (!enqueued.created) {
            const existing = await jobs.get(ctx, enqueued.id);
            if (existing?.state !== 'queued' && existing?.state !== 'running') continue;
          }
          await deps.sources.deferPoll(ctx, source.id, source.nextPollAt);
        } catch {
          job.observability.counter('pb.source.poll_failure', undefined, 1);
        }
      }
    },
  });
}
