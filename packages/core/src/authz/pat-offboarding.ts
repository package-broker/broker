import { auditEvent, type AuditEvent } from '../audit/actions.js';
import type { OrgContext } from '../db/port.js';
import { isoTimestamp, isUlid, type Clock } from '../ids.js';
import { JobError, type Jobs } from '../platform/jobs.js';
import { registerCoreJob, type RegisteredCoreJob } from '../runtime/core-jobs.js';
import type { AdminLog } from './administration.js';

export type PatOffboardingCause = 'suspended' | 'membership_removed' | 'erased' | 'project_removed';

export interface PatOffboardingPayload {
  readonly userId: string;
  readonly cause: PatOffboardingCause;
  readonly cutoff: string;
  /** A selected PAT durably marked by the access-loss write. */
  readonly invalidatedTokenId?: string;
}

export type RevokePageOutcome =
  { readonly status: 'ok'; readonly revoked: readonly string[] } | 'lease_lost' | 'indeterminate';

export interface PatOffboardingStore {
  /** Grants of the organization at any level held by the user, created at or before `cutoff`. */
  holdsAnyGrant(ctx: OrgContext, userId: string, cutoff: string): Promise<boolean>;
  /** Ids of the user's live personal tokens created at or before `cutoff`, ordered by id. */
  candidates(
    ctx: OrgContext,
    input: {
      readonly userId: string;
      readonly cutoff: string;
      readonly limit: number;
      /** Only tokens bound to selected projects of which the user holds none. */
      readonly selectedOnly?: true;
      readonly invalidatedTokenId?: string;
    },
  ): Promise<readonly string[]>;
  /**
   * One batch that revokes the ids still live, stages `audits[i]` only for the id it carries,
   * and writes nothing unless the job still holds its lease. `revoked` lists the ids this call
   * changed.
   */
  revokePage(
    ctx: OrgContext,
    input: {
      readonly userId: string;
      readonly cutoff: string;
      readonly ids: readonly string[];
      readonly now: string;
      readonly opId: string;
      readonly lease: { readonly jobId: string; readonly fence: number };
      readonly audits: readonly AuditEvent[];
      readonly selectedOnly?: true;
      readonly invalidatedTokenId?: string;
    },
  ): Promise<RevokePageOutcome>;
}

export interface PatOffboardingDeps {
  readonly store: PatOffboardingStore;
  readonly clock: Clock;
  readonly ids: { ulid(): string };
  readonly log: AdminLog;
}

export const PAT_OFFBOARDING_JOB_TYPE = 'core:pat-offboarding:v1';
export const PAT_OFFBOARDING_PAGE_SIZE = 25;

const CAUSES: ReadonlySet<unknown> = new Set<PatOffboardingCause>([
  'suspended',
  'membership_removed',
  'erased',
  'project_removed',
]);
const CUTOFF = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !CUTOFF.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function validate(input: unknown): PatOffboardingPayload {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new JobError('invalid_payload');
  }
  const proto = Object.getPrototypeOf(input) as unknown;
  if (proto !== Object.prototype && proto !== null) throw new JobError('invalid_payload');
  const keys = Reflect.ownKeys(input);
  const record = input as Record<string, unknown>;
  const { userId, cause, cutoff, invalidatedTokenId } = record;
  const snapshot = keys.includes('invalidatedTokenId');
  if (
    keys.length !== (snapshot ? 4 : 3) ||
    (snapshot &&
      (cause !== 'project_removed' ||
        typeof invalidatedTokenId !== 'string' ||
        !isUlid(invalidatedTokenId))) ||
    typeof userId !== 'string' ||
    !isUlid(userId) ||
    !CAUSES.has(cause) ||
    !isCanonicalInstant(cutoff)
  ) {
    throw new JobError('invalid_payload');
  }
  return {
    userId,
    cause: cause as PatOffboardingCause,
    cutoff,
    ...(snapshot ? { invalidatedTokenId: invalidatedTokenId as string } : {}),
  };
}

export function createPatOffboardingJob(deps: PatOffboardingDeps): RegisteredCoreJob {
  const { store, clock, ids } = deps;

  function emit(entry: Readonly<Record<string, unknown>>): void {
    try {
      deps.log({ level: 'info', ...entry });
    } catch {
      // The revoke is already stored; a failing sink must not turn it into a retry.
    }
  }

  function auditsFor(
    tokenIds: readonly string[],
    cause: PatOffboardingCause,
    now: string,
    opId: string,
  ): AuditEvent[] {
    return tokenIds.map((tokenId) => {
      const built = auditEvent({
        id: ids.ulid(),
        now,
        action: 'token.revoke',
        actor: { type: 'system', id: null },
        context: { opId, requestId: opId, sourceIp: null, tokenSelector: null },
        target: { type: 'token', id: tokenId },
        projectId: null,
        changes: { cause: { new: cause } },
      });
      if (!built.ok) throw new TypeError('Invalid token revoke audit event');
      return built.event;
    });
  }

  return registerCoreJob({
    name: 'pat-offboarding',
    version: 1,
    maxAttempts: 5,
    validate,
    async handler(input, context) {
      const { userId, cause, cutoff, invalidatedTokenId } = input as PatOffboardingPayload;
      const org = context.org;
      const orgId = org.orgId;

      if (cause === 'membership_removed' && (await store.holdsAnyGrant(org, userId, cutoff))) {
        emit({
          event: 'token.offboarding_skipped',
          orgId,
          userId,
          cause,
          reason: 'still_member',
        });
        return;
      }

      const narrowing =
        cause === 'project_removed'
          ? ({
              selectedOnly: true,
              ...(invalidatedTokenId === undefined ? {} : { invalidatedTokenId }),
            } as const)
          : {};
      const submitted = new Set<string>();
      let revoked = 0;
      for (;;) {
        if (context.signal.aborted) throw new JobError('aborted');
        const page = await store.candidates(org, {
          userId,
          cutoff,
          limit: PAT_OFFBOARDING_PAGE_SIZE,
          ...narrowing,
        });
        if (page.length === 0) break;
        if (
          page.length > PAT_OFFBOARDING_PAGE_SIZE ||
          page.some((id) => typeof id !== 'string' || id === '' || submitted.has(id)) ||
          new Set(page).size !== page.length
        ) {
          throw new JobError('handler_error');
        }
        for (const id of page) submitted.add(id);

        const now = isoTimestamp(clock.now());
        const opId = ids.ulid();
        const outcome = await store.revokePage(org, {
          userId,
          cutoff,
          ids: page,
          now,
          opId,
          lease: { jobId: context.jobId, fence: context.fence },
          audits: auditsFor(page, cause, now, opId),
          ...narrowing,
        });
        if (outcome === 'lease_lost') throw new JobError('lease_lost');
        if (outcome === 'indeterminate') throw new JobError('handler_error');

        const asked = new Set(page);
        for (const tokenId of outcome.revoked) {
          if (!asked.has(tokenId)) continue;
          revoked += 1;
          emit({
            event: 'token.revoked',
            orgId,
            tokenId,
            kind: 'pat',
            via: 'offboarding',
            cause,
            actorUserId: null,
            jobId: context.jobId,
          });
        }
        if (page.length < PAT_OFFBOARDING_PAGE_SIZE) break;
      }
      emit({ event: 'token.offboarding_done', orgId, userId, cause, revoked });
    },
  });
}

export function enqueuePatOffboarding(
  jobs: Pick<Jobs, 'enqueue'>,
): (
  ctx: OrgContext,
  input: { readonly userId: string; readonly cause: PatOffboardingCause; readonly at: string },
) => Promise<void> {
  return async (ctx, { userId, cause, at }) => {
    const payload = validate({ userId, cause, cutoff: at });
    await jobs.enqueue(ctx, PAT_OFFBOARDING_JOB_TYPE, payload, {
      idempotencyKey: `pat-offboarding:${userId}:${cause}:${at}`,
      resourceKey: `user:${userId}`,
    });
  };
}

export function enqueueProjectRemovedPatOffboarding(
  jobs: Pick<Jobs, 'enqueue'>,
): (ctx: OrgContext, input: { readonly userId: string; readonly at: string }) => Promise<void> {
  const enqueue = enqueuePatOffboarding(jobs);
  return (ctx, { userId, at }) => enqueue(ctx, { userId, cause: 'project_removed', at });
}
