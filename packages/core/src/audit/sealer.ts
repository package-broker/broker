import type { OrgContext } from '../db/port.js';
import { JobError, type JobDefinition, type CoreJobs as Jobs } from '../platform/jobs.js';

export type AuditIntegrityReason = 'seq_gap' | 'head_mismatch' | 'boundary_mismatch';

/** A seal call failed after integrity evidence for these reasons was already committed. */
export class AuditSealInterruptedError extends Error {
  constructor(
    readonly integrity: readonly AuditIntegrityReason[],
    options?: { readonly cause?: unknown },
  ) {
    super('audit seal interrupted after recording integrity evidence', options);
    this.name = 'AuditSealInterruptedError';
  }
}

export type SealOutcome = {
  readonly repaired?: true;
  readonly integrity?: readonly AuditIntegrityReason[];
} & (
  | {
      readonly outcome: 'sealed';
      readonly sealed: number;
      readonly headSeq: number;
      readonly headHash: string;
    }
  | { readonly outcome: 'empty' }
  | { readonly outcome: 'contended' }
  | { readonly outcome: 'restore_pending' }
);

export interface AuditSealPort {
  seal(ctx: OrgContext, limit?: number): Promise<SealOutcome>;
  pendingOldestAgeSeconds(ctx: OrgContext): Promise<number>;
}

const JOB_TYPE = 'core:audit-seal:v1';
const MAX_ROUNDS = 10;
const CONTENTION_THRESHOLD = 3;
type EmptyPayload = Record<string, never>;

export function auditSealJob(
  port: AuditSealPort,
): JobDefinition & Pick<JobDefinition<EmptyPayload>, 'validate'> {
  const contention = new Map<string, number>();
  return {
    name: 'audit-seal',
    version: 1,
    schedule: { everySeconds: 60 },
    maxAttempts: 3,
    validate(input) {
      if (
        typeof input !== 'object' ||
        input === null ||
        (Object.getPrototypeOf(input) !== Object.prototype &&
          Object.getPrototypeOf(input) !== null) ||
        Reflect.ownKeys(input).length !== 0
      ) {
        throw new JobError('invalid_payload');
      }
      return {};
    },
    async handler(_payload, ctx) {
      const reportIntegrity = (reasons: readonly AuditIntegrityReason[]): void => {
        for (const reason of reasons) {
          ctx.observability.log({ level: 'error', event: 'audit.chain_integrity', reason });
          ctx.observability.counter('pb.audit.chain_integrity');
        }
      };
      let sealed = 0;
      let rounds = 0;
      try {
        if (!ctx.signal.aborted) {
          try {
            ctx.observability.histogram(
              'pb.audit.pending_oldest_age',
              await port.pendingOldestAgeSeconds(ctx.org),
            );
          } catch {
            ctx.observability.counter('pb.audit.pending_age_error');
          }
        }
        for (let round = 0; round < MAX_ROUNDS && !ctx.signal.aborted; round += 1) {
          let result: SealOutcome;
          try {
            result = await port.seal(ctx.org);
          } catch (error) {
            if (error instanceof AuditSealInterruptedError) reportIntegrity(error.integrity);
            throw error;
          }
          reportIntegrity(result.integrity ?? []);
          if (result.repaired) {
            ctx.observability.log({ level: 'warn', event: 'audit.seal_repaired' });
            ctx.observability.counter('pb.audit.seal_repaired');
          }
          if (result.outcome === 'contended') {
            ctx.observability.counter('audit_seal_contended_total');
            const consecutive = Math.min(
              (contention.get(ctx.org.orgId) ?? 0) + 1,
              CONTENTION_THRESHOLD,
            );
            contention.set(ctx.org.orgId, consecutive);
            if (consecutive >= CONTENTION_THRESHOLD) {
              ctx.observability.log({ level: 'warn', event: 'audit.seal.contended' });
            }
            break;
          }
          contention.delete(ctx.org.orgId);
          if (result.outcome === 'restore_pending') {
            ctx.observability.counter('pb.audit.seal_restore_pending');
            break;
          }
          if (result.outcome === 'empty') break;
          sealed += result.sealed;
          rounds += 1;
        }
      } finally {
        ctx.observability.counter('audit_sealed_total', undefined, sealed);
        ctx.observability.counter('audit_seal_rounds_total', undefined, rounds);
      }
      if (rounds > 0) {
        ctx.observability.log({ level: 'info', event: 'audit.sealed' });
      }
    },
  };
}

export async function requestAuditSeal(jobs: Jobs, ctx: OrgContext, now: Date): Promise<boolean> {
  try {
    await jobs.enqueue(
      ctx,
      JOB_TYPE,
      {},
      {
        idempotencyKey: `audit-seal:${now.toISOString().slice(0, 16)}`,
        resourceKey: 'audit-seal',
      },
    );
    return true;
  } catch {
    return false;
  }
}
