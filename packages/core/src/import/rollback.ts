import { auditEvent, type AuditEvent } from '../audit/actions.js';
import type { DelegatedMutationFence } from '../authz/fence.js';
import type { OrgContext } from '../db/port.js';
import type { Clock } from '../ids.js';
import type { DelegatedFenceIssuer } from './apply.js';
import type { ImportRunJobPayload, ImportRunState } from './run-service.js';

export type ImportRollbackFailure = 'guard_failed' | 'conflict' | 'too_large';

export interface ImportRollbackPayload extends ImportRunJobPayload {
  /** The user who requested the rollback; the fence rechecks this user's live authority. */
  readonly requestedBy: string;
}

export type ImportRollbackResult =
  | { status: 'rolled_back'; counts: ImportRollbackCounts }
  | { status: 'failed'; reason: ImportRollbackFailure }
  | { status: 'not_rollbackable' };

export interface ImportRollbackCounts {
  restored: number;
  conflict: number;
  expired: number;
}

export interface ImportRollbackRun {
  readonly id: string;
  readonly state: ImportRunState;
  readonly approvedByUserId: string | null;
}

export interface ImportRollbackRef {
  readonly id: string;
  readonly runId: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly externalRef: string;
  readonly action: 'create' | 'update';
  readonly beforeImageJson: string | null;
  readonly contentHash: string | null;
  readonly publishedAtBasis: 'source_release' | 'packagist_added' | 'import_time' | null;
  readonly beforeImageExpiresAt: string | null;
  readonly conflictState: 'none' | 'changed_after_import' | 'resolved';
  readonly rolledBackAt: string | null;
}

export type ImportRollbackDomainValue = string | number | null | readonly string[];

export type ImportRollbackGuard =
  | { readonly kind: 'revision'; readonly revision: number }
  | {
      readonly kind: 'domain';
      readonly values: Readonly<Record<string, ImportRollbackDomainValue>>;
    };

export interface ImportRollbackLiveState {
  readonly exists: boolean;
  /** Hash of the live domain columns, computed the way the apply journal computed content_hash. */
  readonly contentHash: string | null;
  /** True while another row still points at the entity (attached project sources, grants, names). */
  readonly referenced: boolean;
  /** The row revision where the table has one, otherwise the live domain column values. */
  readonly guard: ImportRollbackGuard | null;
}

export type ImportRollbackAction =
  | {
      readonly kind: 'restore';
      readonly refId: string;
      readonly entityType: string;
      readonly entityId: string;
      readonly guard: ImportRollbackGuard;
      readonly domain: Readonly<Record<string, ImportRollbackDomainValue>>;
      readonly audit: AuditEvent;
    }
  | {
      readonly kind: 'delete';
      readonly refId: string;
      readonly entityType: string;
      readonly entityId: string;
      readonly guard: ImportRollbackGuard;
      readonly requireUnreferenced: true;
      readonly audit: AuditEvent;
    }
  | { readonly kind: 'conflict'; readonly refId: string }
  | { readonly kind: 'expired'; readonly refId: string };

export type ImportRollbackOutcome = 'restored' | 'conflict' | 'expired';

/**
 * Reads are organization-scoped, and the images they carry never leave this job.
 *
 * liveStates is aligned with its targets. The core job compares the live content hash with the
 * stored one only to decide the action; the batch itself is guarded by the action's guard token,
 * never by a hash computed in SQL.
 *
 * applyChunk runs one batch under a delegated fence whose approverUserId is the requesting user
 * and whose expected map holds the guard revision of each action keyed by entityId. In the batch it
 * checks, atomically: the requester's and approvedByUserId's live authority, the run state is one of
 * failed, applied, verifying or verified, the job lease, and no other rollback runs for the run. Per
 * restore or delete it requires the live row to still match its guard (revision, or the exact
 * domain values for tables without a revision) and to still exist. A delete additionally requires
 * an in-batch NOT EXISTS over every dependent. Any action whose condition fails is recorded as
 * conflict (changed_after_import), writes nothing and never cascades. A restore validates column
 * names against the store's own per-table allowlist, writes only those columns, and bumps
 * revision, updated_at and last_op_id. Only restored or deleted refs get rolled_back_at. The audit
 * of an action is persisted in the same batch if and only if that action's outcome is restored.
 * It returns one outcome per action, in order. 'too_large' means the batch exceeded the statement
 * or byte budget and nothing was written.
 *
 * finish guards only the lease and the run. A failed rollback keeps the prior run state
 * (failed, applied, verifying or verified) and records only last_error, so a retry resumes. A successful
 * one stores the counts on the run. Both persist the audits. While a rollback job holds the run,
 * verification refuses to start.
 */
export interface ImportRollbackStore {
  loadRun(ctx: OrgContext, runId: string): Promise<ImportRollbackRun | null>;
  rollbackRefs(ctx: OrgContext, runId: string): Promise<readonly ImportRollbackRef[]>;
  liveStates(
    ctx: OrgContext,
    targets: readonly { readonly entityType: string; readonly entityId: string }[],
  ): Promise<readonly ImportRollbackLiveState[]>;
  applyChunk(
    ctx: OrgContext,
    fence: DelegatedMutationFence,
    input: {
      readonly runId: string;
      readonly approvedByUserId: string;
      readonly actions: readonly ImportRollbackAction[];
      readonly now: string;
    },
  ): Promise<
    | { ok: true; outcomes: readonly ImportRollbackOutcome[] }
    | { ok: false; reason: 'guard' | 'conflict' | 'too_large' }
  >;
  finish(
    ctx: OrgContext,
    fence: DelegatedMutationFence,
    input: {
      readonly runId: string;
      readonly outcome: 'rolled_back' | { failed: ImportRollbackFailure };
      readonly counts: ImportRollbackCounts;
      readonly audits: readonly AuditEvent[];
      readonly now: string;
    },
  ): Promise<void>;
}

export interface ImportRollbackDeps {
  readonly store: ImportRollbackStore;
  readonly clock: Clock;
  readonly ids: { ulid(): string };
}

const ROLLBACKABLE: ReadonlySet<ImportRunState> = new Set([
  'failed',
  'applied',
  'verifying',
  'verified',
]);
const CHUNK_SIZE = 50;
const MAX_CHUNK_COST = 200;
const ORDER = [
  'version',
  'access_grant',
  'project_source',
  'registered_name',
  'source',
  'project',
  'role',
];
const NO_UPDATE_IMAGE: ReadonlySet<string> = new Set();
/** Import writes update images for versions only; every other type is created, never updated. */
const RESTORABLE_COLUMNS: Readonly<Record<string, ReadonlySet<string>>> = {
  version: new Set(['blob_id', 'published_at', 'status', 'metadata_json', 'published_at_basis']),
  project: new Set(['slug', 'name', 'status', 'token_max_scope', 'require_publish_approval']),
  role: NO_UPDATE_IMAGE,
  source: NO_UPDATE_IMAGE,
  registered_name: NO_UPDATE_IMAGE,
  project_source: NO_UPDATE_IMAGE,
  access_grant: NO_UPDATE_IMAGE,
};

function rank(entityType: string): number {
  const index = ORDER.indexOf(entityType);
  return index === -1 ? ORDER.length : index;
}

function domainValue(value: unknown): value is ImportRollbackDomainValue {
  return (
    value === null ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (Array.isArray(value) && value.every((entry) => typeof entry === 'string'))
  );
}

function domainOf(
  entityType: string,
  json: string | null,
): Record<string, ImportRollbackDomainValue> | null {
  const allowed = RESTORABLE_COLUMNS[entityType];
  if (json === null || allowed === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const domain: Record<string, ImportRollbackDomainValue> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!allowed.has(key)) continue;
    if (!domainValue(value)) return null;
    domain[key] = value;
  }
  return Object.keys(domain).length === 0 ? null : domain;
}

function expired(ref: ImportRollbackRef, run: ImportRollbackRun, nowMs: number): boolean {
  if (ref.beforeImageExpiresAt === null) return run.state === 'verified';
  const expiry = Date.parse(ref.beforeImageExpiresAt);
  return !Number.isFinite(expiry) || expiry <= nowMs;
}

function cost(action: ImportRollbackAction): number {
  switch (action.kind) {
    case 'restore':
      return 2 + Object.keys(action.domain).length;
    case 'delete':
      return 3;
    default:
      return 1;
  }
}

function budgeted(actions: readonly ImportRollbackAction[]): ImportRollbackAction[][] {
  const batches: ImportRollbackAction[][] = [];
  let current: ImportRollbackAction[] = [];
  let spent = 0;
  for (const action of actions) {
    if (current.length > 0 && spent + cost(action) > MAX_CHUNK_COST) {
      batches.push(current);
      current = [];
      spent = 0;
    }
    current.push(action);
    spent += cost(action);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export async function runImportRollback(
  deps: ImportRollbackDeps,
  ctx: OrgContext,
  payload: ImportRollbackPayload,
  fences: DelegatedFenceIssuer,
): Promise<ImportRollbackResult> {
  const { store } = deps;
  const requester = payload.requestedBy;
  if (typeof requester !== 'string' || requester === '') return { status: 'not_rollbackable' };
  const run = await store.loadRun(ctx, payload.runId);
  if (
    run === null ||
    run.id !== payload.runId ||
    !ROLLBACKABLE.has(run.state) ||
    run.approvedByUserId === null
  )
    return { status: 'not_rollbackable' };
  const approver = run.approvedByUserId;
  const counts: ImportRollbackCounts = { restored: 0, conflict: 0, expired: 0 };

  const audit = (
    target: { type: string; id: string },
    changes: NonNullable<Parameters<typeof auditEvent>[0]['changes']>,
    now: string,
  ): AuditEvent | null => {
    const built = auditEvent({
      id: deps.ids.ulid(),
      now,
      action: 'import_run.rollback',
      actor: { type: 'user', id: requester },
      target,
      projectId: null,
      changes,
      context: { opId: run.id, requestId: run.id, sourceIp: null, tokenSelector: null },
    });
    return built.ok ? built.event : null;
  };
  const summary = (state: 'rolled_back' | 'failed', now: string): readonly AuditEvent[] => {
    const event = audit(
      { type: 'import_run', id: run.id },
      {
        state: { new: state },
        restored: { new: counts.restored },
        conflict: { new: counts.conflict },
        expired: { new: counts.expired },
      },
      now,
    );
    return event === null ? [] : [event];
  };
  const fail = async (reason: ImportRollbackFailure): Promise<ImportRollbackResult> => {
    const now = deps.clock.now().toISOString();
    await store.finish(ctx, fences(requester, run.id, {}), {
      runId: run.id,
      outcome: { failed: reason },
      counts,
      audits: summary('failed', now),
      now,
    });
    return { status: 'failed', reason };
  };

  const loaded = await store.rollbackRefs(ctx, run.id);
  if (loaded.some((ref) => ref.runId !== run.id)) return fail('conflict');
  const refs = [...loaded].sort(
    (a, b) => rank(a.entityType) - rank(b.entityType) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );
  const pending: ImportRollbackRef[] = [];
  for (const ref of refs) {
    if (ref.rolledBackAt !== null) counts.restored += 1;
    else if (ref.conflictState === 'changed_after_import') counts.conflict += 1;
    else pending.push(ref);
  }

  const decide = (
    ref: ImportRollbackRef,
    live: ImportRollbackLiveState | undefined,
    nowMs: number,
  ): ImportRollbackAction => {
    if (expired(ref, run, nowMs)) return { kind: 'expired', refId: ref.id };
    const conflict: ImportRollbackAction = { kind: 'conflict', refId: ref.id };
    if (
      live === undefined ||
      !live.exists ||
      live.guard === null ||
      ref.contentHash === null ||
      live.contentHash !== ref.contentHash
    )
      return conflict;
    const at = new Date(nowMs).toISOString();
    const target = { type: ref.entityType, id: ref.entityId };
    if (ref.action === 'create') {
      if (live.referenced) return conflict;
      const event = audit(target, { state: { new: 'deleted' } }, at);
      return event === null
        ? conflict
        : {
            kind: 'delete',
            refId: ref.id,
            entityType: ref.entityType,
            entityId: ref.entityId,
            guard: live.guard,
            requireUnreferenced: true,
            audit: event,
          };
    }
    const domain = domainOf(ref.entityType, ref.beforeImageJson);
    const event = domain === null ? null : audit(target, { state: { new: 'restored' } }, at);
    return domain === null || event === null
      ? conflict
      : {
          kind: 'restore',
          refId: ref.id,
          entityType: ref.entityType,
          entityId: ref.entityId,
          guard: live.guard,
          domain,
          audit: event,
        };
  };

  const submit = async (
    actions: readonly ImportRollbackAction[],
  ): Promise<readonly ImportRollbackOutcome[] | ImportRollbackFailure> => {
    const expected: Record<string, number> = {};
    for (const action of actions) {
      if (
        (action.kind === 'restore' || action.kind === 'delete') &&
        action.guard.kind === 'revision'
      )
        expected[action.entityId] = action.guard.revision;
    }
    const result = await store.applyChunk(ctx, fences(requester, run.id, expected), {
      runId: run.id,
      approvedByUserId: approver,
      actions,
      now: deps.clock.now().toISOString(),
    });
    if (result.ok) return result.outcomes.length === actions.length ? result.outcomes : 'conflict';
    if (result.reason === 'too_large') {
      if (actions.length === 1) return 'too_large';
      const middle = Math.ceil(actions.length / 2);
      const first = await submit(actions.slice(0, middle));
      if (typeof first === 'string') return first;
      for (const outcome of first) counts[outcome] += 1;
      return submit(actions.slice(middle));
    }
    return result.reason === 'guard' ? 'guard_failed' : 'conflict';
  };

  for (let offset = 0; offset < pending.length;) {
    const type = pending[offset]!.entityType;
    const chunk: ImportRollbackRef[] = [];
    while (
      offset < pending.length &&
      chunk.length < CHUNK_SIZE &&
      pending[offset]!.entityType === type
    )
      chunk.push(pending[offset++]!);
    const nowMs = deps.clock.now().getTime();
    const states = await store.liveStates(
      ctx,
      chunk.map((ref) => ({ entityType: ref.entityType, entityId: ref.entityId })),
    );
    const actions = chunk.map((ref, index) => decide(ref, states[index], nowMs));
    for (const batch of budgeted(actions)) {
      const outcomes = await submit(batch);
      if (typeof outcomes === 'string') return fail(outcomes);
      for (const outcome of outcomes) counts[outcome] += 1;
    }
  }

  const now = deps.clock.now().toISOString();
  const events = summary('rolled_back', now);
  if (events.length === 0) return fail('conflict');
  await store.finish(ctx, fences(requester, run.id, {}), {
    runId: run.id,
    outcome: 'rolled_back',
    counts,
    audits: events,
    now,
  });
  return { status: 'rolled_back', counts };
}
