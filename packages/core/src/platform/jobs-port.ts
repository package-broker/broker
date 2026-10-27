import type { OrgContext } from '../db/port.js';
import type { Clock } from '../ids.js';
import type { JobEnqueue } from './job-repository.js';
import {
  assertJobOwnedBy,
  canonicalPayload,
  DEFAULT_MAX_ATTEMPTS,
  JobError,
  normalizeRunAt,
  parseQualifiedJobName,
  qualifyJobName,
  storedIdempotencyKey,
  type EnqueueInput,
  type JobDefinition,
  type JobStatus,
  type Jobs,
} from './jobs.js';

export const MAX_RUN_AT_AHEAD_SECONDS = 30 * 24 * 60 * 60;

const CORE_OWNER = 'core';

export interface JobStore {
  enqueue(
    ctx: OrgContext,
    row: JobEnqueue,
  ): Promise<{ readonly id: string; readonly created: boolean }>;
  status(ctx: OrgContext, id: string): Promise<JobStatus | null>;
  notify?(ctx: OrgContext, id: string): Promise<void>;
}

export interface JobInitiator {
  readonly projectId: string | null;
  /** Verified token id from the authorization decision; null for sessions, init and jobs. */
  readonly tokenId: string | null;
}

export interface RepositoryJobsInput {
  readonly store: JobStore;
  readonly jobs: readonly { readonly qualifiedName: string; readonly definition: JobDefinition }[];
  readonly clock: Clock;
  readonly ids: { ulid(): string };
}

export type JobsFactory = (pluginId: string, initiator: JobInitiator) => Jobs;

function assertOwner(owner: string, type: string): void {
  if (owner === CORE_OWNER) {
    if (parseQualifiedJobName(type).pluginId !== CORE_OWNER) throw new JobError('invalid_name');
    return;
  }
  assertJobOwnedBy(owner, type);
}

function owns(owner: string, type: string): boolean {
  try {
    assertOwner(owner, type);
    return true;
  } catch {
    return false;
  }
}

function isThenable(value: unknown): value is { then: unknown; catch?: unknown } {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function validatePayload(definition: JobDefinition, payloadJson: string): void {
  let thenable: boolean;
  try {
    const result = definition.validate(JSON.parse(payloadJson) as unknown);
    thenable = isThenable(result);
    if (thenable) Promise.resolve(result).catch(() => undefined);
  } catch (error) {
    if (error instanceof JobError) throw error;
    throw new JobError('invalid_payload');
  }
  if (thenable) throw new JobError('invalid_payload');
}

function readEnqueueInput(value: unknown): {
  readonly idempotencyKey: string;
  readonly resourceKey: string | undefined;
  readonly runAt: string | undefined;
} {
  if (typeof value !== 'object' || value === null) throw new JobError('invalid_idempotency_key');
  const { idempotencyKey, resourceKey, runAt } = value as EnqueueInput;
  return { idempotencyKey, resourceKey, runAt };
}

function resolveRunAt(runAt: string | undefined, clock: Clock): string | null {
  if (runAt === undefined) return null;
  const normalized = normalizeRunAt(runAt);
  const horizon = clock.now().getTime() + MAX_RUN_AT_AHEAD_SECONDS * 1000;
  if (Date.parse(normalized) > horizon) throw new JobError('invalid_run_at');
  return normalized;
}

export function createRepositoryJobs(input: RepositoryJobsInput): JobsFactory {
  const { store, clock, ids } = input;
  const definitions = new Map<string, JobDefinition>();
  for (const job of input.jobs) {
    if (definitions.has(job.qualifiedName)) throw new JobError('invalid_definition');
    definitions.set(job.qualifiedName, job.definition);
  }

  return (pluginId, initiator) => {
    if (pluginId !== CORE_OWNER) qualifyJobName(pluginId, 'job', 1);
    const { projectId, tokenId } = initiator;

    return Object.freeze({
      async enqueue(ctx, type, payload, rawInput) {
        assertOwner(pluginId, type);
        const definition = definitions.get(type);
        if (definition === undefined) throw new JobError('unknown_job_type');
        const payloadJson = canonicalPayload(payload);
        validatePayload(definition, payloadJson);
        const enqueueInput = readEnqueueInput(rawInput);
        const row: JobEnqueue = {
          payloadJson,
          idempotencyKey: storedIdempotencyKey(type, enqueueInput.idempotencyKey),
          runAt: resolveRunAt(enqueueInput.runAt, clock),
          resourceKey: enqueueInput.resourceKey ?? null,
          maxAttempts: definition.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
          type,
          id: ids.ulid(),
          projectId,
          initiatorTokenId: tokenId,
        };
        return store.enqueue(ctx, row);
      },
      async get(ctx, id) {
        const status = await store.status(ctx, id);
        if (status === null || !owns(pluginId, status.type)) return null;
        return status;
      },
      async notify(ctx, id) {
        try {
          const status = await store.status(ctx, id);
          if (status === null || !owns(pluginId, status.type) || status.state !== 'queued') return;
          await store.notify?.(ctx, id);
        } catch {
          // A lost wake-up leaves the committed row for the cron sweep.
        }
      },
    } satisfies Jobs);
  };
}
