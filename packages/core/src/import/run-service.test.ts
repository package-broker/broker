import { describe, expect, it, vi } from 'vitest';
import {
  mutationFence,
  tokenMutationFence,
  type AuthenticatedActor,
  type AuthenticatedTokenActor,
  type MutationFence,
} from '../authz/fence.js';
import { orgContext } from '../db/port.js';
import { parseManifest, planHash } from './manifest.js';
import { createImportRunService, type ImportRun, type ImportRunStore } from './run-service.js';

const ctx = orgContext('org');
const now = '2026-10-18T10:00:00.000Z';
const audit = { sql: 'audit', params: [] };
const idempotency = { sql: 'idempotency', params: [] };
const fence = mutationFence({ userId: 'user', sessionId: 'session' } as AuthenticatedActor, {});
const token = tokenMutationFence(
  {
    tokenId: 'token',
    tokenKind: 'svc',
    principalId: 'principal',
  } as AuthenticatedTokenActor,
  'org:import:write',
  {},
);
const input = { runId: 'run', planHash: 'hash', now, audit, idempotency };
function setup(overrides: Partial<ImportRun> = {}) {
  const run: ImportRun = {
    id: 'run',
    orgId: ctx.orgId,
    state: 'planned',
    planHash: 'hash',
    approvedAt: null,
    approvedByUserId: null,
    acceptedAt: null,
    beforeImageExpiresAt: null,
    ...overrides,
  };
  const access = { run: run as ImportRun | null, allowed: true, reauthFresh: true };
  const write = () =>
    vi.fn<ImportRunStore['approveRun']>().mockResolvedValue({ ok: true, results: [] });
  const store = {
    inspect: vi.fn<ImportRunStore['inspect']>().mockImplementation(async () => access),
    createRun: vi.fn<ImportRunStore['createRun']>().mockResolvedValue({ ok: true, results: [] }),
    approveRun: write(),
    requestApply: write(),
    cancelRun: write(),
    acceptRun: write(),
    requestRollback: write(),
  };
  const service = createImportRunService({ store, ids: { ulid: () => 'new-run' } });
  return { service, store, access, run };
}
const methods = [
  'approveRun',
  'requestApply',
  'cancelRun',
  'acceptRun',
  'requestRollback',
] as const;

describe('import run service', () => {
  it('refuses apply before approval without writing', async () => {
    const { service, store } = setup();
    expect(await service.requestApply(ctx, fence, input)).toEqual({
      ok: false,
      error: 'not_approved',
    });
    expect(store.requestApply).not.toHaveBeenCalled();
  });
  it('refuses an approval hash mismatch', async () => {
    const { service, store, run } = setup();
    expect(await service.approveRun(ctx, fence, { ...input, planHash: 'different' })).toEqual({
      ok: false,
      error: 'conflict',
    });
    expect(store.approveRun).not.toHaveBeenCalled();
    expect(run.approvedAt).toBeNull();
  });
  it('records approver, timestamp and exactly one hour of credentials', async () => {
    const { service, store } = setup();
    expect(await service.approveRun(ctx, fence, input)).toEqual({ ok: true, value: null });
    expect(store.approveRun).toHaveBeenCalledWith(
      ctx,
      fence,
      expect.objectContaining({
        approvedByUserId: 'user',
        approvedAt: now,
        credentialWindowUntil: '2026-10-18T11:00:00.000Z',
      }),
    );
  });
  for (const method of methods) {
    it(`${method} refuses token fences at runtime and compile time`, async () => {
      const { service, store } = setup();
      // @ts-expect-error Import approval operations require a session fence.
      await expect(service[method](ctx, token, input)).rejects.toThrow(TypeError);
      expect(store.inspect).not.toHaveBeenCalled();
    });
    it(`${method} refuses forged fences`, async () => {
      const { service } = setup();
      await expect(service[method](ctx, { ...fence } as MutationFence, input)).rejects.toThrow(
        TypeError,
      );
    });
    it(`${method} refuses the wrong state`, async () => {
      const { service, store } = setup({ state: 'rolled_back', approvedAt: now });
      expect(await service[method](ctx, fence, input)).toEqual({ ok: false, error: 'conflict' });
      expect(store[method]).not.toHaveBeenCalled();
    });
  }
  for (const method of methods) {
    it(`${method} requires fresh reauthentication`, async () => {
      const { service, store, access } = setup({
        approvedAt: method === 'approveRun' ? null : now,
      });
      access.reauthFresh = false;
      expect(await service[method](ctx, fence, input)).toEqual({
        ok: false,
        error: 'reauth_required',
      });
      expect(store[method]).not.toHaveBeenCalled();
    });
  }
  it('refuses a second approval without moving its approver or time', async () => {
    const { service, store, run } = setup({ approvedAt: now, approvedByUserId: 'original' });
    expect(await service.approveRun(ctx, fence, input)).toEqual({ ok: false, error: 'conflict' });
    expect(store.approveRun).not.toHaveBeenCalled();
    expect(run.approvedByUserId).toBe('original');
    expect(run.approvedAt).toBe(now);
  });
  it('returns not_found for an unknown run', async () => {
    const { service, access } = setup();
    access.run = null;
    expect(await service.approveRun(ctx, fence, input)).toEqual({ ok: false, error: 'not_found' });
  });
  it('returns the same not_found for another organization', async () => {
    const { service } = setup({ orgId: orgContext('other').orgId });
    expect(await service.approveRun(ctx, fence, input)).toEqual({ ok: false, error: 'not_found' });
  });
  it('hides absent targets even when permission and reauth are missing', async () => {
    const { service, access } = setup();
    Object.assign(access, { run: null, allowed: false, reauthFresh: false });
    expect(await service.approveRun(ctx, fence, input)).toEqual({ ok: false, error: 'not_found' });
  });
  it('returns generic forbidden for a visible target', async () => {
    const { service, access } = setup();
    access.allowed = false;
    expect(await service.approveRun(ctx, fence, input)).toEqual({ ok: false, error: 'forbidden' });
  });
  for (const method of methods) {
    const state = method === 'acceptRun' || method === 'requestRollback' ? 'verified' : 'planned';
    const approvedAt = method === 'approveRun' ? null : now;
    it(`${method} passes audit and idempotency once on success`, async () => {
      const { service, store } = setup({ state, approvedAt });
      expect(await service[method](ctx, fence, input)).toEqual({ ok: true, value: null });
      expect(store[method]).toHaveBeenCalledTimes(1);
      expect(store[method]).toHaveBeenCalledWith(
        ctx,
        fence,
        expect.objectContaining({ audit, idempotency }),
      );
    });
    it(`${method} does not retry an indeterminate write`, async () => {
      const { service, store } = setup({ state, approvedAt });
      store[method].mockResolvedValue({ ok: false, reason: 'indeterminate' });
      expect(await service[method](ctx, fence, input)).toEqual({ ok: false, error: 'unavailable' });
      expect(store[method]).toHaveBeenCalledTimes(1);
    });
  }
  for (const creator of [fence, token]) {
    it(`creates a canonical manifest under a ${creator === fence ? 'session' : 'token'} fence`, async () => {
      const { service, store } = setup();
      const manifest = parseManifest({
        version: 1,
        source_system: 'test',
        items: [],
        widening: [],
      });
      if (!manifest.ok) throw new Error('invalid fixture');
      expect(
        await service.createRun(ctx, creator, { manifest: manifest.data, now, audit, idempotency }),
      ).toEqual({
        ok: true,
        value: { id: 'new-run', planHash: await planHash(manifest.data), state: 'planned' },
      });
      expect(store.createRun).toHaveBeenCalledTimes(1);
      expect(store.createRun).toHaveBeenCalledWith(
        ctx,
        creator,
        expect.objectContaining({ audit, idempotency, planHash: await planHash(manifest.data) }),
      );
    });
  }
  it('returns the plan hash and state persisted during creation', async () => {
    const { service, store, access, run } = setup({ state: 'cancelled', planHash: null });
    store.createRun.mockImplementation(async (_ctx, _fence, write) => {
      access.run = { ...run, id: write.id, planHash: write.planHash, state: 'planned' };
      return { ok: true, results: [] };
    });
    const result = await service.createRun(ctx, fence, {
      manifest: { version: 1, source_system: 'test', items: [], widening: [] },
      now,
      audit,
    });
    expect(result).toEqual({
      ok: true,
      value: { id: access.run?.id, planHash: access.run?.planHash, state: access.run?.state },
    });
    expect(access.run?.planHash).toEqual(expect.any(String));
    expect(access.run?.state).toBe('planned');
  });
  it('does not retry indeterminate creation', async () => {
    const { service, store } = setup();
    store.createRun.mockResolvedValue({ ok: false, reason: 'indeterminate' });
    expect(
      await service.createRun(ctx, fence, {
        manifest: { version: 1, source_system: 'test', items: [], widening: [] },
        now,
        audit,
      }),
    ).toEqual({ ok: false, error: 'unavailable' });
    expect(store.createRun).toHaveBeenCalledTimes(1);
  });
  it('refuses invalid manifests before creating', async () => {
    const { service, store } = setup();
    expect(await service.createRun(ctx, fence, { manifest: {}, now, audit })).toEqual({
      ok: false,
      error: 'invalid_manifest',
    });
    expect(store.createRun).not.toHaveBeenCalled();
  });
  it('refuses rollback at before-image expiry', async () => {
    const { service, store } = setup({
      state: 'verified',
      approvedAt: now,
      beforeImageExpiresAt: now,
    });
    expect(await service.requestRollback(ctx, fence, input)).toEqual({
      ok: false,
      error: 'conflict',
    });
    expect(store.requestRollback).not.toHaveBeenCalled();
  });
  it('refuses a second acceptance', async () => {
    const { service, store } = setup({ state: 'verified', approvedAt: now, acceptedAt: now });
    expect(await service.acceptRun(ctx, fence, input)).toEqual({ ok: false, error: 'conflict' });
    expect(store.acceptRun).not.toHaveBeenCalled();
  });
});
