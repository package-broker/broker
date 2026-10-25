import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  mutationFence,
  tokenMutationFence,
  type AuthenticatedActor,
  type AuthenticatedTokenActor,
  type MutationFence,
} from '../authz/fence.js';
import { orgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import { parseManifest, planHash } from './manifest.js';
import {
  IMPORT_RUN_JOB,
  IMPORT_VERIFICATION_JOB,
  validImportApprovalTimestamp,
  createImportRunService,
  type ImportRun,
  type ImportRunStore,
} from './run-service.js';

const ctx = orgContext('org');
const now = '2026-10-18T10:00:00.000Z';
const audit = { sql: 'audit', params: [] };
const idempotency = { sql: 'idempotency', params: [] };
const record = {
  principalKey: 'user:user',
  key: 'key',
  route: '/_pb/import-runs',
  requestHash: 'c'.repeat(64),
  status: 201,
  responseJson: '{}',
  createdAt: now,
  expiresAt: '2026-10-19T10:00:00.000Z',
};
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
function setup(overrides: Partial<ImportRun> = {}, clock = fixedClock(now)) {
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
  const windows = new Map<string, string | null>();
  const write = () =>
    vi.fn<ImportRunStore['approveRun']>().mockResolvedValue({ ok: true, results: [] });
  const store = {
    inspect: vi.fn<ImportRunStore['inspect']>().mockImplementation(async () => access),
    createRun: vi.fn<ImportRunStore['createRun']>().mockResolvedValue({ ok: true, results: [] }),
    approveRun: write(),
    requestApply: write(),
    requestVerify: vi
      .fn<ImportRunStore['requestVerify']>()
      .mockResolvedValue({ ok: true, results: [] }),
    get: vi.fn<ImportRunStore['get']>().mockImplementation(async () => access.run),
    list: vi
      .fn<ImportRunStore['list']>()
      .mockImplementation(async () => (access.run === null ? [] : [access.run])),
    cancelRun: write(),
    acceptRun: write(),
    requestRollback: write(),
    credentialWindows: vi
      .fn<ImportRunStore['credentialWindows']>()
      .mockImplementation(
        async (_ctx, ids) => new Map(ids.map((id) => [id, windows.get(id) ?? null])),
      ),
    findIdempotency: vi.fn<ImportRunStore['findIdempotency']>().mockResolvedValue(null),
  };
  const service = createImportRunService({ store, ids: { ulid: () => 'new-run' }, clock });
  return { service, store, access, run, windows };
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
  for (const method of [...methods, 'requestVerify'] as const) {
    const state =
      method === 'requestVerify'
        ? 'applied'
        : method === 'acceptRun' || method === 'requestRollback'
          ? 'verified'
          : 'planned';
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
      const hash = await planHash(manifest.data);
      const build = vi.fn((response: object) => ({
        ...record,
        responseJson: JSON.stringify(response),
      }));
      expect(
        await service.createRun(ctx, creator, {
          manifest: manifest.data,
          now,
          audit,
          idempotency: build,
        }),
      ).toEqual({
        ok: true,
        value: { id: 'new-run', planHash: hash, state: 'planned' },
      });
      expect(store.createRun).toHaveBeenCalledTimes(1);
      expect(store.createRun).toHaveBeenCalledWith(
        ctx,
        creator,
        expect.objectContaining({
          audit,
          idempotency: {
            ...record,
            responseJson: JSON.stringify({ id: 'new-run', planHash: hash, state: 'planned' }),
          },
          planHash: hash,
        }),
      );
      expect(build).toHaveBeenCalledWith({ id: 'new-run', planHash: hash, state: 'planned' });
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
  it('refuses an idempotency record created at another instant', async () => {
    const { service, store } = setup();
    await expect(
      service.createRun(ctx, fence, {
        manifest: { version: 1, source_system: 'test', items: [], widening: [] },
        now,
        audit,
        idempotency: () => ({ ...record, createdAt: '2026-10-18T10:00:00.001Z' }),
      }),
    ).rejects.toThrow(TypeError);
    expect(store.createRun).not.toHaveBeenCalled();
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

describe('import approval timestamps', () => {
  const malformed = [
    '',
    'not-a-time',
    '2026-10-18',
    '2026-10-18T10:00:00Z',
    '2026-02-30T10:00:00.000Z',
    '2026-10-18T12:00:00.000+02:00',
    '2026-10-18T10:02:00.000Z',
  ];
  it.each(malformed)('treats stored approval %j as unapproved', async (approvedAt) => {
    const { service, store } = setup({ approvedAt });
    expect(await service.requestApply(ctx, fence, input)).toEqual({
      ok: false,
      error: 'not_approved',
    });
    expect(store.requestApply).not.toHaveBeenCalled();
  });
  it('checks stored approval skew against the injected clock when input time is ahead', async () => {
    const future = '2026-10-18T10:02:00.000Z';
    const { service, store } = setup({ approvedAt: future }, fixedClock(now));
    expect(await service.requestApply(ctx, fence, { ...input, now: future })).toEqual({
      ok: false,
      error: 'not_approved',
    });
    expect(store.requestApply).not.toHaveBeenCalled();
  });
  it.each(malformed)('rejects approval timestamp %j before writing', async (value) => {
    const { service, store } = setup();
    expect(await service.approveRun(ctx, fence, { ...input, now: value })).toEqual({
      ok: false,
      error: 'invalid_time',
    });
    expect(store.approveRun).not.toHaveBeenCalled();
  });
  it('approves using the injected clock when the machine clock is before the fixture', async () => {
    const { service, store } = setup();
    const machineClock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(now) - 120_000);
    try {
      expect(await service.approveRun(ctx, fence, input)).toEqual({ ok: true, value: null });
      expect(store.approveRun).toHaveBeenCalledTimes(1);
    } finally {
      machineClock.mockRestore();
    }
  });
  it.each([
    ['2026-10-18T09:59:00.000Z', true],
    ['2026-10-18T09:58:59.999Z', false],
  ] as const)('checks approval skew against injected time %s', async (clockTime, allowed) => {
    const { service, store } = setup({}, fixedClock(clockTime));
    expect(await service.approveRun(ctx, fence, input)).toEqual(
      allowed ? { ok: true, value: null } : { ok: false, error: 'invalid_time' },
    );
    expect(store.approveRun).toHaveBeenCalledTimes(allowed ? 1 : 0);
  });
  it('permits exactly sixty seconds of future skew', () => {
    const time = Date.parse(now);
    expect(validImportApprovalTimestamp(new Date(time + 60_000).toISOString(), time)).toBe(true);
    expect(validImportApprovalTimestamp(new Date(time + 60_001).toISOString(), time)).toBe(false);
    expect(validImportApprovalTimestamp(now, time)).toBe(true);
  });
});

describe('import job definition', () => {
  it('keeps job type and resource literals only in the shared definition', () => {
    const definition = fileURLToPath(new URL('./run-service.ts', import.meta.url));
    const roots = [
      new URL('../', import.meta.url),
      new URL('../../../db-sqlite/src/', import.meta.url),
    ];
    const files = (root: URL): string[] =>
      readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
        const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), root);
        return entry.isDirectory()
          ? files(url)
          : entry.name.endsWith('.ts')
            ? [fileURLToPath(url)]
            : [];
      });
    const literals = [
      IMPORT_RUN_JOB.apply,
      IMPORT_RUN_JOB.rollback,
      IMPORT_VERIFICATION_JOB.type,
      '`' + IMPORT_RUN_JOB.resourceKey('') + '${',
    ];
    for (const file of roots.flatMap(files)) {
      const source = readFileSync(file, 'utf8');
      for (const literal of literals) {
        expect(source.split(literal).length - 1, `${file}: ${literal}`).toBe(
          file === definition ? 1 : 0,
        );
      }
    }
    expect(IMPORT_RUN_JOB.payload('run')).toEqual({ runId: 'run' });
    expect(IMPORT_RUN_JOB.resourceKey('run')).toBe(IMPORT_RUN_JOB.resourceKey('') + 'run');
  });
});

describe('verification requests', () => {
  it.each(['applied', 'verifying'] as const)(
    'compares %s state and immutable expiry in the store write',
    async (state) => {
      const { service, store, run } = setup({ state });
      expect(await service.requestVerify(ctx, fence, input)).toEqual({ ok: true, value: null });
      expect(store.requestVerify).toHaveBeenCalledWith(ctx, fence, { ...input, expected: run });
    },
  );
  it.each(['planned', 'applying', 'failed', 'verified', 'rolled_back', 'cancelled'] as const)(
    'refuses verification from %s',
    async (state) => {
      const { service, store } = setup({ state });
      expect(await service.requestVerify(ctx, fence, input)).toEqual({
        ok: false,
        error: 'conflict',
      });
      expect(store.requestVerify).not.toHaveBeenCalled();
    },
  );
  it('refuses a new verification after expiry was set', async () => {
    const { service, store } = setup({ state: 'applied', beforeImageExpiresAt: now });
    expect(await service.requestVerify(ctx, fence, input)).toEqual({
      ok: false,
      error: 'conflict',
    });
    expect(store.requestVerify).not.toHaveBeenCalled();
  });
});

describe('token-capable verification', () => {
  it.each([token, fence])('permits verify without fresh reauthentication', async (actor) => {
    const { service, store, access, run } = setup({ state: 'applied' });
    access.reauthFresh = false;
    expect(await service.requestVerify(ctx, actor, input)).toEqual({ ok: true, value: null });
    expect(store.requestVerify).toHaveBeenCalledExactlyOnceWith(ctx, actor, {
      ...input,
      expected: run,
    });
  });
  it('refuses a token without live import write permission before writing', async () => {
    const { service, store, access } = setup({ state: 'applied' });
    access.allowed = false;
    expect(await service.requestVerify(ctx, token, input)).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(store.requestVerify).not.toHaveBeenCalled();
  });
  it('refuses a token fence for a different permission before inspection', async () => {
    const { service, store } = setup({ state: 'applied' });
    const wrong = tokenMutationFence(
      { tokenId: 'other', tokenKind: 'svc', principalId: 'principal' } as AuthenticatedTokenActor,
      'project:packages:write',
      {},
    );
    await expect(service.requestVerify(ctx, wrong, input)).rejects.toThrow(TypeError);
    expect(store.inspect).not.toHaveBeenCalled();
    expect(store.requestVerify).not.toHaveBeenCalled();
  });
  for (const method of methods) {
    it(`${method} refuses tokens without any store write`, async () => {
      const { service, store } = setup({
        state: method === 'acceptRun' || method === 'requestRollback' ? 'verified' : 'planned',
        approvedAt: method === 'approveRun' ? null : now,
      });
      // @ts-expect-error Import approval operations require a session fence.
      await expect(service[method](ctx, token, input)).rejects.toThrow(TypeError);
      expect(store[method]).not.toHaveBeenCalled();
    });
  }
});

describe('import run reads', () => {
  it('returns only the safe DTO even if the store returns extra fields', async () => {
    const { service, access, run } = setup();
    Object.assign(access.run!, {
      manifest: 'PRIVATE',
      credential_ref: 'PRIVATE',
      before_image_json: 'PRIVATE',
    });
    expect(await service.get(ctx, 'run')).toEqual({
      ok: true,
      value: {
        id: run.id,
        state: run.state,
        planHash: run.planHash,
        approvedAt: run.approvedAt,
        approvedByUserId: run.approvedByUserId,
        acceptedAt: run.acceptedAt,
        beforeImageExpiresAt: run.beforeImageExpiresAt,
        credentialWindowUntil: null,
      },
    });
    expect(JSON.stringify(await service.list(ctx, {}))).not.toContain('PRIVATE');
  });
  it('reads the stored credential window for one run and for a list page', async () => {
    const { service, store, windows } = setup({ approvedAt: now });
    windows.set('run', '2026-10-18T11:00:00.000Z');
    expect(await service.get(ctx, 'run')).toMatchObject({
      ok: true,
      value: { credentialWindowUntil: '2026-10-18T11:00:00.000Z' },
    });
    expect(await service.list(ctx, {})).toMatchObject({
      ok: true,
      value: { items: [{ id: 'run', credentialWindowUntil: '2026-10-18T11:00:00.000Z' }] },
    });
    expect(store.credentialWindows).toHaveBeenNthCalledWith(1, ctx, ['run']);
    expect(store.credentialWindows).toHaveBeenNthCalledWith(2, ctx, ['run']);
  });
  it('reports a null window when the store has none', async () => {
    const { service } = setup();
    expect(await service.get(ctx, 'run')).toMatchObject({
      ok: true,
      value: { credentialWindowUntil: null },
    });
  });
  it.each([
    ['exactly at expiry', '2026-10-18T10:00:00.000Z'],
    ['after expiry', '2026-10-18T09:59:59.999Z'],
    ['malformed', 'not-a-time'],
  ])('hides a window that is %s at the service clock', async (_name, until) => {
    const { service, windows } = setup({ approvedAt: now });
    windows.set('run', until);
    expect(await service.get(ctx, 'run')).toMatchObject({
      ok: true,
      value: { credentialWindowUntil: null },
    });
    expect(await service.list(ctx, {})).toMatchObject({
      ok: true,
      value: { items: [{ credentialWindowUntil: null }] },
    });
  });
  it('shows a window one millisecond before expiry', async () => {
    const { service, windows } = setup({ approvedAt: now });
    windows.set('run', '2026-10-18T10:00:00.001Z');
    expect(await service.get(ctx, 'run')).toMatchObject({
      ok: true,
      value: { credentialWindowUntil: '2026-10-18T10:00:00.001Z' },
    });
  });
  it.each(['cancelled', 'rolled_back'] as const)(
    'hides an open window on a %s run',
    async (state) => {
      const { service, windows } = setup({ approvedAt: now, state });
      windows.set('run', '2026-10-18T11:00:00.000Z');
      expect(await service.get(ctx, 'run')).toMatchObject({
        ok: true,
        value: { credentialWindowUntil: null },
      });
    },
  );
  it.each(['planned', 'applying', 'failed', 'applied', 'verifying', 'verified'] as const)(
    'shows an open window on an approved %s run',
    async (state) => {
      const { service, windows } = setup({ approvedAt: now, state });
      windows.set('run', '2026-10-18T11:00:00.000Z');
      expect(await service.get(ctx, 'run')).toMatchObject({
        ok: true,
        value: { credentialWindowUntil: '2026-10-18T11:00:00.000Z' },
      });
    },
  );
  it('hides a stored window on an unapproved run', async () => {
    const { service, windows } = setup();
    windows.set('run', '2026-10-18T11:00:00.000Z');
    expect(await service.get(ctx, 'run')).toMatchObject({
      ok: true,
      value: { credentialWindowUntil: null },
    });
  });
  it('reads idempotency records through the store', async () => {
    const { service, store } = setup();
    store.findIdempotency.mockResolvedValue(record);
    expect(await service.findIdempotency(ctx, 'user:user', 'key', now)).toBe(record);
    expect(store.findIdempotency).toHaveBeenCalledWith(ctx, 'user:user', 'key', now);
  });
  it('hides an absent run', async () => {
    const { service, access } = setup();
    access.run = null;
    expect(await service.get(ctx, 'missing')).toEqual({ ok: false, error: 'not_found' });
  });
  it('hides a foreign run', async () => {
    const { service } = setup({ orgId: orgContext('foreign').orgId });
    expect(await service.get(ctx, 'run')).toEqual({ ok: false, error: 'not_found' });
    expect(await service.list(ctx, {})).toEqual({ ok: true, value: { items: [], next: null } });
  });
  it('hides a mismatched run id', async () => {
    const { service } = setup();
    expect(await service.get(ctx, 'different')).toEqual({ ok: false, error: 'not_found' });
  });
  it('caps pages, uses a scoped opaque cursor, and ends pagination', async () => {
    const { service, store, run } = setup();
    store.list.mockResolvedValueOnce(
      Array.from({ length: 101 }, (_, index) => ({ ...run, id: String(1000 - index) })),
    );
    const first = await service.list(ctx, { limit: 200 });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('missing page');
    expect(first.value.items).toHaveLength(100);
    expect(first.value.next).toEqual(expect.any(String));
    expect(first.value.next).not.toContain(ctx.orgId);
    expect(store.list).toHaveBeenLastCalledWith(ctx, { after: null, limit: 101 });
    const second = await service.list(ctx, { cursor: first.value.next!, limit: 2 });
    expect(store.list).toHaveBeenLastCalledWith(ctx, { after: '901', limit: 3 });
    expect(second.ok && second.value.next).toBeNull();
    expect(await service.list(orgContext('foreign'), { cursor: first.value.next! })).toEqual({
      ok: false,
      error: 'invalid_cursor',
    });
  });
  it('refuses malformed cursors before reading', async () => {
    const { service, store } = setup();
    expect(await service.list(ctx, { cursor: 'invalid!' })).toEqual({
      ok: false,
      error: 'invalid_cursor',
    });
    expect(store.list).not.toHaveBeenCalled();
  });
  it.each([0, -1, 1.5, NaN, Infinity])('refuses invalid limit %s before reading', async (limit) => {
    const { service, store } = setup();
    expect(await service.list(ctx, { limit })).toEqual({ ok: false, error: 'invalid_limit' });
    expect(store.list).not.toHaveBeenCalled();
  });
});
