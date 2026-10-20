import type { OrgContext, OrgId, Statement } from '../db/port.js';
import type { Clock } from '../ids.js';
import {
  fenceKind,
  type FencedOutcome,
  type MutationFence,
  type TokenMutationFence,
} from '../authz/fence.js';
import { canonicalManifest, MAX_MANIFEST_BYTES, parseManifest, planHash } from './manifest.js';

export interface ImportRunJobPayload {
  readonly runId: string;
}

export const IMPORT_RUN_JOB = {
  apply: 'core:import-apply:v1',
  rollback: 'core:import-rollback:v1',
  resourceKey: (runId: string): string => `import:${runId}`,
  payload: (runId: string): ImportRunJobPayload => ({ runId }),
} as const;

export const IMPORT_VERIFICATION_JOB = {
  type: 'core:import-verify:v1',
  resourceKey: (runId: string): string => `${IMPORT_RUN_JOB.resourceKey(runId)}:verify`,
  payload: IMPORT_RUN_JOB.payload,
  idempotencyKey: (runId: string, requestId: string): string =>
    `${IMPORT_VERIFICATION_JOB.type}:${runId}:${requestId}`,
} as const;

/** Approval evidence permits at most one minute of clock skew. */
export function validImportApprovalTimestamp(value: string | null, nowMs: number): boolean {
  if (value === null) return false;
  const time = timestamp(value);
  return time !== null && time <= nowMs + 60_000;
}

export type ImportRunState =
  | 'planned'
  | 'applying'
  | 'failed'
  | 'applied'
  | 'verifying'
  | 'verified'
  | 'rolled_back'
  | 'cancelled';

export interface ImportRun {
  readonly id: string;
  readonly orgId: OrgId;
  readonly state: ImportRunState;
  readonly planHash: string | null;
  readonly approvedAt: string | null;
  readonly approvedByUserId: string | null;
  readonly acceptedAt: string | null;
  readonly beforeImageExpiresAt: string | null;
}

export interface ImportRunInput {
  readonly runId: string;
  readonly now: string;
  readonly audit: Statement;
  readonly idempotency?: Statement;
}

export interface ApproveRunInput extends ImportRunInput {
  readonly planHash: string;
}

export interface CreateRunInput {
  readonly manifest: unknown;
  readonly now: string;
  readonly audit: Statement;
  readonly idempotency?: Statement;
}

type CreateFence = MutationFence | TokenMutationFence;
export type ImportRunOperation =
  | 'createRun'
  | 'approveRun'
  | 'requestApply'
  | 'requestVerify'
  | 'cancelRun'
  | 'acceptRun'
  | 'requestRollback';

export type ImportRunWriteOutcome =
  | FencedOutcome
  | {
      readonly ok: false;
      readonly reason: 'not_found' | 'reauth_required';
    };

export interface ImportRunWrite extends ImportRunInput {
  /** Compare the entire observed transition predicate inside the fenced batch. */
  readonly expected: ImportRun;
  readonly approvedByUserId?: string;
  readonly approvedAt?: string;
  readonly credentialWindowUntil?: string;
}

export interface ImportRunCreateWrite extends Omit<CreateRunInput, 'manifest'> {
  readonly id: string;
  readonly sourceSystem: string;
  readonly manifest: string;
  readonly planHash: string;
  readonly plannedCount: number;
}

/**
 * All reads and writes are organization-scoped. inspect performs one visibility/authority read:
 * hidden, archived and foreign targets return run=null, including when permission is missing.
 * allowed requires org:import:write for creation and verification, org:import:approve otherwise;
 * reauthFresh is computed from the fence's live session using the shared reauth window.
 *
 * Every write rechecks visibility, live authority, session reauth (except creation), and expected
 * transition predicates on database time. It runs mutations, audit and optional idempotency in
 * one runFenced batch. No SQL or guard is constructed in this service.
 *
 * createRun stores a non-refetchable manifest blob and exactly one starter from the fence.
 * requestApply changes planned to applying and enqueues apply atomically; requestRollback only
 * enqueues rollback, without claiming completion or introducing a state outside the schema CHECK.
 * requestVerify changes applied to verifying or re-enqueues a stranded verifying run and enqueues verification atomically.
 * Job requests must refuse an already queued or running job. cancelRun changes planned to cancelled;
 * acceptRun sets accepted_at without changing before_image_expires_at or verified state.
 */
export interface ImportRunStore {
  inspect(
    ctx: OrgContext,
    fence: CreateFence,
    operation: ImportRunOperation,
    runId: string | null,
    now: string,
  ): Promise<{
    readonly run: ImportRun | null;
    readonly allowed: boolean;
    readonly reauthFresh: boolean;
  }>;
  createRun(
    ctx: OrgContext,
    fence: CreateFence,
    input: ImportRunCreateWrite,
  ): Promise<ImportRunWriteOutcome>;
  approveRun(
    ctx: OrgContext,
    fence: MutationFence,
    input: ImportRunWrite,
  ): Promise<ImportRunWriteOutcome>;
  requestApply(
    ctx: OrgContext,
    fence: MutationFence,
    input: ImportRunWrite,
  ): Promise<ImportRunWriteOutcome>;
  requestVerify(
    ctx: OrgContext,
    fence: MutationFence,
    input: ImportRunWrite,
  ): Promise<ImportRunWriteOutcome>;
  cancelRun(
    ctx: OrgContext,
    fence: MutationFence,
    input: ImportRunWrite,
  ): Promise<ImportRunWriteOutcome>;
  acceptRun(
    ctx: OrgContext,
    fence: MutationFence,
    input: ImportRunWrite,
  ): Promise<ImportRunWriteOutcome>;
  requestRollback(
    ctx: OrgContext,
    fence: MutationFence,
    input: ImportRunWrite,
  ): Promise<ImportRunWriteOutcome>;
}

export type ImportRunError =
  | 'not_found'
  | 'forbidden'
  | 'reauth_required'
  | 'not_approved'
  | 'conflict'
  | 'unavailable'
  | 'invalid_manifest'
  | 'invalid_time';
export type ImportRunResult<T = null> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ImportRunError };

export interface ImportRunService {
  createRun(
    ctx: OrgContext,
    fence: CreateFence,
    input: CreateRunInput,
  ): Promise<
    ImportRunResult<{
      readonly id: string;
      readonly planHash: string;
      readonly state: 'planned';
    }>
  >;
  approveRun(
    ctx: OrgContext,
    fence: MutationFence,
    input: ApproveRunInput,
  ): Promise<ImportRunResult>;
  requestApply(
    ctx: OrgContext,
    fence: MutationFence,
    input: ImportRunInput,
  ): Promise<ImportRunResult>;
  requestVerify(
    ctx: OrgContext,
    fence: MutationFence,
    input: ImportRunInput,
  ): Promise<ImportRunResult>;
  cancelRun(ctx: OrgContext, fence: MutationFence, input: ImportRunInput): Promise<ImportRunResult>;
  acceptRun(ctx: OrgContext, fence: MutationFence, input: ImportRunInput): Promise<ImportRunResult>;
  requestRollback(
    ctx: OrgContext,
    fence: MutationFence,
    input: ImportRunInput,
  ): Promise<ImportRunResult>;
}

function fail(error: ImportRunError): ImportRunResult<never> {
  return { ok: false, error };
}

function timestamp(value: string): number | null {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : null;
}

function outcome<T>(answer: ImportRunWriteOutcome, value: T): ImportRunResult<T> {
  if (answer.ok) return { ok: true, value };
  switch (answer.reason) {
    case 'not_found':
      return fail('not_found');
    case 'reauth_required':
      return fail('reauth_required');
    case 'authority':
      return fail('forbidden');
    case 'conflict':
    case 'collision':
      return fail('conflict');
    case 'unclassified':
    case 'indeterminate':
      return fail('unavailable');
  }
}

export function createImportRunService(deps: {
  readonly store: ImportRunStore;
  readonly ids: { ulid(): string };
  readonly clock: Clock;
}): ImportRunService {
  const { store, clock } = deps;

  async function transition(
    ctx: OrgContext,
    fence: MutationFence,
    operation: Exclude<ImportRunOperation, 'createRun'>,
    input: ImportRunInput,
    hash?: string,
  ): Promise<ImportRunResult> {
    if (fenceKind(fence) !== 'session')
      throw new TypeError('import operation requires a session fence');
    const time = timestamp(input.now);
    if (time === null) return fail('invalid_time');
    const access = await store.inspect(ctx, fence, operation, input.runId, input.now);
    const run = access.run;
    if (run === null || run.orgId !== ctx.orgId || run.id !== input.runId) return fail('not_found');
    if (!access.allowed) return fail('forbidden');
    if (!access.reauthFresh) return fail('reauth_required');
    if (
      operation === 'approveRun' &&
      !validImportApprovalTimestamp(input.now, clock.now().getTime())
    )
      return fail('invalid_time');
    if (
      operation === 'requestApply' &&
      !validImportApprovalTimestamp(run.approvedAt, clock.now().getTime())
    )
      return fail('not_approved');
    let extra: Partial<ImportRunWrite> = {};
    switch (operation) {
      case 'approveRun': {
        if (run.state !== 'planned' || run.approvedAt !== null || hash !== run.planHash)
          return fail('conflict');
        const until = time + 3_600_000;
        if (!Number.isFinite(new Date(until).getTime())) return fail('invalid_time');
        extra = {
          approvedByUserId: fence.userId,
          approvedAt: input.now,
          credentialWindowUntil: new Date(until).toISOString(),
        };
        break;
      }
      case 'requestApply':
      case 'cancelRun':
        if (run.state !== 'planned') return fail('conflict');
        break;
      case 'requestVerify':
        if (!['applied', 'verifying'].includes(run.state) || run.beforeImageExpiresAt !== null)
          return fail('conflict');
        break;
      case 'acceptRun':
        if (run.state !== 'verified' || run.acceptedAt !== null) return fail('conflict');
        break;
      case 'requestRollback': {
        if (!['failed', 'applied', 'verifying', 'verified'].includes(run.state))
          return fail('conflict');
        if (run.beforeImageExpiresAt !== null) {
          const expiry = timestamp(run.beforeImageExpiresAt);
          if (expiry === null || expiry <= time) return fail('conflict');
        }
        break;
      }
    }
    return outcome(
      await store[operation](ctx, fence, { ...input, expected: { ...run }, ...extra }),
      null,
    );
  }

  return {
    async createRun(ctx, fence, input) {
      const kind = fenceKind(fence);
      if (kind !== 'session' && kind !== 'token')
        throw new TypeError('import creation requires a session or token fence');
      if (kind === 'token' && (fence as TokenMutationFence).permission !== 'org:import:write') {
        throw new TypeError('import creation requires an import write fence');
      }
      if (timestamp(input.now) === null) return fail('invalid_time');
      const access = await store.inspect(ctx, fence, 'createRun', null, input.now);
      if (!access.allowed) return fail('forbidden');
      const parsed = parseManifest(input.manifest);
      if (!parsed.ok) return fail('invalid_manifest');
      const manifest = canonicalManifest(parsed.data);
      if (new TextEncoder().encode(manifest).byteLength > MAX_MANIFEST_BYTES)
        return fail('invalid_manifest');
      const hash = await planHash(parsed.data);
      const id = deps.ids.ulid();
      return outcome(
        await store.createRun(ctx, fence, {
          id,
          now: input.now,
          audit: input.audit,
          ...(input.idempotency === undefined ? {} : { idempotency: input.idempotency }),
          manifest,
          planHash: hash,
          sourceSystem: parsed.data.source_system,
          plannedCount: parsed.data.items.length,
        }),
        { id, planHash: hash, state: 'planned' as const },
      );
    },
    approveRun: (ctx, fence, input) => transition(ctx, fence, 'approveRun', input, input.planHash),
    requestApply: (ctx, fence, input) => transition(ctx, fence, 'requestApply', input),
    requestVerify: (ctx, fence, input) => transition(ctx, fence, 'requestVerify', input),
    cancelRun: (ctx, fence, input) => transition(ctx, fence, 'cancelRun', input),
    acceptRun: (ctx, fence, input) => transition(ctx, fence, 'acceptRun', input),
    requestRollback: (ctx, fence, input) => transition(ctx, fence, 'requestRollback', input),
  };
}
