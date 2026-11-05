import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateAuditBuild } from '@package-broker/core/audit/effective';
import { enterAuditNone, type AuditNoneOptions } from '@package-broker/core/audit/none';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { createAuditNoneRepository } from '../repositories/audit-none.js';
import type { MigratedDatabase } from './migrated-database.js';

const now = '2026-10-30T12:00:00.000Z';
function options(generation = 3): AuditNoneOptions {
  return {
    audit: {
      build: validateAuditBuild(
        { platform: 'cloudflare', plugins: [], audit: { acceptNoDurableAudit: true } },
        () => undefined,
        'cloudflare',
      ),
      sinks: [],
      alertPathActive: false,
    },
    generation,
    now,
    ids: ['01ARZ3NDEKTSV4RRFFQ69G5FAV', '01ARZ3NDEKTSV4RRFFQ69G5FAW', '01ARZ3NDEKTSV4RRFFQ69G5FAX'],
  };
}

export function auditNoneRepositorySuite(open: () => Promise<MigratedDatabase>): void {
  let database: MigratedDatabase;
  let executor: SqlExecutor;
  let org: OrgContext;
  const run = (sql: string, ...params: Statement['params']) => executor.batch([{ sql, params }]);
  async function state(ctx = org) {
    return Promise.all(
      ['audit_chain', 'audit_ledger', 'audit_pending', 'organization'].map((table) =>
        executor.all({
          sql: `SELECT * FROM ${table} WHERE ${table === 'organization' ? 'id' : 'org_id'} = ?`,
          params: [ctx.orgId],
        }),
      ),
    );
  }
  function enter(storage = executor, generation = 3) {
    return enterAuditNone(createAuditNoneRepository(storage), org, options(generation));
  }
  function wrapped(batch: SqlExecutor['batch']): SqlExecutor {
    return { driver: executor.driver, all: (s) => executor.all(s), batch };
  }
  beforeEach(async () => {
    database = await open();
    executor = database.executor;
    org = database.orgs!.a;
    await run(
      `UPDATE audit_chain SET head_seq = 4, mode_generation = 2,
      verified_at = ?, verified_from_seq = 1, verified_through_seq = 4,
      verified_bodies = 4, verified_withheld = 0 WHERE org_id = ?`,
      now,
      org.orgId,
    );
    await run('UPDATE organization SET audit_last_verified_at = ? WHERE id = ?', now, org.orgId);
  });
  afterEach(async () => database.close());

  describe('audit none persistence', () => {
    it('atomically persists mode, ledger and event, clears verification, preserves foreign state and survives restart', async () => {
      const foreign = await state(database.orgs!.b);
      let batches = 0;
      const outcome = await enter(
        wrapped(async (statements) => {
          batches++;
          expect(statements.length).toBeLessThanOrEqual(200);
          expect(statements.reduce((n, s) => n + s.params.length, 0)).toBeLessThanOrEqual(100);
          const results = await executor.batch(statements);
          return results.map((result) => ({ ...result, changes: 0 }));
        }),
      );
      expect(batches).toBe(1);
      expect(outcome).toMatchObject({
        outcome: 'degraded',
        status: { degraded: true, modeGeneration: 3, cutoverSeq: 4 },
      });
      const [chain, ledger, pending, organization] = await state();
      expect(chain![0]).toMatchObject({
        mode: 'trail',
        pending_mode: 'none',
        mode_generation: 3,
        cutover_seq: 4,
        verified_at: null,
        verified_from_seq: null,
        verified_through_seq: null,
        verified_bodies: null,
        verified_withheld: null,
      });
      expect(ledger).toHaveLength(2);
      expect(ledger!.map((row) => row.kind).sort()).toEqual(['cutover', 'mode_change']);
      expect(pending).toHaveLength(1);
      expect(pending![0]).toMatchObject({ action: 'audit.mode_change', org_id: org.orgId });
      expect(organization![0]).toMatchObject({ audit_last_verified_at: null });
      expect(await state(database.orgs!.b)).toEqual(foreign);
      const committed = await state();
      expect(await enter()).toEqual(outcome);
      expect(await state()).toEqual(committed);
    });
    it('logs a lost head compare-and-swap without recording the transition', async () => {
      const log = vi.fn();
      const storage = wrapped(async (statements) => {
        await run('UPDATE audit_chain SET head_seq = head_seq + 1 WHERE org_id = ?', org.orgId);
        return executor.batch(statements);
      });
      expect(
        await enterAuditNone(
          createAuditNoneRepository(storage, {
            log,
            counter() {},
            histogram() {},
          }),
          org,
          options(),
        ),
      ).toEqual({ outcome: 'contended' });
      expect(log).toHaveBeenCalledExactlyOnceWith({ level: 'warn', event: 'audit.none.contended' });
      expect((await state())[1]).toEqual([]);
      expect((await state())[2]).toEqual([]);
    });
    it('uses seq one for empty-chain ledger records and zero for cutover', async () => {
      await run('UPDATE audit_chain SET head_seq = 0 WHERE org_id = ?', org.orgId);
      expect(await enter()).toMatchObject({ outcome: 'degraded', status: { cutoverSeq: 0 } });
      const [, ledger] = await state();
      expect(ledger!.every((row) => row.from_seq === 1 && row.to_seq === 1)).toBe(true);
    });
    it('preserves an already pending cutover without staging a replacement', async () => {
      await run(
        "UPDATE audit_chain SET pending_mode = 'export', cutover_seq = 2 WHERE org_id = ?",
        org.orgId,
      );
      const before = await state();
      expect(await enter()).toEqual({ outcome: 'contended' });
      expect(await state()).toEqual(before);
    });
    it.each([
      "chain_id = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'",
      'epoch = epoch + 1',
      'incarnation = incarnation + 1',
      'head_seq = head_seq + 1',
      "mode = 'export'",
      "pending_mode = 'export'",
      'mode_generation = mode_generation + 1',
      'cutover_seq = 2',
      "policy = 'required'",
      'restore_pending = 1',
    ])('refuses a concurrent snapshot change: %s', async (change) => {
      let moved: unknown;
      expect(
        await enter(
          wrapped(async (statements) => {
            await run(`UPDATE audit_chain SET ${change} WHERE org_id = ?`, org.orgId);
            moved = await state();
            return executor.batch(statements);
          }),
        ),
      ).toEqual({ outcome: 'contended' });
      expect(await state()).toEqual(moved);
    });
    it.each(['restore_pending = 1', "policy = 'required'"])(
      'refuses existing unsafe state: %s',
      async (change) => {
        await run(`UPDATE audit_chain SET ${change} WHERE org_id = ?`, org.orgId);
        const before = await state();
        expect(await enter()).toMatchObject({
          outcome: 'refused',
          code: change.startsWith('policy') ? 'required_acceptance' : 'restore_pending',
        });
        expect(await state()).toEqual(before);
      },
    );
    it.each([false, true])(
      'fences the highest sink generation, including concurrent insertion: %s',
      async (concurrent) => {
        const seed = () =>
          run(
            `INSERT INTO audit_sink (org_id, sink_id, plugin_id, kind, generation,
        receiver_fingerprint, durable_ack, activation_source, state, progress_seq, progress_hash, custody_seq) VALUES (?, 'archive', 'audit', 'webhook', 4, 'fingerprint', 1, 'ARCHIVE_URL', 'retired', 0, ?, 0)`,
            org.orgId,
            '0'.repeat(64),
          );
        if (!concurrent) await seed();
        expect(
          await enter(
            concurrent
              ? wrapped(async (s) => {
                  await seed();
                  return executor.batch(s);
                })
              : executor,
          ),
        ).toEqual({ outcome: 'contended' });
        expect((await state())[1]).toEqual([]);
        expect(await enter(executor, 4)).toMatchObject({ outcome: 'degraded' });
      },
    );
    it.each([0, 1, 2, 3, 4, 5, 6, 7])(
      'rolls back on a failing statement at batch position %s',
      async (index) => {
        const before = await state();
        await expect(
          enter(
            wrapped((statements) =>
              executor.batch([
                ...statements.slice(0, index),
                {
                  sql: 'INSERT INTO audit_none_missing_table (org_id) VALUES (?)',
                  params: [org.orgId],
                },
                ...statements.slice(index),
              ]),
            ),
          ),
        ).rejects.toThrow();
        expect(await state()).toEqual(before);
      },
    );
    it('rolls back a real pending-event uniqueness failure', async () => {
      await run(
        `INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type)
        VALUES (?, ?, ?, 'system', 'org.update', 'organization')`,
        options().ids[2],
        org.orgId,
        now,
      );
      const before = await state();
      await expect(enter()).rejects.toThrow();
      expect(await state()).toEqual(before);
    });
  });
}
