import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  registerAuditExport,
  type VerifiedAuditArtifact,
} from '@package-broker/core/audit/cutover';
import { ulid } from '@package-broker/core/ids';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { createAuditCutoverRepository } from '../repositories/audit-cutover.js';
import type { MigratedDatabase } from './migrated-database.js';

export const CUTOVER_ACTOR = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
export const CUTOVER_NOW = '2026-10-30T12:00:00.000Z';
export async function seedCutover(
  executor: SqlExecutor,
  org: OrgContext,
  actorId = CUTOVER_ACTOR,
): Promise<VerifiedAuditArtifact> {
  await executor.batch([
    {
      sql: "INSERT INTO user_account (org_id, id, email) VALUES (?, ?, 'operator@example.test')",
      params: [org.orgId, actorId],
    },
    {
      sql: "UPDATE audit_chain SET mode = 'none', head_seq = 2, head_hash = ?, verified_at = ? WHERE org_id = ?",
      params: ['a'.repeat(64), CUTOVER_NOW, org.orgId],
    },
    {
      sql: `INSERT INTO audit_event (id, org_id, seq, prev_hash, hash, created_at, actor_type, action, target_type, payload_json) VALUES (?, ?, 2, ?, ?, ?, 'system', 'audit.export', 'organization', '{}')`,
      params: [ulid(), org.orgId, '0'.repeat(64), 'a'.repeat(64), CUTOVER_NOW],
    },
    {
      sql: 'UPDATE organization SET audit_last_verified_at = ? WHERE id = ?',
      params: [CUTOVER_NOW, org.orgId],
    },
  ]);
  const [row] = await executor.all<{ chainId: string }>({
    sql: 'SELECT chain_id AS chainId FROM audit_chain WHERE org_id = ?',
    params: [org.orgId],
  });
  return {
    chainId: row!.chainId,
    orgId: org.orgId,
    epoch: 0,
    headSeq: 2,
    headHash: 'a'.repeat(64),
    boundarySeq: 1,
    boundaryPrevHash: '0'.repeat(64),
    bodies: 2,
    withheld: 0,
  };
}
export function auditCutoverRepositorySuite(open: () => Promise<MigratedDatabase>): void {
  let database: MigratedDatabase;
  let executor: SqlExecutor;
  let org: OrgContext;
  let artifact: VerifiedAuditArtifact;
  const run = (sql: string, ...params: Statement['params']) => executor.batch([{ sql, params }]);
  const register = (storage = executor, data = artifact) =>
    registerAuditExport(
      createAuditCutoverRepository(storage),
      org,
      data,
      0,
      { type: 'user', id: CUTOVER_ACTOR },
      CUTOVER_NOW,
    );
  const wrap = (batch: SqlExecutor['batch']): SqlExecutor => ({
    driver: executor.driver,
    all: (s) => executor.all(s),
    batch,
  });
  const state = (ctx = org) =>
    Promise.all(
      ['audit_ledger', 'audit_pending', 'audit_chain', 'organization'].map((table) =>
        executor.all({
          sql: `SELECT * FROM ${table} WHERE ${table === 'organization' ? 'id' : 'org_id'} = ?`,
          params: [ctx.orgId],
        }),
      ),
    );
  beforeEach(async () => {
    database = await open();
    executor = database.executor;
    org = database.orgs!.a;
    artifact = await seedCutover(executor, org);
  });
  afterEach(async () => database.close());
  describe('audit export registration', () => {
    it('atomically records verified custody and its event using RETURNING and clears verification only for this org', async () => {
      const foreign = await state(database.orgs!.b);
      expect(
        await register(
          wrap(async (statements) => {
            expect(statements.length).toBeLessThanOrEqual(200);
            expect(statements.every((s) => s.params.length <= 100)).toBe(true);
            return (await executor.batch(statements)).map((r) => ({ ...r, changes: 0 }));
          }),
        ),
      ).toBe(true);
      const [ledger, pending, chain, organization] = await state();
      expect(ledger).toHaveLength(1);
      expect(ledger![0]).toMatchObject({
        kind: 'export',
        reason_code: 'verified_export',
        chain_id: artifact.chainId,
        epoch: 0,
        from_seq: 1,
        to_seq: 2,
        count: 2,
        actor_id: CUTOVER_ACTOR,
        sink_id: null,
      });
      expect(pending).toHaveLength(1);
      expect(pending![0]).toMatchObject({ action: 'audit.export', actor_id: CUTOVER_ACTOR });
      expect(chain![0]).toMatchObject({ verified_at: null });
      expect(organization![0]).toMatchObject({ audit_last_verified_at: null });
      expect(await state(database.orgs!.b)).toEqual(foreign);
    });
    it.each([
      "chain_id = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'",
      'epoch = 1',
      'head_seq = 1',
      'boundary_seq = 2',
      'incarnation = 1',
      'mode_generation = 1',
      "policy = 'required'",
      'restore_pending = 1',
    ])('rejects a changed registration snapshot atomically: %s', async (change) => {
      let moved: unknown;
      expect(
        await register(
          wrap(async (statements) => {
            await run(`UPDATE audit_chain SET ${change} WHERE org_id = ?`, org.orgId);
            moved = await state();
            return executor.batch(statements);
          }),
        ),
      ).toBe(false);
      expect(await state()).toEqual(moved);
    });
    it('rejects a head that already differs from the artifact', async () => {
      await run('UPDATE audit_chain SET head_seq = 1 WHERE org_id = ?', org.orgId);
      expect(await register()).toBe(false);
      expect((await state())[0]).toEqual([]);
    });
    it('accepts a later head', async () => {
      await run(
        'UPDATE audit_chain SET head_seq = 3, head_hash = ? WHERE org_id = ?',
        'b'.repeat(64),
        org.orgId,
      );
      expect(await register()).toBe(true);
    });
    it.each([
      "head_hash = '" + 'b'.repeat(64) + "'",
      "boundary_prev_hash = '" + 'b'.repeat(64) + "'",
    ])(
      'uses the retained artifact row rather than equality of current chain fields: %s',
      async (change) => {
        await run(`UPDATE audit_chain SET ${change} WHERE org_id = ?`, org.orgId);
        expect(await register()).toBe(true);
      },
    );
    it('accepts a retained boundary below the artifact boundary', async () => {
      expect(await register(executor, { ...artifact, boundarySeq: 2, bodies: 1 })).toBe(true);
    });
    it.each(["mode = 'trail'", "pending_mode = 'trail'", 'restore_pending = 1'])(
      'diagnoses refusal after the authoritative batch: %s',
      async (change) => {
        await run(`UPDATE audit_chain SET ${change} WHERE org_id = ?`, org.orgId);
        expect(await register()).toBe(false);
        expect(
          await createAuditCutoverRepository(executor).diagnose(org, 0, {
            type: 'user',
            id: CUTOVER_ACTOR,
          }),
        ).toBe(change.includes('restore') ? 'restore_pending' : 'mode_not_none');
      },
    );
    it('rejects a changed artifact anchor hash in the commit batch', async () => {
      expect(
        await register(
          wrap(async (statements) => {
            await run(
              'UPDATE audit_event SET hash = ? WHERE org_id = ? AND seq = ?',
              'b'.repeat(64),
              org.orgId,
              artifact.headSeq,
            );
            return executor.batch(statements);
          }),
        ),
      ).toBe(false);
      expect((await state())[0]).toEqual([]);
    });
    it('uses a pending none transition as the effective mode', async () => {
      await run(
        "UPDATE audit_chain SET mode = 'trail', pending_mode = 'none' WHERE org_id = ?",
        org.orgId,
      );
      expect(await register()).toBe(true);
    });
    it('checks the operator in the commit batch', async () => {
      expect(
        await register(
          wrap(async (s) => {
            await run(
              "UPDATE user_account SET status = 'suspended' WHERE org_id = ? AND id = ?",
              org.orgId,
              CUTOVER_ACTOR,
            );
            return executor.batch(s);
          }),
        ),
      ).toBe(false);
      expect((await state())[0]).toEqual([]);
      expect(
        await createAuditCutoverRepository(executor).diagnose(org, 0, {
          type: 'user',
          id: CUTOVER_ACTOR,
        }),
      ).toBe('operator_unavailable');
    });
    it('refuses an older build generation', async () => {
      await run(
        `INSERT INTO audit_sink (org_id, sink_id, plugin_id, kind, generation, receiver_fingerprint, durable_ack, activation_source, state, progress_seq, progress_hash, custody_seq) VALUES (?, 'archive', 'audit', 'webhook', 1, 'fingerprint', 1, 'ARCHIVE_URL', 'active', 0, ?, 0)`,
        org.orgId,
        '0'.repeat(64),
      );
      expect(await register()).toBe(false);
      expect((await state())[0]).toEqual([]);
      expect(
        await createAuditCutoverRepository(executor).diagnose(org, 0, {
          type: 'user',
          id: CUTOVER_ACTOR,
        }),
      ).toBe('stale_generation');
    });
    it.each([0, 2, 4, 6, 8])('rolls back injected failure at statement %s', async (index) => {
      const before = await state();
      await expect(
        register(
          wrap((s) =>
            executor.batch([
              ...s.slice(0, index),
              { sql: 'INSERT INTO cutover_missing_table (id) VALUES (?)', params: [ulid()] },
              ...s.slice(index),
            ]),
          ),
        ),
      ).rejects.toThrow();
      expect(await state()).toEqual(before);
    });
    it.each([{ withheld: 1, bodies: 1 }, { bodies: 1 }, { orgId: 'foreign' }])(
      'refuses non-covering artifacts: %j',
      async (change) => {
        const before = await state();
        await expect(register(executor, { ...artifact, ...change })).rejects.toThrow();
        expect(await state()).toEqual(before);
      },
    );
  });
}
