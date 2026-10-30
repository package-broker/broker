import type { ApiCall } from '../api/idempotency.js';
import { auditEvent } from '../audit/actions.js';
import type { AdminLog } from '../authz/administration.js';
import { fenceKind, type MutationFence } from '../authz/fence.js';
import type { VisibilityStore, VisibilityWriteResult } from '../db/catalogue.js';
import type { OrgContext } from '../db/port.js';
import { isUlid, ulid } from '../ids.js';
import { isValidPattern } from './patterns.js';

export type VisibilityResult =
  | { readonly ok: true; readonly opId: string }
  | {
      readonly ok: false;
      readonly error:
        | 'forbidden'
        | 'collision'
        | 'unclassified'
        | 'not_found'
        | 'conflict'
        | 'invalid_pattern'
        | 'too_many_patterns'
        | 'not_attached'
        | 'not_eligible';
    };

type Operation = keyof VisibilityStore;
type AuditedOperation =
  'attachSource' | 'detachSource' | 'setPrecedence' | 'setOrder' | 'addPattern' | 'removePattern';
type Input<K extends Operation> = K extends AuditedOperation
  ? Omit<Parameters<VisibilityStore[K]>[2], 'audit' | 'idempotency'>
  : Parameters<VisibilityStore[K]>[2];
export type VisibilityService = {
  [K in Operation]: (
    ctx: OrgContext,
    fence: MutationFence,
    input: Input<K>,
    ...call: K extends AuditedOperation ? [call: ApiCall] : []
  ) => Promise<VisibilityResult>;
};

const ID_FIELDS = {
  attachSource: ['projectId', 'sourceId'],
  detachSource: ['projectId', 'sourceId'],
  setPrecedence: ['projectId', 'sourceId'],
  setOrder: ['projectId'],
  setPackageFlag: ['packageId'],
  addPattern: ['projectId', 'sourceId'],
  removePattern: ['projectId', 'sourceId'],
  addExplicit: ['projectId', 'packageId'],
  removeExplicit: ['projectId', 'packageId'],
  quarantineVersion: ['versionId', 'packageId'],
  releaseQuarantine: ['versionId', 'packageId'],
  tombstoneVersion: ['versionId', 'packageId'],
} as const satisfies Record<Operation, readonly string[]>;

function validate(operation: Operation, input: unknown): asserts input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null) throw new TypeError('invalid visibility input');
  const fields = input as Record<string, unknown>;
  for (const key of ID_FIELDS[operation]) {
    if (typeof fields[key] !== 'string' || !isUlid(fields[key])) {
      throw new TypeError('invalid visibility id');
    }
  }
  if (operation === 'setOrder') {
    const ids = fields['sourceIds'];
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.some((id: unknown) => typeof id !== 'string' || !isUlid(id)) ||
      new Set(ids).size !== ids.length
    )
      throw new TypeError('invalid visibility order');
  }
  if (
    operation === 'setPrecedence' ||
    (operation === 'attachSource' && fields['precedence'] !== undefined)
  ) {
    const value = fields['precedence'];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 10000) {
      throw new TypeError('invalid visibility precedence');
    }
  }
  if (operation === 'addPattern' || operation === 'removePattern') {
    const pattern = fields['pattern'];
    if (typeof pattern !== 'string' || !isValidPattern(pattern)) {
      throw new TypeError('invalid visibility pattern');
    }
  }
  if (
    operation === 'addPattern' &&
    fields['effect'] !== 'include' &&
    fields['effect'] !== 'exclude'
  ) {
    throw new TypeError('invalid visibility effect');
  }
  if (operation === 'setPackageFlag' && typeof fields['visibleToNewProjects'] !== 'boolean') {
    throw new TypeError('invalid visibility flag');
  }
  if (
    (operation === 'quarantineVersion' && fields['reason'] !== 'admin_quarantine') ||
    (operation === 'tombstoneVersion' && fields['reason'] !== 'admin_tombstone')
  ) {
    throw new TypeError('invalid visibility status reason');
  }
}

function outcome(answer: VisibilityWriteResult): VisibilityResult {
  if (answer.ok) return { ok: true, opId: answer.opId };
  const reason = answer.reason;
  switch (reason) {
    case 'authority':
      return { ok: false, error: 'forbidden' };
    case 'publish_gate':
    case 'conflict':
      return { ok: false, error: 'conflict' };
    case 'collision':
      return { ok: false, error: 'collision' };
    case 'unclassified':
      return { ok: false, error: 'unclassified' };
    case 'not_found':
      return { ok: false, error: 'not_found' };
    case 'invalid_pattern':
      return { ok: false, error: 'invalid_pattern' };
    case 'too_many_patterns':
      return { ok: false, error: 'too_many_patterns' };
    case 'not_attached':
      return { ok: false, error: 'not_attached' };
    case 'not_eligible':
      return { ok: false, error: 'not_eligible' };
    case 'indeterminate':
      throw new Error('visibility write outcome is uncertain');
    default: {
      const exhaustive: never = reason;
      void exhaustive;
      throw new Error('visibility write outcome is uncertain');
    }
  }
}

export function createVisibilityService(deps: {
  readonly store: VisibilityStore;
  readonly log: AdminLog;
}): VisibilityService {
  async function execute<K extends Operation>(
    operation: K,
    ctx: OrgContext,
    fence: MutationFence,
    input: Parameters<VisibilityStore[K]>[2],
    write: VisibilityStore[K],
  ): Promise<VisibilityResult> {
    if (fenceKind(fence) !== 'session') throw new TypeError('visibility requires a session fence');
    validate(operation, input);
    const result = outcome(await write.call(deps.store, ctx, fence, input as never));
    try {
      deps.log({
        level: 'info',
        event: result.ok ? 'catalogue.visibility.changed' : 'catalogue.visibility.denied',
        orgId: ctx.orgId,
        actorUserId: fence.userId,
        projectId:
          ID_FIELDS[operation].some((field) => field === 'projectId') && 'projectId' in input
            ? input.projectId
            : null,
        operation,
        opId: result.ok ? result.opId : null,
      });
    } catch {
      // Sink failure must not change the stored outcome.
    }
    return result;
  }

  async function audited<K extends AuditedOperation>(
    operation: K,
    ctx: OrgContext,
    fence: MutationFence,
    input: Input<K>,
    call: ApiCall,
  ): Promise<VisibilityResult> {
    if (fenceKind(fence) !== 'session') throw new TypeError('visibility requires a session fence');
    validate(operation, input);
    if (operation === 'setOrder' && fence.expected['project'] === undefined) {
      throw new TypeError('fence must carry an expected project revision');
    }
    const action = {
      attachSource: 'source.attach',
      detachSource: 'source.detach',
      setPrecedence: 'source.reorder',
      setOrder: 'source.reorder',
      addPattern: 'source.update',
      removePattern: 'source.update',
    } as const;
    const extraFields = {
      attachSource: ['precedence'],
      detachSource: [],
      setPrecedence: ['precedence'],
      setOrder: ['sourceIds'],
      addPattern: ['pattern', 'effect'],
      removePattern: ['pattern'],
    } as const;
    const fields = input as Record<string, unknown>;
    const cleanInput = Object.fromEntries(
      [...ID_FIELDS[operation], ...extraFields[operation]]
        .filter((field) => Object.hasOwn(fields, field))
        .map((field) => [field, fields[field]]),
    );
    const event = auditEvent({
      id: ulid(),
      now: new Date().toISOString(),
      action: action[operation],
      actor: { type: 'user', id: fence.userId },
      context: call.audit,
      target:
        operation !== 'setOrder'
          ? { type: 'source', id: cleanInput['sourceId'] as string }
          : { type: 'project', id: input.projectId },
      projectId: input.projectId,
    });
    if (!event.ok) throw new TypeError('invalid visibility audit event');
    return execute(
      operation,
      ctx,
      fence,
      {
        ...cleanInput,
        audit: event.event,
        ...(call.idempotency === undefined ? {} : { idempotency: call.idempotency }),
      } as Parameters<VisibilityStore[K]>[2],
      deps.store[operation],
    );
  }

  return {
    attachSource: (ctx, fence, input, call) => audited('attachSource', ctx, fence, input, call),
    detachSource: (ctx, fence, input, call) => audited('detachSource', ctx, fence, input, call),
    setPrecedence: (ctx, fence, input, call) => audited('setPrecedence', ctx, fence, input, call),
    setOrder: (ctx, fence, input, call) => audited('setOrder', ctx, fence, input, call),
    setPackageFlag: (ctx, fence, input) =>
      execute('setPackageFlag', ctx, fence, input, deps.store.setPackageFlag),
    addPattern: (ctx, fence, input, call) => audited('addPattern', ctx, fence, input, call),
    removePattern: (ctx, fence, input, call) => audited('removePattern', ctx, fence, input, call),
    addExplicit: (ctx, fence, input) =>
      execute('addExplicit', ctx, fence, input, deps.store.addExplicit),
    removeExplicit: (ctx, fence, input) =>
      execute('removeExplicit', ctx, fence, input, deps.store.removeExplicit),
    quarantineVersion: (ctx, fence, input) =>
      execute('quarantineVersion', ctx, fence, input, deps.store.quarantineVersion),
    releaseQuarantine: (ctx, fence, input) =>
      execute('releaseQuarantine', ctx, fence, input, deps.store.releaseQuarantine),
    tombstoneVersion: (ctx, fence, input) =>
      execute('tombstoneVersion', ctx, fence, input, deps.store.tombstoneVersion),
  };
}
