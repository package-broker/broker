import { describe, expect, it, vi } from 'vitest';
import {
  mutationFence,
  systemMutationFence,
  type AuthenticatedActor,
  type MutationFence,
} from '../authz/fence.js';
import type { VisibilityStore, VisibilityWriteResult } from '../db/catalogue.js';
import { orgContext } from '../db/port.js';
import { createVisibilityService } from './visibility-service.js';

const ctx = orgContext('org-a');
const projectId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const sourceId = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const packageId = '01ARZ3NDEKTSV4RRFFQ69G5FAX';
const versionId = '01ARZ3NDEKTSV4RRFFQ69G5FAY';
const fence = mutationFence(
  { userId: 'actor-id', sessionId: 'session-id' } as AuthenticatedActor,
  {},
);
const inputs = {
  attachSource: { projectId, sourceId },
  detachSource: { projectId, sourceId },
  setPrecedence: { projectId, sourceId, precedence: 100 },
  setPackageFlag: { packageId, visibleToNewProjects: false },
  addPattern: { projectId, sourceId, pattern: 'private/*', effect: 'include' },
  removePattern: { projectId, sourceId, pattern: 'private/*' },
  addExplicit: { projectId, packageId },
  removeExplicit: { projectId, packageId },
  quarantineVersion: {
    versionId,
    reason: 'admin_quarantine',
    packageId,
    expectedStatus: 'active',
    manage: { kind: 'organization' },
    audit: {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAZ',
      occurredAt: '2026-01-01T00:00:00.000Z',
      action: 'version.state_change',
      actor: { type: 'user', id: fence.userId },
      target: { type: 'version', id: versionId },
      projectId: null,
      sourceIp: null,
      tokenSelector: null,
      payloadJson: '{}',
    },
  },
  releaseQuarantine: {
    versionId,
    packageId,
    expectedStatus: 'quarantined',
    manage: { kind: 'organization' },
    audit: {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAZ',
      occurredAt: '2026-01-01T00:00:00.000Z',
      action: 'version.state_change',
      actor: { type: 'user', id: fence.userId },
      target: { type: 'version', id: versionId },
      projectId: null,
      sourceIp: null,
      tokenSelector: null,
      payloadJson: '{}',
    },
  },
  tombstoneVersion: {
    versionId,
    reason: 'admin_tombstone',
    packageId,
    expectedStatus: 'active',
    manage: { kind: 'organization' },
    audit: {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAZ',
      occurredAt: '2026-01-01T00:00:00.000Z',
      action: 'version.state_change',
      actor: { type: 'user', id: fence.userId },
      target: { type: 'version', id: versionId },
      projectId: null,
      sourceIp: null,
      tokenSelector: null,
      payloadJson: '{}',
    },
  },
} as const;
const auditedActions = {
  attachSource: 'source.attach',
  detachSource: 'source.detach',
  setPrecedence: 'source.reorder',
  addPattern: 'source.update',
  removePattern: 'source.update',
} as const;
type Operation = Exclude<keyof VisibilityStore, 'setOrder'>;
const operations = Object.keys(inputs) as Operation[];

function setup(answer: VisibilityWriteResult = { ok: true, opId: 'operation-id' }) {
  const store = {
    ...Object.fromEntries(operations.map((op) => [op, vi.fn(async () => answer)])),
    setOrder: vi.fn(async () => answer),
  } as unknown as {
    [K in keyof VisibilityStore]: ReturnType<typeof vi.fn<VisibilityStore[K]>>;
  };
  const log = vi.fn();
  const service = createVisibilityService({ store, log });
  const call = (op: Operation, input: unknown = inputs[op], ...rawFence: unknown[]) =>
    service[op](
      ctx,
      (rawFence.length === 0 ? fence : rawFence[0]) as MutationFence,
      input as never,
      apiCall,
    );
  return { store, log, call, service };
}

describe('visibility administration', () => {
  it.each(operations)(
    '%s forwards the exact organization, fence and validated input',
    async (op) => {
      const { store, log, call } = setup();
      expect(await call(op)).toEqual({ ok: true, opId: 'operation-id' });
      expect(store[op]).toHaveBeenCalledExactlyOnceWith(ctx, fence, {
        ...inputs[op],
        ...(op in auditedActions
          ? {
              audit: {
                id: expect.stringMatching(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
                occurredAt: expect.stringMatching(/^\d{4}-.*Z$/),
                action: auditedActions[op as keyof typeof auditedActions],
                actor: { type: 'user', id: fence.userId },
                tokenSelector: null,
                sourceIp: null,
                target: { type: 'source', id: sourceId },
                projectId,
                payloadJson: JSON.stringify({ op_id: packageId, request_id: versionId }),
              },
              idempotency: apiCall.idempotency,
            }
          : {}),
      });
      expect(log).toHaveBeenCalledExactlyOnceWith({
        level: 'info',
        event: 'catalogue.visibility.changed',
        orgId: ctx.orgId,
        actorUserId: fence.userId,
        projectId: 'projectId' in inputs[op] ? projectId : null,
        operation: op,
        opId: 'operation-id',
      });
    },
  );

  it.each(operations)(
    '%s rejects absent, forged and non-session fences before storage',
    async (op) => {
      const { store, call } = setup();
      for (const raw of [
        undefined,
        null,
        {},
        { userId: fence.userId, sessionId: 'session-id' },
        systemMutationFence('purge', { id: 'job', owner: 'worker', fence: 1 }, {}),
      ]) {
        await expect(call(op, inputs[op], raw)).rejects.toThrow(TypeError);
      }
      expect(store[op]).not.toHaveBeenCalled();
    },
  );

  it.each(operations)('%s validates every id before storage', async (op) => {
    const { store, call } = setup();
    for (const key of Object.keys(inputs[op]).filter((key) => key.endsWith('Id'))) {
      for (const invalid of ['', ' ', 'other@example.invalid', null, 42]) {
        await expect(call(op, { ...inputs[op], [key]: invalid })).rejects.toThrow(TypeError);
      }
    }
    await expect(call(op, null)).rejects.toThrow(TypeError);
    expect(store[op]).not.toHaveBeenCalled();
  });

  it.each(['quarantineVersion', 'releaseQuarantine', 'tombstoneVersion'] as const)(
    '%s requires a valid package id before storage',
    async (op) => {
      const { store, log, call } = setup();
      for (const invalid of [undefined, '', ' ', 'invalid', null, 42]) {
        await expect(call(op, { ...inputs[op], packageId: invalid })).rejects.toThrow(
          'invalid visibility id',
        );
      }
      expect(store[op]).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    },
  );

  it('validates precedence, flags, effects, patterns and fixed status reasons before storage', async () => {
    const { store, call } = setup();
    for (const precedence of [-1, 10001, 0.5, NaN, Infinity, '100', null]) {
      for (const op of ['attachSource', 'setPrecedence'] as const) {
        await expect(call(op, { ...inputs[op], precedence })).rejects.toThrow(TypeError);
      }
    }
    for (const pattern of ['', 'a'.repeat(51), 'é', '[a]', '?', '*****', null, 42]) {
      for (const op of ['addPattern', 'removePattern'] as const) {
        await expect(call(op, { ...inputs[op], pattern })).rejects.toThrow(TypeError);
      }
    }
    await expect(call('addPattern', { ...inputs.addPattern, effect: 'allow' })).rejects.toThrow(
      TypeError,
    );
    await expect(call('setPackageFlag', { packageId, visibleToNewProjects: 1 })).rejects.toThrow(
      TypeError,
    );
    for (const op of ['quarantineVersion', 'tombstoneVersion'] as const) {
      await expect(call(op, { versionId, reason: 'digest_mismatch' })).rejects.toThrow(TypeError);
    }
    for (const mock of Object.values(store)) expect(mock).not.toHaveBeenCalled();
  });

  it.each([0, 10000])('accepts precedence boundary %i', async (precedence) => {
    const { call } = setup();
    for (const op of ['attachSource', 'setPrecedence'] as const) {
      expect(await call(op, { ...inputs[op], precedence })).toEqual({
        ok: true,
        opId: 'operation-id',
      });
    }
  });

  const refusals = {
    authority: 'forbidden',
    conflict: 'conflict',
    collision: 'collision',
    unclassified: 'unclassified',
    not_found: 'not_found',
    invalid_pattern: 'invalid_pattern',
    too_many_patterns: 'too_many_patterns',
    not_attached: 'not_attached',
    not_eligible: 'not_eligible',
  } as const;
  for (const [reason, error] of Object.entries(refusals)) {
    it.each(operations)(`%s preserves the ${reason} refusal without target details`, async (op) => {
      const { log, call } = setup({ ok: false, reason: reason as keyof typeof refusals });
      expect(await call(op)).toEqual({ ok: false, error });
      expect(log).toHaveBeenCalledExactlyOnceWith({
        level: 'info',
        event: 'catalogue.visibility.denied',
        orgId: ctx.orgId,
        actorUserId: fence.userId,
        projectId: 'projectId' in inputs[op] ? projectId : null,
        operation: op,
        opId: null,
      });
    });
  }

  it('does not swallow indeterminate or unknown store results or exceptions', async () => {
    for (const reason of ['indeterminate', 'future_reason']) {
      const { log, call } = setup({ ok: false, reason } as VisibilityWriteResult);
      await expect(call('attachSource')).rejects.toThrow('visibility write outcome is uncertain');
      expect(log).not.toHaveBeenCalled();
    }
    const { store, call, log } = setup();
    const error = new Error('storage failed');
    store.attachSource.mockRejectedValueOnce(error);
    await expect(call('attachSource')).rejects.toBe(error);
    expect(log).not.toHaveBeenCalled();
  });

  it('keeps extra request fields out of operational events', async () => {
    const { call, log } = setup();
    await call('setPackageFlag', {
      ...inputs.setPackageFlag,
      projectId: 'untrusted',
      key: 'private/key',
      pattern: 'secret/*',
      email: 'private@example.invalid',
    });
    expect(log.mock.calls[0]?.[0]).toEqual({
      level: 'info',
      event: 'catalogue.visibility.changed',
      orgId: ctx.orgId,
      actorUserId: fence.userId,
      projectId: null,
      operation: 'setPackageFlag',
      opId: 'operation-id',
    });
  });

  it('does not let logger failures change a stored outcome', async () => {
    const { call, log } = setup();
    log.mockImplementation(() => {
      throw new Error('sink failed');
    });
    expect(await call('addPattern')).toEqual({ ok: true, opId: 'operation-id' });
  });
});

const orderFence = mutationFence({ userId: projectId, sessionId: sourceId } as AuthenticatedActor, {
  project: 1,
});
const apiCall = {
  audit: { opId: packageId, requestId: versionId, sourceIp: null, tokenSelector: null },
  idempotency: {
    principalKey: `user:${projectId}`,
    key: 'order',
    route: '/sources/order',
    requestHash: 'a'.repeat(64),
    status: 204,
    responseJson: 'null',
    createdAt: '2026-10-19T00:00:00.000Z',
    expiresAt: '2026-10-20T00:00:00.000Z',
  },
};
describe('setOrder', () => {
  it.each([
    ['empty', []],
    ['non-ULID', ['invalid']],
    ['duplicate', [sourceId, sourceId]],
    ['non-array', null],
  ])('rejects %s sourceIds before storage', async (_, sourceIds) => {
    const { store, service } = setup();
    await expect(
      service.setOrder(ctx, orderFence, { projectId, sourceIds } as never, apiCall),
    ).rejects.toThrow(TypeError);
    expect(store.setOrder).not.toHaveBeenCalled();
  });
  it('rejects a missing revision, invalid project, input or audit before storage', async () => {
    const { store, service } = setup();
    await expect(
      service.setOrder(ctx, fence, { projectId, sourceIds: [sourceId] }, apiCall),
    ).rejects.toThrow(TypeError);
    await expect(
      service.setOrder(ctx, orderFence, { projectId: 'invalid', sourceIds: [sourceId] }, apiCall),
    ).rejects.toThrow(TypeError);
    await expect(service.setOrder(ctx, orderFence, null as never, apiCall)).rejects.toThrow(
      TypeError,
    );
    await expect(
      service.setOrder(
        ctx,
        orderFence,
        { projectId, sourceIds: [sourceId] },
        { audit: { ...apiCall.audit, requestId: 'invalid' } },
      ),
    ).rejects.toThrow(TypeError);
    expect(store.setOrder).not.toHaveBeenCalled();
  });
  it('rejects a non-session fence', async () => {
    const { store, service } = setup();
    await expect(
      service.setOrder(
        ctx,
        systemMutationFence(
          'purge',
          { id: 'job', owner: 'worker', fence: 1 },
          { project: 1 },
        ) as never,
        { projectId, sourceIds: [sourceId] },
        apiCall,
      ),
    ).rejects.toThrow(TypeError);
    expect(store.setOrder).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    'builds the catalogue event and forwards optional idempotency=%s',
    async (withIdempotency) => {
      const { store, service } = setup();
      const call = withIdempotency ? apiCall : { audit: apiCall.audit };
      expect(
        await service.setOrder(ctx, orderFence, { projectId, sourceIds: [sourceId] }, call),
      ).toEqual({ ok: true, opId: 'operation-id' });
      expect(store.setOrder).toHaveBeenCalledExactlyOnceWith(ctx, orderFence, {
        projectId,
        sourceIds: [sourceId],
        audit: {
          id: expect.stringMatching(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
          occurredAt: expect.stringMatching(/^\d{4}-.*Z$/),
          action: 'source.reorder',
          actor: { type: 'user', id: orderFence.userId },
          tokenSelector: null,
          sourceIp: null,
          target: { type: 'project', id: projectId },
          projectId,
          payloadJson: JSON.stringify({ op_id: packageId, request_id: versionId }),
        },
        ...(withIdempotency ? { idempotency: apiCall.idempotency } : {}),
      });
    },
  );
});

describe('visibility mutation audit context', () => {
  it.each(Object.keys(auditedActions) as (keyof typeof auditedActions)[])(
    '%s only takes audit and idempotency from ApiCall',
    async (operation) => {
      const { service, store } = setup();
      await service[operation](
        ctx,
        fence,
        {
          ...inputs[operation],
          audit: { action: 'forged' },
          idempotency: apiCall.idempotency,
        } as never,
        { audit: apiCall.audit },
      );
      const forwarded = store[operation].mock.calls[0]![2];
      expect(forwarded).not.toHaveProperty('idempotency');
      expect(forwarded.audit.action).toBe(auditedActions[operation]);
      expect(forwarded.audit.actor).toEqual({ type: 'user', id: fence.userId });
    },
  );
  it.each(Object.keys(auditedActions) as (keyof typeof auditedActions)[])(
    '%s requires a valid audit context before writing',
    async (operation) => {
      const { service, store } = setup();
      for (const call of [undefined, { audit: { ...apiCall.audit, requestId: 'invalid' } }]) {
        await expect(
          service[operation](ctx, fence, inputs[operation] as never, call as never),
        ).rejects.toThrow(TypeError);
      }
      expect(store[operation]).not.toHaveBeenCalled();
    },
  );
});
