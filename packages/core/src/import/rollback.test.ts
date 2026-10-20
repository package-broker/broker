import { describe, expect, it, vi } from 'vitest';
import type { AuditEvent } from '../audit/actions.js';
import { delegatedMutationFence, fenceKind } from '../authz/fence.js';
import { orgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import {
  runImportRollback,
  type ImportRollbackDeps,
  type ImportRollbackLiveState,
  type ImportRollbackOutcome,
  type ImportRollbackRef,
  type ImportRollbackRun,
  type ImportRollbackStore,
} from './rollback.js';

const ctx = orgContext('org');
const runId = '01J0QPAD000000000000000000';
const approver = '01J0USER000000000000000000';
const requester = '01J0REQUESTER00000000000000';
const now = '2026-11-01T09:00:00.000Z';
const job = { id: 'job', owner: 'worker', fence: 1 };
const STORE_ALLOWLIST = new Set([
  'name',
  'slug',
  'status',
  'token_max_scope',
  'require_publish_approval',
  'blob_id',
  'published_at',
  'metadata_json',
]);

interface Live {
  exists: boolean;
  hash: string | null;
  referenced: boolean;
  revision: number | null;
  columns: Record<string, unknown>;
}

function ref(over: Partial<ImportRollbackRef> & { id: string }): ImportRollbackRef {
  return {
    runId,
    entityType: 'project',
    entityId: `e-${over.id}`,
    externalRef: `x-${over.id}`,
    action: 'update',
    beforeImageJson: JSON.stringify({ name: `old-${over.id}` }),
    contentHash: `h-${over.id}`,
    publishedAtBasis: null,
    beforeImageExpiresAt: null,
    conflictState: 'none',
    rolledBackAt: null,
    ...over,
  };
}

function setup(refs: readonly ImportRollbackRef[], runOver: Partial<ImportRollbackRun> = {}) {
  const run: ImportRollbackRun = {
    id: runId,
    state: 'applied',
    approvedByUserId: approver,
    ...runOver,
  };
  const live = new Map<string, Live>(
    refs.map((r) => [
      r.entityId,
      {
        exists: true,
        hash: r.contentHash,
        referenced: false,
        revision: r.entityType === 'access_grant' ? null : 7,
        columns: { name: `imported-${r.id}` },
      },
    ]),
  );
  const refState = new Map(
    refs.map((r) => [r.id, { rolledBackAt: r.rolledBackAt, conflictState: r.conflictState }]),
  );
  const written: { entityId: string; columns: Record<string, unknown> }[] = [];
  const audits: AuditEvent[] = [];
  const hooks = {
    beforeApply: undefined as undefined | (() => void),
    script: [] as ('ok' | 'guard' | 'conflict')[],
    maxActions: Infinity,
    state: run.state,
    lastError: null as string | null,
  };
  const domainValues = (row: Live) => ({ ...row.columns });
  const store = {
    loadRun: vi.fn<ImportRollbackStore['loadRun']>().mockImplementation(async () => ({
      ...run,
      state: hooks.state,
    })),
    rollbackRefs: vi
      .fn<ImportRollbackStore['rollbackRefs']>()
      .mockImplementation(async () => refs.map((r) => ({ ...r, ...refState.get(r.id)! }))),
    liveStates: vi.fn<ImportRollbackStore['liveStates']>().mockImplementation(async (_, targets) =>
      targets.map((t): ImportRollbackLiveState => {
        const row = live.get(t.entityId);
        if (!row) return { exists: false, contentHash: null, referenced: false, guard: null };
        return {
          exists: row.exists,
          contentHash: row.hash,
          referenced: row.referenced,
          guard:
            row.revision === null
              ? { kind: 'domain', values: domainValues(row) as never }
              : { kind: 'revision', revision: row.revision },
        };
      }),
    ),
    applyChunk: vi
      .fn<ImportRollbackStore['applyChunk']>()
      .mockImplementation(async (_, fence, input) => {
        expect(fenceKind(fence)).toBe('delegated');
        expect(fence.approverUserId).toBe(requester);
        expect(fence.runId).toBe(runId);
        expect(input.approvedByUserId).toBe(approver);
        const expected = Object.fromEntries(
          input.actions.flatMap((a) =>
            (a.kind === 'restore' || a.kind === 'delete') && a.guard?.kind === 'revision'
              ? [[a.entityId, a.guard.revision]]
              : [],
          ),
        );
        expect(fence.expected).toEqual(expected);
        const scripted = hooks.script.shift() ?? 'ok';
        if (scripted === 'guard') return { ok: false, reason: 'guard' };
        if (scripted === 'conflict') return { ok: false, reason: 'conflict' };
        if (input.actions.length > hooks.maxActions) return { ok: false, reason: 'too_large' };
        hooks.beforeApply?.();
        const outcomes: ImportRollbackOutcome[] = input.actions.map((a) => {
          const state = refState.get(a.refId)!;
          if (a.kind === 'expired') return 'expired';
          if (a.kind === 'conflict') {
            state.conflictState = 'changed_after_import';
            return 'conflict';
          }
          const row = live.get(a.entityId)!;
          const stale =
            !row.exists ||
            (a.guard.kind === 'revision'
              ? a.guard.revision !== row.revision
              : JSON.stringify(a.guard.values) !== JSON.stringify(domainValues(row)));
          if (a.kind === 'delete') {
            expect(a.requireUnreferenced).toBe(true);
            if (stale || row.referenced) {
              state.conflictState = 'changed_after_import';
              return 'conflict';
            }
            row.exists = false;
          } else {
            for (const key of Object.keys(a.domain)) expect(STORE_ALLOWLIST.has(key)).toBe(true);
            if (stale) {
              state.conflictState = 'changed_after_import';
              return 'conflict';
            }
            Object.assign(row.columns, a.domain);
            if (row.revision !== null) row.revision += 1;
            written.push({ entityId: a.entityId, columns: a.domain });
          }
          state.rolledBackAt = now;
          audits.push(a.audit);
          return 'restored';
        });
        return { ok: true, outcomes };
      }),
    finish: vi.fn<ImportRollbackStore['finish']>().mockImplementation(async (_, __, input) => {
      if (input.outcome === 'rolled_back') hooks.state = 'applied';
      else hooks.lastError = input.outcome.failed;
      audits.push(...input.audits);
    }),
  };
  let counter = 0;
  const deps: ImportRollbackDeps = {
    store,
    clock: fixedClock(now),
    ids: { ulid: () => `01J0AUDIT${String(++counter).padStart(17, '0')}` },
  };
  const fences = vi.fn((user: string, id: string, expected: Readonly<Record<string, number>>) =>
    delegatedMutationFence(user, id, job, expected),
  );
  const execute = (
    payload: { runId: string; requestedBy: string } = { runId, requestedBy: requester },
  ) => runImportRollback(deps, ctx, payload, fences);
  const actionsOf = () => store.applyChunk.mock.calls.flatMap(([, , i]) => i.actions);
  const finished = () => store.finish.mock.calls[0]![2];
  return { run, store, live, written, audits, hooks, deps, fences, execute, actionsOf, finished };
}

describe('runImportRollback', () => {
  it('restores an untouched item to exactly the before-image domain columns', async () => {
    const a = ref({ id: 'a', beforeImageJson: JSON.stringify({ name: 'old', slug: 'old-slug' }) });
    const s = setup([a]);
    expect(await s.execute()).toEqual({
      status: 'rolled_back',
      counts: { restored: 1, conflict: 0, expired: 0 },
    });
    expect(s.live.get(a.entityId)!.columns).toEqual({ name: 'old', slug: 'old-slug' });
  });

  it('marks an edited item as conflict, leaves its live row, and restores the others', async () => {
    const a = ref({ id: 'a' });
    const b = ref({ id: 'b' });
    const s = setup([a, b]);
    s.live.get(a.entityId)!.hash = 'edited-later';
    const before = structuredClone(s.live.get(a.entityId)!.columns);
    expect(await s.execute()).toEqual({
      status: 'rolled_back',
      counts: { restored: 1, conflict: 1, expired: 0 },
    });
    expect(s.live.get(a.entityId)!.columns).toEqual(before);
    expect(s.written.map((w) => w.entityId)).toEqual([b.entityId]);
    expect(s.actionsOf().map((x) => [x.refId, x.kind])).toEqual(
      expect.arrayContaining([
        ['a', 'conflict'],
        ['b', 'restore'],
      ]),
    );
  });

  it('marks a hash-less ref as conflict without restoring', async () => {
    const s = setup([ref({ id: 'a', contentHash: null })]);
    expect((await s.execute()).status).toBe('rolled_back');
    expect(s.written).toEqual([]);
    expect(s.finished().counts).toEqual({ restored: 0, conflict: 1, expired: 0 });
  });

  it('marks an update ref whose live row vanished as conflict', async () => {
    const a = ref({ id: 'a' });
    const s = setup([a]);
    s.live.get(a.entityId)!.exists = false;
    s.live.get(a.entityId)!.hash = null;
    await s.execute();
    expect(s.written).toEqual([]);
    expect(s.finished().counts).toEqual({ restored: 0, conflict: 1, expired: 0 });
  });

  it('marks a missing live row as conflict even when its stored hash still matches', async () => {
    const a = ref({ id: 'a' });
    const s = setup([a]);
    s.live.get(a.entityId)!.exists = false;
    await s.execute();
    expect(s.written).toEqual([]);
    expect(s.finished().counts).toEqual({ restored: 0, conflict: 1, expired: 0 });
  });

  it('marks an unreadable before-image as conflict', async () => {
    const s = setup([ref({ id: 'a', beforeImageJson: '[1,2]' })]);
    await s.execute();
    expect(s.written).toEqual([]);
    expect(s.finished().counts).toEqual({ restored: 0, conflict: 1, expired: 0 });
  });

  it('expires an item exactly at its expiry instant and does not restore it', async () => {
    const s = setup([ref({ id: 'a', beforeImageExpiresAt: now })]);
    expect(await s.execute()).toEqual({
      status: 'rolled_back',
      counts: { restored: 0, conflict: 0, expired: 1 },
    });
    expect(s.written).toEqual([]);
  });

  it('restores an item one millisecond before its expiry', async () => {
    const s = setup([ref({ id: 'a', beforeImageExpiresAt: '2026-11-01T09:00:00.001Z' })]);
    expect(await s.execute()).toEqual({
      status: 'rolled_back',
      counts: { restored: 1, conflict: 0, expired: 0 },
    });
  });

  it('restores a NULL-expiry item of a run that is not yet verified', async () => {
    const s = setup([ref({ id: 'a', beforeImageExpiresAt: null })], { state: 'verifying' });
    expect((await s.execute()).status).toBe('rolled_back');
    expect(s.written).toHaveLength(1);
  });

  it('expires a NULL-expiry item of a verified run', async () => {
    const s = setup([ref({ id: 'a', beforeImageExpiresAt: null })], { state: 'verified' });
    await s.execute();
    expect(s.written).toEqual([]);
    expect(s.finished().counts).toEqual({ restored: 0, conflict: 0, expired: 1 });
  });

  it('deletes an unreferenced created item whose hash is unchanged', async () => {
    const a = ref({ id: 'a', action: 'create', beforeImageJson: null });
    const s = setup([a]);
    expect(await s.execute()).toEqual({
      status: 'rolled_back',
      counts: { restored: 1, conflict: 0, expired: 0 },
    });
    expect(s.live.get(a.entityId)!.exists).toBe(false);
  });

  it('keeps a created item that has attached project sources and marks it conflict', async () => {
    const source = ref({
      id: 'src',
      action: 'create',
      entityType: 'source',
      beforeImageJson: null,
    });
    const s = setup([source]);
    s.live.get(source.entityId)!.referenced = true;
    expect(await s.execute()).toEqual({
      status: 'rolled_back',
      counts: { restored: 0, conflict: 1, expired: 0 },
    });
    expect(s.live.get(source.entityId)!.exists).toBe(true);
    expect(s.actionsOf().map((x) => x.kind)).not.toContain('delete');
  });

  it('keeps an edited created item and marks it conflict', async () => {
    const a = ref({ id: 'a', action: 'create', beforeImageJson: null });
    const s = setup([a]);
    s.live.get(a.entityId)!.hash = 'edited-later';
    await s.execute();
    expect(s.live.get(a.entityId)!.exists).toBe(true);
    expect(s.finished().counts).toEqual({ restored: 0, conflict: 1, expired: 0 });
  });

  it('downgrades a delete to conflict when a dependent appears before the batch', async () => {
    const a = ref({ id: 'a', action: 'create', entityType: 'source', beforeImageJson: null });
    const s = setup([a]);
    s.hooks.beforeApply = () => {
      s.live.get(a.entityId)!.referenced = true;
    };
    expect(await s.execute()).toEqual({
      status: 'rolled_back',
      counts: { restored: 0, conflict: 1, expired: 0 },
    });
    expect(s.live.get(a.entityId)!.exists).toBe(true);
  });

  it('requires the dependents guard on every delete action', async () => {
    const s = setup([ref({ id: 'a', action: 'create', beforeImageJson: null })]);
    await s.execute();
    const deletes = s.actionsOf().filter((x) => x.kind === 'delete');
    expect(deletes).toHaveLength(1);
    for (const x of deletes) expect(x.requireUnreferenced).toBe(true);
  });

  it('never passes operational columns to the store', async () => {
    const a = ref({
      id: 'a',
      beforeImageJson: JSON.stringify({
        name: 'old',
        revision: 1,
        updated_at: 'x',
        last_op_id: 'y',
        last_synced_at: 'z',
        last_accessed_at: 'w',
      }),
    });
    const s = setup([a]);
    await s.execute();
    const keys = s.actionsOf().flatMap((x) => (x.kind === 'restore' ? Object.keys(x.domain) : []));
    expect(keys).toEqual(['name']);
  });

  it('limits a version image to the four version domain keys', async () => {
    const a = ref({
      id: 'a',
      entityType: 'version',
      beforeImageJson: JSON.stringify({
        blob_id: 'b',
        published_at: 'p',
        status: 'ready',
        metadata_json: '{}',
        name: 'not-a-version-column',
        slug: 'nope',
      }),
    });
    const s = setup([a]);
    await s.execute();
    const restore = s.actionsOf().find((x) => x.kind === 'restore');
    expect(
      restore && restore.kind === 'restore' ? Object.keys(restore.domain).sort() : null,
    ).toEqual(['blob_id', 'metadata_json', 'published_at', 'status']);
  });

  it('drops keys outside the entity type allowlist', async () => {
    const a = ref({ id: 'a', beforeImageJson: JSON.stringify({ name: 'old', evil: 'x' }) });
    const s = setup([a]);
    await s.execute();
    expect(s.written[0]!.columns).toEqual({ name: 'old' });
  });

  it('marks an update image of a create-only entity type as conflict', async () => {
    const a = ref({
      id: 'a',
      entityType: 'role',
      beforeImageJson: JSON.stringify({ name: 'old' }),
    });
    const s = setup([a]);
    await s.execute();
    expect(s.written).toEqual([]);
    expect(s.finished().counts).toEqual({ restored: 0, conflict: 1, expired: 0 });
  });

  it('carries the live revision as guard and fences the expected revision', async () => {
    const a = ref({ id: 'a' });
    const s = setup([a]);
    await s.execute();
    const restore = s.actionsOf().find((x) => x.kind === 'restore');
    expect(restore && restore.kind === 'restore' ? restore.guard : null).toEqual({
      kind: 'revision',
      revision: 7,
    });
    expect(s.fences).toHaveBeenCalledWith(requester, runId, { [a.entityId]: 7 });
  });

  it('carries the after-image domain values as guard for a table without a revision', async () => {
    const a = ref({ id: 'a', entityType: 'access_grant', action: 'create', beforeImageJson: null });
    const s = setup([a]);
    await s.execute();
    const del = s.actionsOf().find((x) => x.kind === 'delete');
    expect(del && del.kind === 'delete' ? del.guard : null).toEqual({
      kind: 'domain',
      values: { name: 'imported-a' },
    });
    expect(s.fences).toHaveBeenCalledWith(requester, runId, {});
  });

  it('records a row edited between the read and the batch as conflict and leaves it', async () => {
    const a = ref({ id: 'a' });
    const s = setup([a]);
    s.hooks.beforeApply = () => {
      s.live.get(a.entityId)!.revision = 8;
      s.live.get(a.entityId)!.columns.name = 'edited-in-between';
    };
    expect(await s.execute()).toEqual({
      status: 'rolled_back',
      counts: { restored: 0, conflict: 1, expired: 0 },
    });
    expect(s.live.get(a.entityId)!.columns.name).toBe('edited-in-between');
  });

  it('counts a store-side downgrade to conflict', async () => {
    const s = setup([ref({ id: 'a' })]);
    s.store.applyChunk.mockResolvedValue({ ok: true, outcomes: ['conflict'] });
    expect(await s.execute()).toEqual({
      status: 'rolled_back',
      counts: { restored: 0, conflict: 1, expired: 0 },
    });
  });

  it('fails when the store returns a different number of outcomes than actions', async () => {
    const s = setup([ref({ id: 'a' }), ref({ id: 'b' })]);
    s.store.applyChunk.mockResolvedValue({ ok: true, outcomes: ['restored'] });
    expect(await s.execute()).toEqual({ status: 'failed', reason: 'conflict' });
  });

  it('fails without writing when a ref belongs to another run', async () => {
    const s = setup([ref({ id: 'a' }), ref({ id: 'b', runId: 'other-run' })]);
    expect(await s.execute()).toEqual({ status: 'failed', reason: 'conflict' });
    expect(s.store.applyChunk).not.toHaveBeenCalled();
  });

  it('deletes created items in reverse dependency order, one entity type per chunk', async () => {
    const mk = (id: string, entityType: string) =>
      ref({ id, action: 'create', entityType, beforeImageJson: null });
    const s = setup([mk('p', 'project'), mk('s', 'source'), mk('g', 'access_grant')]);
    await s.execute();
    expect(s.store.applyChunk.mock.calls.map(([, , i]) => i.actions.map((x) => x.refId))).toEqual([
      ['g'],
      ['s'],
      ['p'],
    ]);
  });

  it('writes nothing and ends failed when the fence guard fails', async () => {
    const s = setup([ref({ id: 'a' })]);
    s.hooks.script = ['guard'];
    expect(await s.execute()).toEqual({ status: 'failed', reason: 'guard_failed' });
    expect(s.written).toEqual([]);
    expect(s.store.finish).toHaveBeenCalledExactlyOnceWith(ctx, expect.anything(), {
      runId,
      outcome: { failed: 'guard_failed' },
      counts: { restored: 0, conflict: 0, expired: 0 },
      audits: [expect.objectContaining({ action: 'import_run.rollback' })],
      now,
    });
  });

  it('keeps the prior run state when the rollback fails and records only the error', async () => {
    const s = setup([ref({ id: 'a' })], { state: 'verified' });
    s.hooks.script = ['guard'];
    await s.execute();
    expect(s.hooks.state).toBe('verified');
    expect(s.hooks.lastError).toBe('guard_failed');
  });

  it('resumes after a failed second chunk without repeating settled work', async () => {
    const v = ref({
      id: 'v',
      entityType: 'version',
      beforeImageJson: JSON.stringify({ status: 'x' }),
    });
    const p = ref({ id: 'p' });
    const s = setup([v, p]);
    s.hooks.script = ['ok', 'guard'];
    expect(await s.execute()).toEqual({ status: 'failed', reason: 'guard_failed' });
    expect(s.finished().counts).toEqual({ restored: 1, conflict: 0, expired: 0 });
    expect(s.written.map((w) => w.entityId)).toEqual([v.entityId]);

    s.store.applyChunk.mockClear();
    expect(await s.execute()).toEqual({
      status: 'rolled_back',
      counts: { restored: 2, conflict: 0, expired: 0 },
    });
    expect(s.store.applyChunk).toHaveBeenCalledTimes(1);
    expect(s.written.map((w) => w.entityId)).toEqual([v.entityId, p.entityId]);
  });

  it('keeps counts stable across a retry that includes a conflict', async () => {
    const a = ref({ id: 'a' });
    const b = ref({
      id: 'b',
      entityType: 'version',
      beforeImageJson: JSON.stringify({ status: 'x' }),
    });
    const s = setup([a, b]);
    s.live.get(a.entityId)!.hash = 'edited-later';
    s.hooks.script = ['ok', 'guard'];
    await s.execute();
    const second = await s.execute();
    expect(second).toEqual({
      status: 'rolled_back',
      counts: { restored: 1, conflict: 1, expired: 0 },
    });
  });

  it('marks only restored or deleted refs as rolled back', async () => {
    const a = ref({ id: 'a' });
    const b = ref({ id: 'b', beforeImageExpiresAt: now });
    const c = ref({ id: 'c' });
    const s = setup([a, b, c]);
    s.live.get(c.entityId)!.hash = 'edited-later';
    await s.execute();
    const states = await s.store.rollbackRefs(ctx, runId);
    expect(states.map((x) => [x.id, x.rolledBackAt !== null])).toEqual([
      ['a', true],
      ['b', false],
      ['c', false],
    ]);
  });

  it('refuses a run that cannot be rolled back and touches nothing', async () => {
    for (const state of ['planned', 'failed', 'rolled_back', 'cancelled', 'applying'] as const) {
      const s = setup([ref({ id: 'a' })], { state });
      expect(await s.execute()).toEqual({ status: 'not_rollbackable' });
      expect(s.store.rollbackRefs).not.toHaveBeenCalled();
      expect(s.store.applyChunk).not.toHaveBeenCalled();
      expect(s.store.finish).not.toHaveBeenCalled();
    }
  });

  it('refuses a run without a recorded approver', async () => {
    const s = setup([ref({ id: 'a' })], { approvedByUserId: null });
    expect(await s.execute()).toEqual({ status: 'not_rollbackable' });
    expect(s.store.applyChunk).not.toHaveBeenCalled();
  });

  it('refuses a payload without a requesting user', async () => {
    const s = setup([ref({ id: 'a' })]);
    expect(await s.execute({ runId, requestedBy: '' })).toEqual({ status: 'not_rollbackable' });
    expect(s.store.applyChunk).not.toHaveBeenCalled();
  });

  it('refuses a missing run', async () => {
    const s = setup([ref({ id: 'a' })]);
    s.store.loadRun.mockResolvedValue(null);
    expect(await s.execute()).toEqual({ status: 'not_rollbackable' });
    expect(s.store.applyChunk).not.toHaveBeenCalled();
  });

  it('scopes every store call to the organization and fences as the requester', async () => {
    const s = setup([ref({ id: 'a' })]);
    await s.execute();
    expect(s.store.loadRun).toHaveBeenCalledWith(ctx, runId);
    expect(s.store.rollbackRefs).toHaveBeenCalledWith(ctx, runId);
    expect(s.store.liveStates.mock.calls[0]![0]).toBe(ctx);
    expect(s.store.applyChunk.mock.calls[0]![0]).toBe(ctx);
    expect(s.store.finish.mock.calls[0]![0]).toBe(ctx);
    for (const [user] of s.fences.mock.calls) expect(user).toBe(requester);
  });

  it('does not touch refs already rolled back and counts them restored', async () => {
    const s = setup([ref({ id: 'a', rolledBackAt: '2026-10-30T00:00:00.000Z' })]);
    expect(await s.execute()).toEqual({
      status: 'rolled_back',
      counts: { restored: 1, conflict: 0, expired: 0 },
    });
    expect(s.store.applyChunk).not.toHaveBeenCalled();
  });

  it('keeps previously marked conflicts as conflicts without re-evaluating them', async () => {
    const s = setup([ref({ id: 'a', conflictState: 'changed_after_import' })]);
    expect(await s.execute()).toEqual({
      status: 'rolled_back',
      counts: { restored: 0, conflict: 1, expired: 0 },
    });
    expect(s.store.applyChunk).not.toHaveBeenCalled();
  });

  it('halves a chunk the store reports as too large and still settles every ref', async () => {
    const refs = ['a', 'b', 'c', 'd', 'e'].map((id) => ref({ id }));
    const s = setup(refs);
    s.hooks.maxActions = 2;
    expect(await s.execute()).toEqual({
      status: 'rolled_back',
      counts: { restored: 5, conflict: 0, expired: 0 },
    });
    expect(s.store.applyChunk.mock.calls.some(([, , i]) => i.actions.length > 2)).toBe(true);
    expect(s.written).toHaveLength(5);
  });

  it('fails with too_large when a single action is still too large', async () => {
    const s = setup([ref({ id: 'a' })]);
    s.hooks.maxActions = 0;
    expect(await s.execute()).toEqual({ status: 'failed', reason: 'too_large' });
    expect(s.written).toEqual([]);
  });

  it('splits a chunk by per-action statement cost', async () => {
    const wide = JSON.stringify(
      Object.fromEntries(['name', 'slug', 'status'].map((k) => [k, 'v'])),
    );
    const refs = Array.from({ length: 50 }, (_, i) =>
      ref({ id: `r${String(i).padStart(2, '0')}`, beforeImageJson: wide }),
    );
    const s = setup(refs);
    await s.execute();
    expect(s.store.applyChunk.mock.calls.length).toBeGreaterThan(1);
    expect(s.written).toHaveLength(50);
  });

  it('audits each restored item and a summary with the three counts, never before-image contents', async () => {
    const a = ref({ id: 'a', beforeImageJson: JSON.stringify({ name: 'SECRET-OLD-NAME' }) });
    const b = ref({ id: 'b' });
    const c = ref({ id: 'c', beforeImageExpiresAt: now });
    const s = setup([a, b, c]);
    s.live.get(b.entityId)!.hash = 'edited-later';
    await s.execute();
    const finish = s.finished();
    expect(finish.outcome).toBe('rolled_back');
    expect(finish.counts).toEqual({ restored: 1, conflict: 1, expired: 1 });
    expect(finish.audits).toHaveLength(1);
    const summary = finish.audits[0]!;
    expect(summary.action).toBe('import_run.rollback');
    expect(summary.target).toEqual({ type: 'import_run', id: runId });
    expect(summary.actor).toEqual({ type: 'user', id: requester });
    expect(JSON.parse(summary.payloadJson).changes).toEqual({
      state: { new: 'rolled_back' },
      restored: { new: 1 },
      conflict: { new: 1 },
      expired: { new: 1 },
    });
    expect(s.audits).toHaveLength(2);
    expect(s.audits[0]!.target).toEqual({ type: 'project', id: a.entityId });
    expect(s.audits.every((x) => x.actor.id === requester)).toBe(true);
    expect(JSON.stringify([s.audits, finish])).not.toContain('SECRET-OLD-NAME');
  });

  it('emits the summary with partial counts when the rollback fails', async () => {
    const v = ref({
      id: 'v',
      entityType: 'version',
      beforeImageJson: JSON.stringify({ status: 'x' }),
    });
    const s = setup([v, ref({ id: 'p' })]);
    s.hooks.script = ['ok', 'guard'];
    await s.execute();
    const summary = s.finished().audits[0]!;
    expect(JSON.parse(summary.payloadJson).changes).toEqual({
      state: { new: 'failed' },
      restored: { new: 1 },
      conflict: { new: 0 },
      expired: { new: 0 },
    });
  });
});
