import type { SourceErrorCode } from '../db/source.js';
import type { OrgContext } from '../db/port.js';
import { JobError, type JobAttemptOutcome, type JobErrorCode, type JobStatus } from './jobs.js';

export const JOB_LEASE_SECONDS = 60;
export const JOB_HEARTBEAT_SECONDS = 20;
export const JOB_HANDLER_BUDGET_SECONDS = 240;
export const JOB_RELEASE_DELAY_SECONDS = 60;
export const JOB_STATUS_HISTORY_LIMIT = 20;
export const JOB_REAP_PAGE_LIMIT = 50;

/** Same order as the job_attempt.outcome CHECK in migration 0006. */
export const JOB_ATTEMPT_OUTCOMES = Object.freeze([
  'running',
  'succeeded',
  'failed',
  'lease_expired',
  'released',
] as const satisfies readonly JobAttemptOutcome[]);

export interface JobEnqueue {
  // Used only when the row is created.
  readonly id: string;
  readonly type: string;
  readonly payloadJson: string;
  readonly idempotencyKey: string;
  readonly resourceKey: string | null;
  // null means DB now.
  readonly runAt: string | null;
  readonly maxAttempts: number;
  readonly projectId: string | null;
  // Verified token id; null for session, scheduler and core jobs.
  readonly initiatorTokenId: string | null;
}

export interface JobGuard {
  readonly id: string;
  // Per-claim ULID, never a process id.
  readonly owner: string;
  readonly fence: number;
}

export interface JobClaim extends JobGuard {
  readonly type: string;
  readonly payloadJson: string;
  readonly idempotencyKey: string;
  readonly resourceKey: string | null;
  readonly projectId: string | null;
  readonly initiatorTokenId: string | null;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly leaseUntil: string;
}

export type JobSettle =
  | { readonly outcome: 'succeeded' }
  | {
      readonly outcome: 'failed';
      readonly errorCode: JobErrorCode;
      readonly permanent: boolean;
      readonly syncError?: SourceErrorCode;
    }
  | { readonly outcome: 'released'; readonly delaySeconds: number };

export interface JobRepository {
  enqueue(
    ctx: OrgContext,
    row: JobEnqueue,
  ): Promise<{ readonly id: string; readonly created: boolean }>;
  status(ctx: OrgContext, id: string): Promise<JobStatus | null>;
  claim(
    ctx: OrgContext,
    owner: string,
    input: {
      readonly id?: string;
      readonly types: readonly string[];
      readonly leaseSeconds: number;
      readonly maxRunning: number;
    },
  ): Promise<JobClaim | null>;
  heartbeat(ctx: OrgContext, guard: JobGuard): Promise<void>;
  settle(ctx: OrgContext, guard: JobGuard, outcome: JobSettle): Promise<void>;
  reap(ctx: OrgContext, limit: number): Promise<number>;
}

export class StaleFenceError extends JobError {
  constructor() {
    super('lease_lost');
    this.name = 'StaleFenceError';
  }
}

export class IdempotencyConflictError extends JobError {
  constructor() {
    super('idempotency_conflict');
    this.name = 'IdempotencyConflictError';
  }
}
