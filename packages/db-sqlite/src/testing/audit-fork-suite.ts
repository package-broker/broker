import {
  administerAuditSink,
  auditRetirementConfirmation,
  type AuditSinkAdminPort,
} from '@package-broker/core/audit/sink-admin';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { confirmAuditRestore, detectAuditFork } from '@package-broker/core/audit/fork';
import { reconcileAuditSinks } from '@package-broker/core/audit/sinks/registry';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { auditEvent } from '@package-broker/core/audit/actions';
import { auditPendingStatement } from '../repositories/audit-pending.js';
import { createAuditForkRepository } from '../repositories/audit-fork.js';
import { createAuditSinkRepository } from '../repositories/audit-sink.js';
import { createAuditSealRepository } from '../repositories/audit-seal.js';
import { createAuditPruneRepository } from '../repositories/audit-prune.js';
import { createAuditLedgerRepository } from '../repositories/audit-ledger.js';
import { createAuditExportRepository } from '../repositories/audit-export.js';
import { exportAuditBatch } from '@package-broker/core/audit/export';
import type { AuditBatchV1, AuditSink } from '@package-broker/core/audit/plugin-api';
import { systemMutationFence } from '@package-broker/core/authz/fence';
import { ulid } from '@package-broker/core/ids';
import type { MigratedDatabase } from './migrated-database.js';

const now = new Date('2026-10-30T00:00:00.000Z');
const zero = '0'.repeat(64);
export async function seedAuditFork(executor: SqlExecutor, org: OrgContext): Promise<void> {
  await reconcileAuditSinks(
    createAuditSinkRepository(executor),
    org,
    2,
    [
      {
        id: 'archive',
        pluginId: 'audit',
        kind: 'webhook',
        durableAck: true,
        destination: { receiverFingerprint: 'a'.repeat(64), activationSource: 'ARCHIVE_URL' },
      },
    ],
    now,
  );
  await executor.batch([
    {
      sql: "UPDATE audit_chain SET policy = 'required', verified_at = ?, verified_from_seq = 1, verified_through_seq = 0 WHERE org_id = ?",
      params: [now.toISOString(), org.orgId],
    },
    {
      sql: 'UPDATE organization SET audit_last_verified_at = ? WHERE id = ?',
      params: [now.toISOString(), org.orgId],
    },
    {
      sql: "UPDATE audit_sink SET progress_seq = 3, custody_seq = 2, attempt = 4, retry_count_for_seq = 7, next_attempt_at = ?, last_error_code = 'timeout' WHERE org_id = ?",
      params: [now.toISOString(), org.orgId],
    },
  ]);
}
function wrap(
  executor: SqlExecutor,
  batch: (
    statements: readonly Statement[],
  ) => Promise<import('@package-broker/core/db/port').StatementResult[]>,
): SqlExecutor {
  return {
    driver: executor.driver,
    all: (statement) => executor.all(statement),
    batch: (statements) =>
      statements[0]?.sql.startsWith('SELECT') ? executor.batch(statements) : batch(statements),
  };
}
export async function auditForkRepositorySuite(
  open: () => Promise<MigratedDatabase>,
): Promise<void> {
  describe('atomic audit fork repository', () => {
    let database: MigratedDatabase;
    let port: AuditSinkAdminPort;
    let org: OrgContext;
    beforeEach(async () => {
      database = await open();
      org = database.orgs!.a;
      await seedAuditFork(database.executor, org);
      port = createAuditForkRepository(database.executor);
      await database.executor.batch([
        {
          sql: 'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
          params: [actor.id, org.orgId, 'operator@example.test'],
        },
      ]);
    });
    afterEach(async () => {
      await database?.close();
    });
    const options = () => ({
      generation: 2,
      now,
      signal: new AbortController().signal,
      alert: () => {},
    });
    async function rows(table: string) {
      return database.executor.all({ sql: `SELECT * FROM ${table} ORDER BY 1, 2`, params: [] });
    }
    async function contents() {
      return Promise.all(
        ['audit_chain', 'audit_sink', 'audit_ledger', 'audit_pending', 'organization'].map(rows),
      );
    }
    const actor = { type: 'user' as const, id: '01JZZZZZZZZZZZZZZZZZZZZZZX' };
    const admin = (command: Parameters<typeof administerAuditSink>[2], adminPort = port) =>
      administerAuditSink(adminPort, org, command, {
        alert: () => {},
        generation: 2,
        now,
        actor,
      });
    it.each(['unblock', 'confirm_restore'] as const)(
      'relieves the backlog through %s while required capacity is refusing',
      async (operation) => {
        for (let index = 0; index < 3; index++) {
          const id = ulid();
          const result = auditEvent({
            id,
            now: now.toISOString(),
            action: 'project.update',
            actor,
            target: { type: 'project', id: null },
            context: { opId: id, requestId: id, tokenSelector: null, sourceIp: null },
          });
          if (!result.ok) throw new Error('Invalid audit fixture');
          await database.executor.batch([auditPendingStatement(org, result.event)]);
        }
        await createAuditSealRepository(database.executor).seal(org);
        await database.executor.batch([
          {
            sql: "UPDATE audit_chain SET mode = 'export', pending_mode = NULL, capacity_state = 'refusing', restore_pending = ? WHERE org_id = ?",
            params: [operation === 'confirm_restore' ? 1 : 0, org.orgId],
          },
          {
            sql: "UPDATE audit_sink SET state = 'blocked', blocked_reason = ?, progress_seq = 0, progress_hash = ?, custody_seq = 0 WHERE org_id = ?",
            params: [operation === 'confirm_restore' ? 'fork' : 'rejected', zero, org.orgId],
          },
        ]);
        const ordinary = auditPendingStatement(org, {
          id: ulid(),
          occurredAt: now.toISOString(),
          actor,
          tokenSelector: null,
          sourceIp: null,
          action: 'project.update',
          target: { type: 'organization', id: org.orgId },
          projectId: null,
          payloadJson: '{}',
        });
        await expect(database.executor.batch([ordinary])).rejects.toMatchObject({
          kind: 'backlog_full',
        });
        const beforeBytes = (await rows('audit_chain')).find(
          (row) => row.org_id === org.orgId,
        )!.journal_bytes;
        if (operation === 'unblock') {
          expect(await admin({ operation: 'unblock', sinkId: 'archive' })).toEqual({
            result: 'applied',
          });
        } else {
          expect(await confirm(1)).toBe('confirmed');
        }
        expect((await port.read(org)).sinks[0]).toMatchObject({ state: 'active', custodySeq: 0 });
        expect((await rows('audit_pending')).filter((row) => row.org_id === org.orgId)).toEqual([
          expect.objectContaining({ action: 'audit.sink_admin' }),
        ]);
        await createAuditSealRepository(database.executor).seal(org);
        expect((await exportUntilIdle()).length).toBeGreaterThan(0);
        const delivered = await port.read(org);
        expect(delivered.sinks[0]!.custodySeq).toBe(delivered.headSeq);
        expect((await rows('audit_chain')).find((row) => row.org_id === org.orgId)).toMatchObject({
          mode: 'export',
          pending_mode: null,
          restore_pending: 0,
        });
        expect(
          await createAuditPruneRepository(database.executor, undefined, {
            maxJournalBytes: 1000,
          }).prune(org, {
            generation: 2,
            configuredSinkIds: ['archive'],
            trailActive: false,
          }),
        ).toMatchObject({ outcome: 'pruned' });
        const relieved = (await rows('audit_chain')).find((row) => row.org_id === org.orgId)!;
        expect(relieved.journal_bytes).toBeLessThan(Number(beforeBytes));
        expect(relieved.capacity_state).toBe('ok');
        await expect(database.executor.batch([ordinary])).resolves.toBeDefined();
        expect((await rows('audit_ledger')).some((row) => row.kind === 'gap')).toBe(false);
      },
    );
    it('lists without changing evidence or verification or exposing frozen bodies or destinations', async () => {
      const before = await contents();
      const result = await admin({ operation: 'list' });
      expect(result).toMatchObject({
        result: 'applied',
        sinks: [{ id: 'archive', progressSeq: 3 }],
      });
      expect(JSON.stringify(result)).not.toContain('receiverFingerprint');
      expect(await contents()).toEqual(before);
    });
    it('requires the exact retirement range and leaves all evidence in place', async () => {
      await sealEvents(5);
      await database.executor.batch([
        {
          sql: "UPDATE audit_chain SET policy = 'availability' WHERE org_id = ?",
          params: [org.orgId],
        },
        {
          sql: "UPDATE audit_sink SET state = 'disabled' WHERE org_id = ?",
          params: [org.orgId],
        },
      ]);
      await expect(
        admin({ operation: 'retire', sinkId: 'archive', confirm: 'archive' }),
      ).rejects.toThrow('confirmation mismatch');
      expect(await rows('audit_ledger')).toEqual([]);
      const snapshot = await port.read(org);
      expect(
        await admin({
          operation: 'retire',
          sinkId: 'archive',
          confirm: auditRetirementConfirmation('archive', 4, snapshot.headSeq),
        }),
      ).toEqual({ result: 'applied' });
      expect((await port.read(org)).sinks[0]).toMatchObject({
        state: 'retired',
        progressSeq: 3,
        custodySeq: 2,
      });
      expect(await rows('audit_ledger')).toEqual([
        expect.objectContaining({ kind: 'retire', sink_id: 'archive' }),
      ]);
    });
    it('leaves verification and evidence unchanged for an unchanged policy', async () => {
      const before = await contents();
      expect(await admin({ operation: 'policy_set', policy: 'required' })).toEqual({
        result: 'applied',
      });
      expect(await contents()).toEqual(before);
    });
    it('refuses a generation above storage and preserves each stored sink generation', async () => {
      const before = await contents();
      await expect(
        administerAuditSink(
          port,
          org,
          { operation: 'policy_set', policy: 'availability' },
          { generation: 999, now, actor, alert: () => {} },
        ),
      ).rejects.toMatchObject({ reason: 'generation_ahead' });
      expect(await contents()).toEqual(before);
      await database.executor.batch([
        {
          sql: `INSERT INTO audit_sink (org_id, sink_id, plugin_id, kind, generation, receiver_fingerprint,
          durable_ack, activation_source, state, progress_seq, progress_hash, custody_seq, inflight_repr)
          SELECT org_id, 'backup', plugin_id, kind, 1, receiver_fingerprint, durable_ack, activation_source,
          state, progress_seq, progress_hash, custody_seq, inflight_repr FROM audit_sink WHERE org_id = ? AND sink_id = 'archive'`,
          params: [org.orgId],
        },
      ]);
      await sealEvents(5);
      expect(await admin({ operation: 'rebind', sinkId: 'backup', fromSeq: 1 })).toEqual({
        result: 'applied',
      });
      expect(
        (await port.read(org)).sinks.map(({ id, generation }) => ({ id, generation })),
      ).toEqual([
        { id: 'archive', generation: 2 },
        { id: 'backup', generation: 1 },
      ]);
    });
    it('requires a local operator of the specified principal type', async () => {
      const before = await contents();
      const foreignId = ulid();
      await database.executor.batch([
        {
          sql: 'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
          params: [foreignId, database.orgs!.b.orgId, 'foreign@example.test'],
        },
      ]);
      for (const invalid of [
        { type: 'user', id: ulid() },
        { type: 'user', id: foreignId },
        { type: 'service_principal', id: actor.id },
      ] as const) {
        await expect(
          administerAuditSink(
            port,
            org,
            { operation: 'policy_set', policy: 'availability' },
            { generation: 2, now, actor: invalid, alert: () => {} },
          ),
        ).rejects.toMatchObject({ reason: 'actor_unavailable' });
      }
      expect(await contents()).toEqual(before);
      const principalId = ulid();
      await database.executor.batch([
        {
          sql: 'INSERT INTO service_principal (id, org_id, name, created_by_user_id) VALUES (?, ?, ?, ?)',
          params: [principalId, org.orgId, 'Operator', actor.id],
        },
      ]);
      expect(
        await administerAuditSink(
          port,
          org,
          { operation: 'policy_set', policy: 'availability' },
          {
            generation: 2,
            now,
            actor: { type: 'service_principal', id: principalId },
            alert: () => {},
          },
        ),
      ).toEqual({ result: 'applied' });
      expect(await rows('audit_ledger')).toEqual([
        expect.objectContaining({ actor_type: 'service_principal', actor_id: principalId }),
      ]);
    });
    it.each(['user', 'service_principal'] as const)(
      'requires an active %s both before and inside the save batch',
      async (type) => {
        const table = type === 'user' ? 'user_account' : 'service_principal';
        const id = type === 'user' ? actor.id : ulid();
        if (type === 'service_principal')
          await database.executor.batch([
            {
              sql: 'INSERT INTO service_principal (id, org_id, name, created_by_user_id) VALUES (?, ?, ?, ?)',
              params: [id, org.orgId, 'Operator', actor.id],
            },
          ]);
        const suspend = () =>
          database.executor.batch([
            {
              sql: `UPDATE ${table} SET status = 'suspended' WHERE org_id = ? AND id = ?`,
              params: [org.orgId, id],
            },
          ]);
        const invoke = (adminPort = port) =>
          administerAuditSink(
            adminPort,
            org,
            { operation: 'policy_set', policy: 'availability' },
            { generation: 2, now, actor: { type, id }, alert: () => {} },
          );
        await suspend();
        const before = await contents();
        await expect(invoke()).rejects.toMatchObject({ reason: 'actor_unavailable' });
        expect(await contents()).toEqual(before);
        await database.executor.batch([
          {
            sql: `UPDATE ${table} SET status = 'active' WHERE org_id = ? AND id = ?`,
            params: [org.orgId, id],
          },
        ]);
        expect(
          await invoke({
            ...port,
            save: async (...args) => {
              await suspend();
              return port.save(...args);
            },
          }),
        ).toEqual({ result: 'contended' });
        expect(await contents()).toEqual(before);
      },
    );
    it('refuses retiring without a required durable witness and preserves all evidence', async () => {
      await sealEvents(5);
      await database.executor.batch([
        {
          sql: "UPDATE audit_sink SET state = 'disabled' WHERE org_id = ?",
          params: [org.orgId],
        },
      ]);
      const before = await contents();
      await expect(
        admin({ operation: 'retire', sinkId: 'archive', confirm: 'archive:4-5' }),
      ).rejects.toMatchObject({ reason: 'required_witness' });
      expect(await contents()).toEqual(before);
    });
    it.each(['active', 'blocked', 'disabled', 'inactive'] as const)(
      'refuses retirement without a remaining range in state %s',
      async (state) => {
        await database.executor.batch([
          {
            sql: "UPDATE audit_sink SET state = ?, blocked_reason = CASE WHEN ? = 'blocked' THEN 'rejected' ELSE NULL END WHERE org_id = ?",
            params: [state, state, org.orgId],
          },
        ]);
        const before = await contents();
        await expect(
          admin({ operation: 'retire', sinkId: 'archive', confirm: 'archive:4-0' }),
        ).rejects.toMatchObject({
          reason: ['disabled', 'inactive'].includes(state) ? 'retire_empty' : 'retire_state',
        });
        expect(await contents()).toEqual(before);
      },
    );
    it('changes policy with a generation fence and one ledger/event pair', async () => {
      const before = await port.read(org);
      expect(await admin({ operation: 'policy_set', policy: 'availability' })).toEqual({
        result: 'applied',
      });
      expect(await port.read(org)).toMatchObject({
        policy: 'availability',
        modeGeneration: before.modeGeneration + 1,
      });
      expect(await rows('audit_ledger')).toEqual([
        expect.objectContaining({
          kind: 'policy_change',
          mode_generation: before.modeGeneration + 1,
        }),
      ]);
      expect(await rows('audit_pending')).toHaveLength(1);
      await database.executor.batch([
        { sql: "UPDATE audit_chain SET mode = 'none' WHERE org_id = ?", params: [org.orgId] },
      ]);
      await expect(admin({ operation: 'policy_set', policy: 'required' })).rejects.toMatchObject({
        reason: 'policy_unavailable',
      });
      expect((await port.read(org)).policy).toBe('availability');
      expect(await rows('audit_ledger')).toHaveLength(1);
    });
    it.each(["mode = 'none'", "pending_mode = 'none'", "mode = 'export'"])(
      'keeps the SQL required-policy guard when %s changes after read',
      async (assignment) => {
        await admin({ operation: 'policy_set', policy: 'availability' });
        const racing: AuditSinkAdminPort = {
          ...port,
          save: async (...args) => {
            await database.executor.batch([
              { sql: `UPDATE audit_chain SET ${assignment} WHERE org_id = ?`, params: [org.orgId] },
              {
                sql: 'UPDATE audit_sink SET durable_ack = 0 WHERE org_id = ?',
                params: [org.orgId],
              },
            ]);
            return port.save(...args);
          },
        };
        expect(await admin({ operation: 'policy_set', policy: 'required' }, racing)).toEqual({
          result: 'contended',
        });
        expect((await port.read(org)).policy).toBe('availability');
        expect(await rows('audit_ledger')).toHaveLength(1);
        expect(await rows('audit_pending')).toHaveLength(1);
      },
    );
    it('refuses stale builds and atomically rolls back admin evidence on a changed sink snapshot', async () => {
      const before = await contents();
      expect(
        await administerAuditSink(
          port,
          org,
          { operation: 'list' },
          { generation: 1, now, actor, alert: () => {} },
        ),
      ).toEqual({ result: 'stale' });
      expect(await contents()).toEqual(before);
      const racing: AuditSinkAdminPort = {
        ...port,
        save: async (...args) => {
          await database.executor.batch([
            {
              sql: 'UPDATE audit_sink SET body_version = body_version + 1 WHERE org_id = ?',
              params: [org.orgId],
            },
          ]);
          return port.save(...args);
        },
      };
      expect(await admin({ operation: 'policy_set', policy: 'availability' }, racing)).toEqual({
        result: 'contended',
      });
      expect(await rows('audit_ledger')).toEqual([]);
      expect(await rows('audit_pending')).toEqual([]);
    });
    it.each(['withheld', 'uncertain'] as const)(
      'resolves sink and global %s only with durable ACK coverage',
      async (kind) => {
        await sealEvents(3);
        const snapshot = await port.read(org);
        const ledger = createAuditLedgerRepository(database.executor);
        for (const sinkId of ['archive', null]) {
          const id = ulid();
          await ledger.append(org, [
            {
              id,
              kind,
              chainId: snapshot.chainId,
              epoch: snapshot.epoch,
              fromSeq: 1,
              toSeq: 3,
              count: 1,
              sinkId,
              reasonCode: 'partial_rejected',
              policy: 'required',
              modeGeneration: snapshot.modeGeneration,
              actorType: 'system',
              actorId: null,
              createdAt: now.toISOString(),
            },
          ]);
          await expect(
            admin({ operation: 'resolve', sinkId: 'archive', ledgerId: id }),
          ).rejects.toThrow('durable resolution unavailable');
          await database.executor.batch([
            {
              sql: `UPDATE audit_sink SET inflight_repr = ?, body_version = body_version + 1 WHERE org_id = ?`,
              params: [
                JSON.stringify({ custodyFromSeq: 1, durableAckRanges: [{ from: 1, to: 2 }] }),
                org.orgId,
              ],
            },
          ]);
          await expect(
            admin({ operation: 'resolve', sinkId: 'archive', ledgerId: id }),
          ).rejects.toThrow('durable resolution unavailable');
          await database.executor.batch([
            {
              sql: `UPDATE audit_sink SET inflight_repr = ?, body_version = body_version + 1 WHERE org_id = ?`,
              params: [
                JSON.stringify({ custodyFromSeq: 1, durableAckRanges: [{ from: 1, to: 3 }] }),
                org.orgId,
              ],
            },
          ]);
          expect(await admin({ operation: 'resolve', sinkId: 'archive', ledgerId: id })).toEqual({
            result: 'applied',
          });
          expect(await rows('audit_ledger')).toContainEqual(
            expect.objectContaining({ kind: 'replay', resolves_id: id, sink_id: 'archive' }),
          );
          await expect(
            admin({ operation: 'resolve', sinkId: 'archive', ledgerId: id }),
          ).rejects.toThrow('durable resolution unavailable');
          await database.executor.batch([
            {
              sql: `UPDATE audit_sink SET inflight_repr = '{"custodyFromSeq":1}', body_version = body_version + 1 WHERE org_id = ?`,
              params: [org.orgId],
            },
          ]);
        }
      },
    );
    it.each(['withheld', 'uncertain'] as const)(
      "cannot resolve another seeded sink's %s row",
      async (kind) => {
        await database.executor.batch([
          {
            sql: `INSERT INTO audit_sink (org_id, sink_id, plugin_id, kind, generation, receiver_fingerprint,
          durable_ack, activation_source, state, progress_seq, progress_hash, custody_seq, inflight_repr)
          SELECT org_id, 'backup', plugin_id, kind, generation, receiver_fingerprint, durable_ack, activation_source,
          state, progress_seq, progress_hash, custody_seq, inflight_repr FROM audit_sink WHERE org_id = ? AND sink_id = 'archive'`,
            params: [org.orgId],
          },
          {
            sql: 'UPDATE audit_sink SET inflight_repr = ? WHERE org_id = ?',
            params: [
              JSON.stringify({ custodyFromSeq: 1, durableAckRanges: [{ from: 1, to: 3 }] }),
              org.orgId,
            ],
          },
        ]);
        const snapshot = await port.read(org);
        const id = ulid();
        await createAuditLedgerRepository(database.executor).append(org, [
          {
            id,
            kind,
            chainId: snapshot.chainId,
            epoch: snapshot.epoch,
            fromSeq: 1,
            toSeq: 3,
            count: 1,
            sinkId: 'backup',
            reasonCode: 'unreadable',
            policy: snapshot.policy,
            modeGeneration: snapshot.modeGeneration,
            actorType: 'system',
            actorId: null,
            createdAt: now.toISOString(),
          },
        ]);
        const before = await contents();
        await expect(
          admin({ operation: 'resolve', sinkId: 'archive', ledgerId: id }),
        ).rejects.toMatchObject({ reason: 'durable_resolution_unavailable' });
        expect(await contents()).toEqual(before);
        expect(await admin({ operation: 'resolve', sinkId: 'backup', ledgerId: id })).toEqual({
          result: 'applied',
        });
      },
    );
    it('replays retained history without granting durable resolution and preserves queued markers', async () => {
      await sealEvents(3);
      await database.executor.batch([
        {
          sql: 'UPDATE audit_sink SET progress_hash = ?, inflight_repr = ? WHERE org_id = ?',
          params: [
            await hashOf(3),
            JSON.stringify({ custodyFromSeq: 1, registryMarkers: [{ kind: 'boundary' }] }),
            org.orgId,
          ],
        },
      ]);
      expect(await admin({ operation: 'replay', sinkId: 'archive', fromSeq: 2 })).toEqual({
        result: 'applied',
      });
      expect((await port.read(org)).sinks[0]).toMatchObject({
        progressSeq: 1,
        custodySeq: 1,
        progressHash: await hashOf(1),
      });
      expect(JSON.parse((await port.read(org)).sinks[0]!.inflightRepr!)).toMatchObject({
        registryMarkers: [{ kind: 'boundary' }],
        durableAckRanges: [],
      });
      expect(await rows('audit_ledger')).toEqual([
        expect.objectContaining({ kind: 'rebind', resolves_id: null }),
      ]);
      await expect(admin({ operation: 'replay', sinkId: 'archive', fromSeq: 0 })).rejects.toThrow(
        'Invalid audit replay range',
      );
    });
    it('blocks required sinks and atomically records the epoch, ledger and event; confirms with a fork marker', async () => {
      const before = await port.read(org);
      expect(await detectAuditFork(port, org, options())).toBe('blocked');
      const blocked = await port.read(org);
      expect(blocked).toMatchObject({
        ...before,
        epoch: 1,
        restorePending: true,
        boundaryReason: null,
        sinks: [expect.objectContaining({ state: 'blocked', blockedReason: 'fork' })],
      });
      expect(await rows('audit_ledger')).toEqual([
        expect.objectContaining({ kind: 'epoch_bump', policy: 'required', mode_generation: 0 }),
      ]);
      expect(await rows('audit_pending')).toEqual([
        expect.objectContaining({ action: 'audit.sink_admin' }),
      ]);
      expect(await rows('audit_chain')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            org_id: org.orgId,
            verified_at: null,
            verified_from_seq: null,
            journal_rows: 0,
            journal_bytes: 0,
          }),
        ]),
      );
      expect(
        await confirmAuditRestore(port, org, {
          alert: () => {},
          generation: 2,
          now,
          fromSeq: 1,
          actor: { type: 'user', id: '01JZZZZZZZZZZZZZZZZZZZZZZX' },
        }),
      ).toBe('confirmed');
      const confirmed = await port.read(org);
      expect(confirmed.sinks[0]).toMatchObject({
        state: 'active',
        blockedReason: null,
        progressSeq: 0,
        progressHash: zero,
        custodySeq: 0,
        attempt: 0,
        retryCountForSeq: 0,
        nextAttemptAt: null,
        lastErrorCode: null,
        inflightBody: null,
      });
      expect(JSON.parse(confirmed.sinks[0]!.inflightRepr!).registryMarkers[0]).toMatchObject({
        kind: 'fork',
        epoch: 1,
      });
      expect((await rows('audit_ledger')).map((row) => row.kind).sort()).toEqual([
        'epoch_bump',
        'restore_confirmed',
      ]);
    });
    it('does not bump or duplicate a tooling restore and preserves unrelated blocks and inactive states', async () => {
      await database.executor.batch([
        {
          sql: 'UPDATE audit_chain SET epoch = 7, incarnation = 4, restore_pending = 1 WHERE org_id = ?',
          params: [org.orgId],
        },
        {
          sql: "UPDATE audit_sink SET state = 'blocked', blocked_reason = 'receiver_changed' WHERE org_id = ?",
          params: [org.orgId],
        },
      ]);
      expect(await detectAuditFork(port, org, options())).toBe('blocked');
      expect(await rows('audit_ledger')).toEqual([]);
      expect(await rows('audit_pending')).toEqual([]);
      expect(
        await confirmAuditRestore(port, org, {
          alert: () => {},
          generation: 2,
          now,
          fromSeq: 1,
          actor: { type: 'user', id: '01JZZZZZZZZZZZZZZZZZZZZZZX' },
        }),
      ).toBe('confirmed');
      expect(await port.read(org)).toMatchObject({
        epoch: 7,
        incarnation: 4,
        restorePending: false,
        sinks: [expect.objectContaining({ state: 'blocked', blockedReason: 'receiver_changed' })],
      });
    });
    it.each(['inactive', 'disabled', 'retired'] as const)(
      'preserves %s sinks across detection and confirmation',
      async (state) => {
        await database.executor.batch([
          {
            sql: 'UPDATE audit_chain SET restore_pending = 1 WHERE org_id = ?',
            params: [org.orgId],
          },
          { sql: 'UPDATE audit_sink SET state = ? WHERE org_id = ?', params: [state, org.orgId] },
        ]);
        const before = (await port.read(org)).sinks[0]!;
        expect(await detectAuditFork(port, org, options())).toBe('blocked');
        expect(
          await confirmAuditRestore(port, org, {
            alert: () => {},
            generation: 2,
            now,
            fromSeq: 1,
            actor: { type: 'user', id: '01JZZZZZZZZZZZZZZZZZZZZZZX' },
          }),
        ).toBe('confirmed');
        const after = (await port.read(org)).sinks[0]!;
        expect(after.state).toBe(state);
        if (state === 'retired') expect(after).toEqual(before);
        else expect(JSON.parse(after.inflightRepr!).registryMarkers[0].kind).toBe('fork');
      },
    );
    it('rejects a lower acting generation inside the batch', async () => {
      const guarded = createAuditForkRepository(
        wrap(database.executor, async (statements) => {
          await database.executor.batch([
            { sql: 'UPDATE audit_sink SET generation = 9 WHERE org_id = ?', params: [org.orgId] },
          ]);
          return database.executor.batch(statements);
        }),
      );
      expect(await detectAuditFork(guarded, org, options())).toBe('stale');
      expect(await rows('audit_ledger')).toEqual([]);
      expect((await port.read(org)).epoch).toBe(0);
      expect(await detectAuditFork(port, org, { ...options(), generation: 1 })).toBe('stale');
    });
    it('fences the acting generation even when the complete snapshot is current', async () => {
      const expected = await port.read(org);
      const before = await contents();
      expect(
        await port.save(
          org,
          expected,
          [],
          {
            epoch: 1,
            restorePending: true,
            boundaryReason: 'epoch_bump',
            sinks: expected.sinks,
            ledger: [],
            event: null,
            now: now.toISOString(),
          },
          1,
        ),
      ).toBe(false);
      expect(await contents()).toEqual(before);
    });
    it.each([
      ['head moved', 'UPDATE audit_chain SET head_seq = 1 WHERE org_id = ?'],
      ['policy moved', "UPDATE audit_chain SET policy = 'availability' WHERE org_id = ?"],
      ['retry moved', 'UPDATE audit_sink SET attempt = attempt + 1 WHERE org_id = ?'],
      ['frozen bytes moved', "UPDATE audit_sink SET inflight_repr = '{}' WHERE org_id = ?"],
      [
        'body version bumped by a writer that keeps the bytes',
        'UPDATE audit_sink SET body_version = body_version + 1 WHERE org_id = ?',
      ],
      ['membership moved', 'DELETE FROM audit_sink WHERE org_id = ?'],
    ])('refuses concurrent changes: %s', async (_name, sql) => {
      const guarded = createAuditForkRepository(
        wrap(database.executor, async (statements) => {
          await database.executor.batch([{ sql, params: [org.orgId] }]);
          return database.executor.batch(statements);
        }),
      );
      const expected = await port.read(org);
      expect(
        await detectAuditFork({ ...guarded, read: async () => expected }, org, options()),
      ).toBe('contended');
      expect(await rows('audit_ledger')).toEqual([]);
      expect(await rows('audit_pending')).toEqual([]);
      expect((await port.read(org)).epoch).toBe(0);
    });
    it('CAS checks every exposed chain and sink field', async () => {
      const expected = await port.read(org);
      const change = {
        epoch: 1,
        restorePending: true,
        boundaryReason: 'epoch_bump' as const,
        sinks: expected.sinks,
        ledger: [],
        event: null,
        now: now.toISOString(),
      };
      const before = await contents();
      for (const [key, value] of Object.entries(expected)) {
        if (key === 'sinks') continue;
        expect(
          await port.save(
            org,
            {
              ...expected,
              [key]:
                typeof value === 'number'
                  ? value + 1
                  : typeof value === 'boolean'
                    ? !value
                    : 'moved',
            },
            [],
            change,
            2,
          ),
          key,
        ).toBe(false);
      }
      for (const [key, value] of Object.entries(expected.sinks[0]!)) {
        const moved = {
          ...expected.sinks[0]!,
          [key]:
            typeof value === 'number' ? value + 1 : typeof value === 'boolean' ? !value : 'moved',
        };
        expect(
          await port.save(
            org,
            { ...expected, sinks: [moved] },
            [],
            { ...change, sinks: [moved] },
            2,
          ),
          key,
        ).toBe(false);
      }
      expect(await contents()).toEqual(before);
    });
    it('rechecks observed journal hashes including absence', async () => {
      const expected = await port.read(org);
      const change = {
        epoch: 1,
        restorePending: true,
        boundaryReason: 'epoch_bump' as const,
        sinks: expected.sinks,
        ledger: [],
        event: null,
        now: now.toISOString(),
      };
      expect(await port.hashAt(org, 1)).toBeNull();
      expect(await port.save(org, expected, [{ seq: 1, hash: zero }], change, 2)).toBe(false);
      expect(await port.save(org, expected, [{ seq: 1, hash: null }], change, 2)).toBe(true);
    });
    it.each(['changed', 'deleted', 'inserted'] as const)(
      'refuses a journal hash %s after observation',
      async (operation) => {
        const insert = {
          sql: `INSERT INTO audit_event (id, org_id, seq, prev_hash, hash, created_at, actor_type, action, target_type)
        VALUES ('observed', ?, 1, ?, ?, '2026-10-30T00:00:00.000Z', 'system', 'org.update', 'organization')`,
          params: [org.orgId, zero, 'a'.repeat(64)],
        };
        if (operation !== 'inserted') await database.executor.batch([insert]);
        const expected = await port.read(org);
        const hash = await port.hashAt(org, 1);
        const guarded = createAuditForkRepository(
          wrap(database.executor, async (statements) => {
            await database.executor.batch([
              operation === 'inserted'
                ? insert
                : operation === 'deleted'
                  ? { sql: 'DELETE FROM audit_event WHERE org_id = ?', params: [org.orgId] }
                  : {
                      sql: 'UPDATE audit_event SET hash = ? WHERE org_id = ?',
                      params: ['b'.repeat(64), org.orgId],
                    },
            ]);
            return database.executor.batch(statements);
          }),
        );
        expect(
          await guarded.save(
            org,
            expected,
            [{ seq: 1, hash }],
            {
              epoch: 1,
              restorePending: true,
              boundaryReason: 'epoch_bump',
              sinks: expected.sinks,
              ledger: [],
              event: null,
              now: now.toISOString(),
            },
            2,
          ),
        ).toBe(false);
        expect((await port.read(org)).epoch).toBe(0);
      },
    );
    it('keeps a large sink set in one bounded atomic batch', async () => {
      await database.executor.batch([
        {
          sql: `WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM ids WHERE n < 250)
          INSERT INTO audit_sink (org_id, sink_id, plugin_id, kind, generation, receiver_fingerprint,
            durable_ack, activation_source, state, progress_seq, progress_hash, custody_seq)
          SELECT ?, 'sink-' || n, 'audit', 'webhook', 2, ?, 1, 'ARCHIVE_URL', 'active', 3, ?, 2 FROM ids`,
          params: [org.orgId, 'a'.repeat(64), zero],
        },
      ]);
      let batches = 0;
      const bounded = createAuditForkRepository(
        wrap(database.executor, async (statements) => {
          batches++;
          expect(statements.length).toBeLessThanOrEqual(200);
          expect(
            Math.max(...statements.map((statement) => statement.params.length)),
          ).toBeLessThanOrEqual(90);
          return database.executor.batch(statements);
        }),
      );
      expect(await detectAuditFork(bounded, org, options())).toBe('blocked');
      expect(batches).toBe(1);
      expect((await port.read(org)).sinks).toHaveLength(251);
      expect((await port.read(org)).sinks.every((row) => row.state === 'blocked')).toBe(true);
    });
    it('refuses a batch that cannot fit before submitting any writes', async () => {
      const expected = await port.read(org);
      const before = await contents();
      let submitted = false;
      const bounded = createAuditForkRepository(
        wrap(database.executor, async (statements) => {
          submitted = true;
          return database.executor.batch(statements);
        }),
      );
      await expect(
        bounded.save(
          org,
          expected,
          [],
          {
            epoch: 1,
            restorePending: true,
            boundaryReason: null,
            sinks: expected.sinks,
            ledger: Array.from({ length: 200 }, (_, index) => ({
              id: String(index).padStart(26, '0'),
              kind: 'epoch_bump' as const,
              chainId: expected.chainId,
              epoch: 1,
              fromSeq: 1,
              toSeq: 1,
              count: 0,
              sinkId: null,
              reasonCode: 'local_fork',
              policy: expected.policy,
              modeGeneration: expected.modeGeneration,
              actorType: 'system' as const,
              actorId: null,
              createdAt: now.toISOString(),
            })),
            event: null,
            now: now.toISOString(),
          },
          2,
        ),
      ).rejects.toMatchObject({ name: 'AuditForkLimitError', reason: 'batch_limit' });
      expect(submitted).toBe(false);
      expect(await contents()).toEqual(before);
    });
    it('rolls back on failure after every statement and stays within both batch budgets', async () => {
      const before = await contents();
      let length = 0;
      const recording = createAuditForkRepository(
        wrap(database.executor, async (statements) => {
          length = statements.length;
          expect(length).toBeLessThanOrEqual(200);
          expect(
            Math.max(...statements.map((statement) => statement.params.length)),
          ).toBeLessThanOrEqual(90);
          throw new Error('recorded');
        }),
      );
      await expect(detectAuditFork(recording, org, options())).rejects.toThrow('recorded');
      for (let index = 0; index < length; index++) {
        const failing = createAuditForkRepository(
          wrap(database.executor, async (statements) => {
            const next = [...statements];
            next.splice(index + 1, 0, {
              sql: 'SELECT * FROM missing_audit_fork_table',
              params: [],
            });
            return database.executor.batch(next);
          }),
        );
        await expect(detectAuditFork(failing, org, options())).rejects.toThrow();
        expect(await contents(), `statement ${index}`).toEqual(before);
      }
    });
    it('does not re-fork on restart immediately after confirmation', async () => {
      expect(await detectAuditFork(port, org, options())).toBe('blocked');
      await confirmAuditRestore(port, org, {
        alert: () => {},
        generation: 2,
        now,
        fromSeq: 1,
        actor: { type: 'user', id: actor.id },
      });
      const current = await port.read(org);
      const before = await contents();
      expect(
        await detectAuditFork(createAuditForkRepository(database.executor), org, {
          ...options(),
          probes: [
            {
              id: 'archive',
              sink: {
                deliver: async () => {
                  throw new Error('unused');
                },
                frontier: async () => ({ chainId: current.chainId, epoch: 0, seq: 3, hash: zero }),
              },
            },
          ],
        }),
      ).toBe('clear');
      expect(await contents()).toEqual(before);
    });
    it('persists detection and confirmation for twelve sinks with maximum-size frozen bodies', async () => {
      const body = JSON.stringify({
        chainId: (await port.read(org)).chainId,
        epoch: 0,
        padding: '',
      });
      const large = body.slice(0, -2) + 'x'.repeat(512 * 1024 - body.length) + body.slice(-2);
      expect(new TextEncoder().encode(large)).toHaveLength(512 * 1024);
      await database.executor.batch([
        {
          sql: `WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM ids WHERE n < 11)
          INSERT INTO audit_sink (org_id, sink_id, plugin_id, kind, generation, receiver_fingerprint, durable_ack, activation_source, state, progress_seq, progress_hash, custody_seq)
          SELECT org_id, 'sink-' || n, plugin_id, kind, generation, receiver_fingerprint, durable_ack, activation_source, state, progress_seq, progress_hash, custody_seq FROM audit_sink, ids WHERE org_id = ?`,
          params: [org.orgId],
        },
        {
          sql: 'UPDATE audit_sink SET inflight_body = ?, inflight_repr = ?, inflight_from = 4, inflight_to = 4 WHERE org_id = ?',
          params: [
            large,
            JSON.stringify({ custodyFromSeq: 1, registryMarkerBody: large }),
            org.orgId,
          ],
        },
      ]);
      expect((await port.read(org)).sinks).toHaveLength(12);
      const bounded = createAuditForkRepository(
        wrap(database.executor, async (statements) => {
          expect(statements.some((statement) => statement.sql.includes('hex('))).toBe(false);
          expect(
            statements
              .flatMap((statement) => statement.params)
              .reduce<number>(
                (total, value) =>
                  total + (typeof value === 'string' ? new TextEncoder().encode(value).length : 0),
                0,
              ),
          ).toBeLessThan(64 * 1024);
          expect(statements.length).toBeLessThanOrEqual(200);
          expect(
            Math.max(...statements.map((statement) => statement.params.length)),
          ).toBeLessThanOrEqual(90);
          for (const statement of statements)
            for (const value of statement.params)
              if (typeof value === 'string')
                expect(new TextEncoder().encode(value).length).toBeLessThan(256 * 1024);
          return database.executor.batch(statements);
        }),
      );
      expect(await detectAuditFork(bounded, org, options())).toBe('blocked');
      expect((await port.read(org)).sinks.every((row) => row.inflightBody === large)).toBe(true);
      const expected = await bounded.read(org);
      await database.executor.batch([
        {
          sql: "UPDATE audit_sink SET inflight_body = ? WHERE org_id = ? AND sink_id = 'archive'",
          params: [large.replace('xxx', 'xyx'), org.orgId],
        },
      ]);
      expect(
        await bounded.save(
          org,
          expected,
          [],
          {
            epoch: expected.epoch,
            restorePending: false,
            boundaryReason: expected.boundaryReason,
            sinks: expected.sinks,
            ledger: [],
            event: null,
            now: now.toISOString(),
          },
          2,
        ),
      ).toBe(false);
      await database.executor.batch([
        {
          sql: 'UPDATE audit_sink SET inflight_body = ? WHERE org_id = ?',
          params: [large, org.orgId],
        },
      ]);
      expect(
        await confirmAuditRestore(bounded, org, {
          alert: () => {},
          generation: 2,
          now,
          fromSeq: 1,
          actor: { type: 'user', id: actor.id },
        }),
      ).toBe('confirmed');
      const confirmed = await port.read(org);
      expect(confirmed.restorePending).toBe(false);
      expect(
        confirmed.sinks.every(
          (row) =>
            row.state === 'active' &&
            row.inflightBody === null &&
            JSON.parse(row.inflightRepr!).registryMarkers[0].kind === 'fork',
        ),
      ).toBe(true);
    });
    it.each([false, true])(
      'guards only seq gaps intersecting the retained window: inside=%s',
      async (inside) => {
        await database.executor.batch([
          {
            sql: 'UPDATE audit_chain SET head_seq = 5, boundary_seq = 4 WHERE org_id = ?',
            params: [org.orgId],
          },
        ]);
        const expected = await port.read(org);
        const guarded = createAuditForkRepository(
          wrap(database.executor, async (statements) => {
            await database.executor.batch([
              {
                sql: `INSERT INTO audit_ledger (id, org_id, kind, chain_id, epoch, from_seq, to_seq, count, reason_code, policy, mode_generation, actor_type, created_at)
          SELECT 'concurrent-gap', org_id, 'gap', chain_id, epoch, ?, ?, 0, 'seq_gap', policy, mode_generation, 'system', ? FROM audit_chain WHERE org_id = ?`,
                params: [inside ? 3 : 2, inside ? 3 : 2, now.toISOString(), org.orgId],
              },
            ]);
            return database.executor.batch(statements);
          }),
        );
        expect(
          await guarded.save(
            org,
            expected,
            [],
            {
              epoch: 1,
              restorePending: true,
              boundaryReason: null,
              sinks: expected.sinks,
              ledger: [],
              event: null,
              now: now.toISOString(),
            },
            2,
          ),
        ).toBe(!inside);
      },
    );
    it('reads only current window gaps, the latest current confirmation and chain resets', async () => {
      await database.executor.batch([
        {
          sql: 'UPDATE audit_chain SET head_seq = 5, boundary_seq = 4 WHERE org_id = ?',
          params: [org.orgId],
        },
      ]);
      for (const [id, kind, epoch, from, to, foreignChain] of [
        ['intersect', 'gap', 0, 2, 3, false],
        ['outside', 'gap', 0, 1, 2, false],
        ['future', 'gap', 0, 6, 7, false],
        ['old-epoch', 'gap', 1, 3, 5, false],
        ['old-chain', 'gap', 0, 3, 5, true],
        ['confirm-a', 'restore_confirmed', 0, 1, 1, false],
        ['confirm-b', 'restore_confirmed', 0, 2, 2, false],
        ['confirm-old', 'restore_confirmed', 1, 1, 1, false],
        ['reset', 'chain_reset', 1, 1, 1, true],
        ['reset-older', 'chain_reset', 0, 1, 1, true],
        ['reset-current', 'chain_reset', 0, 1, 1, false],
      ] as const) {
        await database.executor.batch([
          {
            sql: `INSERT INTO audit_ledger (id, org_id, kind, chain_id, epoch, from_seq, to_seq, count, reason_code, policy, mode_generation, actor_type, created_at)
          SELECT ?, org_id, ?, ?, ?, ?, ?, 0, 'seq_gap', policy, mode_generation, 'system', ? FROM audit_chain WHERE org_id = ?`,
            params: [
              id,
              kind,
              foreignChain ? 'f'.repeat(32) : (await port.read(org)).chainId,
              epoch,
              from,
              to,
              now.toISOString(),
              org.orgId,
            ],
          },
        ]);
      }
      expect((await port.read(org)).history).toEqual([
        expect.objectContaining({ kind: 'chain_reset' }),
        expect.objectContaining({ kind: 'gap', fromSeq: 2, toSeq: 3 }),
        expect.objectContaining({ kind: 'restore_confirmed', fromSeq: 2 }),
      ]);
    });
    it('refuses capped history with a named error and a core alert', async () => {
      await database.executor.batch([
        {
          sql: 'UPDATE audit_chain SET head_seq = 2048 WHERE org_id = ?',
          params: [org.orgId],
        },
        {
          sql: `WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM ids WHERE n < 1024)
        INSERT INTO audit_ledger (id, org_id, kind, chain_id, epoch, from_seq, to_seq, count, reason_code, policy, mode_generation, actor_type, created_at)
        SELECT 'gap-' || n, org_id, 'gap', chain_id, epoch, 2 * n, 2 * n, 1, 'seq_gap', policy, mode_generation, 'system', ? FROM audit_chain, ids WHERE org_id = ?`,
          params: [now.toISOString(), org.orgId],
        },
      ]);
      const alerts: string[] = [];
      await expect(
        detectAuditFork(port, org, { ...options(), alert: (reason) => alerts.push(reason) }),
      ).rejects.toMatchObject({ name: 'AuditForkLimitError', reason: 'history_limit' });
      expect(alerts).toEqual(['history_limit']);
      expect((await rows('audit_chain'))[0]!.restore_pending).toBe(0);
    });
    async function bodyVersions() {
      return (
        await database.executor.all<{ sink_id: string; body_version: number }>({
          sql: 'SELECT sink_id, body_version FROM audit_sink WHERE org_id = ? ORDER BY sink_id',
          params: [org.orgId],
        })
      ).map((row) => row.body_version);
    }
    async function seqGap(id: string, from: number, to: number, sinkId: string | null = null) {
      await database.executor.batch([
        {
          sql: `INSERT INTO audit_ledger (id, org_id, kind, chain_id, epoch, from_seq, to_seq, count, sink_id, reason_code, policy, mode_generation, actor_type, created_at)
          SELECT ?, org_id, 'gap', chain_id, epoch, ?, ?, ? - ? + 1, ?, 'seq_gap', policy, mode_generation, 'system', ? FROM audit_chain WHERE org_id = ?`,
          params: [id, from, to, to, from, sinkId, now.toISOString(), org.orgId],
        },
      ]);
    }
    it('ignores sink-scoped seq gaps in the history', async () => {
      await database.executor.batch([
        {
          sql: 'UPDATE audit_chain SET head_seq = 5, boundary_seq = 1 WHERE org_id = ?',
          params: [org.orgId],
        },
      ]);
      await seqGap('01JZZZZZZZZZZZZZZZZZZZZZZA', 2, 2, 'archive');
      await seqGap('01JZZZZZZZZZZZZZZZZZZZZZZB', 4, 4);
      expect((await port.read(org)).history).toEqual([
        expect.objectContaining({ id: '01JZZZZZZZZZZZZZZZZZZZZZZB', fromSeq: 4 }),
      ]);
    });
    it('carries recorded seq gaps into the new epoch so a confirmed restore does not re-fork', async () => {
      const events = [1, 2, 3, 4, 5].map((seq) => ({
        seq,
        hash: String(seq).repeat(64),
        prev: seq === 1 ? zero : String(seq - 1).repeat(64),
      }));
      await database.executor.batch([
        ...events
          .filter(({ seq }) => seq !== 3)
          .map(({ seq, hash, prev }) => ({
            sql: `INSERT INTO audit_event (id, org_id, seq, prev_hash, hash, created_at, actor_type, action, target_type)
            VALUES (?, ?, ?, ?, ?, '2026-10-30T00:00:00.000Z', 'system', 'org.update', 'organization')`,
            params: [`event-${seq}`, org.orgId, seq, prev, hash],
          })),
        {
          sql: 'UPDATE audit_chain SET head_seq = 5, head_hash = ?, boundary_seq = 1 WHERE org_id = ?',
          params: ['5'.repeat(64), org.orgId],
        },
        {
          sql: 'UPDATE audit_sink SET progress_seq = 3, progress_hash = ?, custody_seq = 2 WHERE org_id = ?',
          params: ['3'.repeat(64), org.orgId],
        },
      ]);
      await seqGap('01JZZZZZZZZZZZZZZZZZZZZZZC', 3, 3);
      const receiver = (seq: number, epoch: number) => ({
        id: 'archive',
        sink: {
          deliver: async () => {
            throw new Error('unused');
          },
          frontier: async () => ({
            chainId: (await port.read(org)).chainId,
            epoch,
            seq,
            hash: String(seq).repeat(64),
          }),
        },
      });
      expect(await detectAuditFork(port, org, { ...options(), probes: [receiver(3, 0)] })).toBe(
        'clear',
      );
      await database.executor.batch([
        { sql: 'UPDATE audit_sink SET progress_seq = 6 WHERE org_id = ?', params: [org.orgId] },
      ]);
      expect(await detectAuditFork(port, org, options())).toBe('blocked');
      expect((await port.read(org)).epoch).toBe(1);
      expect(
        await database.executor.all({
          sql: "SELECT epoch, from_seq AS fromSeq, to_seq AS toSeq, count, sink_id AS sinkId FROM audit_ledger WHERE org_id = ? AND kind = 'gap' ORDER BY epoch",
          params: [org.orgId],
        }),
      ).toEqual([
        { epoch: 0, fromSeq: 3, toSeq: 3, count: 1, sinkId: null },
        { epoch: 1, fromSeq: 3, toSeq: 3, count: 1, sinkId: null },
      ]);
      expect(
        await confirmAuditRestore(port, org, {
          alert: () => {},
          generation: 2,
          now,
          fromSeq: 5,
          actor: { type: 'user', id: actor.id },
        }),
      ).toBe('confirmed');
      expect((await port.read(org)).sinks[0]).toMatchObject({ progressSeq: 4, state: 'active' });
      const before = await contents();
      expect(await detectAuditFork(port, org, { ...options(), probes: [receiver(3, 1)] })).toBe(
        'clear',
      );
      expect(await contents()).toEqual(before);
    });
    it('increments body_version in the fork save for detection and confirmation', async () => {
      expect(await bodyVersions()).toEqual([0]);
      expect(await detectAuditFork(port, org, options())).toBe('blocked');
      expect(await bodyVersions()).toEqual([1]);
      expect((await port.read(org)).sinks[0]!.bodyVersion).toBe(1);
      expect(
        await confirmAuditRestore(port, org, {
          alert: () => {},
          generation: 2,
          now,
          fromSeq: 1,
          actor: { type: 'user', id: actor.id },
        }),
      ).toBe('confirmed');
      expect(await bodyVersions()).toEqual([2]);
    });
    it('increments body_version in the registry upsert', async () => {
      const registry = createAuditSinkRepository(database.executor);
      const expected = await registry.read(org);
      expect(
        await registry.save(org, expected, {
          generation: 2,
          sinks: expected.sinks,
          rebinds: [],
          now: now.toISOString(),
        }),
      ).toBe(true);
      expect(await bodyVersions()).toEqual([1]);
    });
    it('increments body_version for any other writer of the frozen columns and keeps it monotonic', async () => {
      await database.executor.batch([
        {
          sql: `UPDATE audit_sink SET inflight_repr = '{"custodyFromSeq":1,"purpose":"idle"}' WHERE org_id = ?`,
          params: [org.orgId],
        },
      ]);
      expect(await bodyVersions()).toEqual([1]);
      await database.executor.batch([
        {
          sql: `UPDATE audit_sink SET inflight_repr = inflight_repr, attempt = attempt WHERE org_id = ?`,
          params: [org.orgId],
        },
      ]);
      expect(await bodyVersions()).toEqual([1]);
      await expect(
        database.executor.batch([
          {
            sql: `UPDATE audit_sink SET body_version = 0, inflight_repr = '{"custodyFromSeq":1}' WHERE org_id = ?`,
            params: [org.orgId],
          },
        ]),
      ).rejects.toThrow(/monotonic/);
      expect(await bodyVersions()).toEqual([1]);
    });
    async function sealEvents(count: number) {
      await database.executor.batch(
        Array.from({ length: count }, () => ({
          sql: `INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type)
          VALUES (?, ?, '2026-10-30T00:00:00.000Z', 'system', 'org.update', 'organization')`,
          params: [ulid(), org.orgId],
        })),
      );
      return createAuditSealRepository(database.executor).seal(org);
    }
    async function hashOf(seq: number) {
      return (await port.hashAt(org, seq))!;
    }
    const receiverAhead = (): { id: string; sink: AuditSink } => ({
      id: 'archive',
      sink: {
        deliver: async () => {
          throw new Error('unused');
        },
        frontier: async () => ({
          chainId: (await port.read(org)).chainId,
          epoch: 99,
          seq: 1,
          hash: zero,
        }),
      },
    });
    const confirm = (fromSeq: number) =>
      confirmAuditRestore(port, org, {
        alert: () => {},
        generation: 2,
        now,
        fromSeq,
        actor: { type: 'user', id: actor.id },
      });
    it('never re-allocates a gap above a rolled-back head after a fork bump and confirmation', async () => {
      await sealEvents(3);
      const two = await hashOf(2);
      await database.executor.batch([
        { sql: 'DELETE FROM audit_event WHERE org_id = ? AND seq = 3', params: [org.orgId] },
      ]);
      await createAuditSealRepository(database.executor).seal(org);
      await database.executor.batch([
        {
          sql: 'UPDATE audit_chain SET head_seq = 2, head_hash = ? WHERE org_id = ?',
          params: [two, org.orgId],
        },
      ]);
      expect(await detectAuditFork(port, org, options())).toBe('blocked');
      expect(await confirm(3)).toBe('confirmed');
      expect(await sealEvents(1)).toMatchObject({ outcome: 'sealed' });
      const seqs = (
        await database.executor.all<{ seq: number }>({
          sql: 'SELECT seq FROM audit_event WHERE org_id = ? ORDER BY seq',
          params: [org.orgId],
        })
      ).map((row) => row.seq);
      expect(seqs.slice(0, 3)).toEqual([1, 2, 4]);
      expect(seqs).not.toContain(3);
    });
    async function exportUntilIdle() {
      await database.executor.batch([
        {
          sql: `INSERT OR IGNORE INTO job (id, org_id, type, resource_key, state, lease_owner, fence, lease_until)
          VALUES ('export-job', ?, 'audit-export-archive', 'audit-export:archive', 'running', 'worker', 3, '2099-01-01T00:00:00.000Z')`,
          params: [org.orgId],
        },
      ]);
      const delivered: AuditBatchV1[] = [];
      for (let attempt = 0; attempt < 10; attempt++) {
        const result = await exportAuditBatch(
          createAuditExportRepository(database.executor),
          org,
          systemMutationFence('audit-export', { id: 'export-job', owner: 'worker', fence: 3 }, {}),
          {
            id: 'archive',
            generation: 2,
            pluginVersion: '1.0',
            sourceIp: 'omit',
            now: () => new Date(),
            random: () => 0,
            sink: {
              deliver: async (batch) => {
                delivered.push(batch);
                return {
                  outcome: 'accepted',
                  chainId: batch.chainId,
                  epoch: batch.epoch,
                  throughSeq: batch.throughSeq,
                  throughHash: batch.throughHash,
                };
              },
            },
            rejectionRetries: 'terminal',
          },
          new AbortController().signal,
        );
        if (result === 'idle') break;
      }
      return delivered;
    }
    it('records a held partial outcome as an uncertain disposition when confirmation discards it', async () => {
      await sealEvents(3);
      const current = await port.read(org);
      await database.executor.batch([
        {
          sql: `UPDATE audit_sink SET progress_seq = 1, progress_hash = ?, custody_seq = 1,
            inflight_from = 2, inflight_to = 3, inflight_body = ?, inflight_repr = ? WHERE org_id = ?`,
          params: [
            await hashOf(1),
            JSON.stringify({
              v: 1,
              chainId: current.chainId,
              epoch: current.epoch,
              orgId: org.orgId,
              records: [{ seq: 2 }, { seq: 3 }],
              throughSeq: 3,
              throughHash: await hashOf(3),
            }),
            JSON.stringify({
              custodyFromSeq: 1,
              purpose: 'events',
              uncertainOutcome: { rejectedCount: 1 },
            }),
            org.orgId,
          ],
        },
      ]);
      expect(await detectAuditFork(port, org, { ...options(), probes: [receiverAhead()] })).toBe(
        'blocked',
      );
      expect(await confirm(4)).toBe('confirmed');
      expect(
        await database.executor.all({
          sql: "SELECT kind, epoch, from_seq, to_seq, count, sink_id, reason_code FROM audit_ledger WHERE org_id = ? AND kind = 'uncertain'",
          params: [org.orgId],
        }),
      ).toEqual(
        [0, 1].map((epoch) => ({
          kind: 'uncertain',
          epoch,
          from_seq: 2,
          to_seq: 3,
          count: 1,
          sink_id: 'archive',
          reason_code: 'partial_rejected',
        })),
      );
      expect(JSON.parse((await port.read(org)).sinks[0]!.inflightRepr!)).not.toHaveProperty(
        'uncertainOutcome',
      );
      await database.executor.batch([
        { sql: "UPDATE audit_chain SET mode = 'export' WHERE org_id = ?", params: [org.orgId] },
      ]);
      expect(
        (await exportUntilIdle()).flatMap((batch) =>
          batch.records.flatMap((record) => ('seq' in record ? [record.seq] : [])),
        ),
      ).toEqual([2, 3]);
      const [obligation] = await database.executor.all<{ id: string }>({
        sql: "SELECT id FROM audit_ledger WHERE org_id = ? AND kind = 'uncertain' AND epoch = 1",
        params: [org.orgId],
      });
      expect(
        await database.executor.all({
          sql: "SELECT epoch, from_seq, to_seq, sink_id, resolves_id FROM audit_ledger WHERE org_id = ? AND kind = 'replay'",
          params: [org.orgId],
        }),
      ).toEqual([
        { epoch: 1, from_seq: 2, to_seq: 3, sink_id: 'archive', resolves_id: obligation!.id },
      ]);
    });
    it('keeps a required withheld hold on pruning across a bump and confirmation', async () => {
      await sealEvents(3);
      const current = await port.read(org);
      await database.executor.batch([
        {
          sql: `UPDATE audit_sink SET progress_seq = 3, progress_hash = ?, custody_seq = 3 WHERE org_id = ?`,
          params: [await hashOf(3), org.orgId],
        },
        { sql: "UPDATE audit_chain SET mode = 'export' WHERE org_id = ?", params: [org.orgId] },
      ]);
      await createAuditLedgerRepository(database.executor).append(org, [
        {
          id: ulid(),
          kind: 'withheld',
          chainId: current.chainId,
          epoch: current.epoch,
          fromSeq: 1,
          toSeq: 1,
          count: 1,
          sinkId: 'archive',
          reasonCode: 'unreadable',
          policy: 'required',
          modeGeneration: current.modeGeneration,
          actorType: 'system',
          actorId: null,
          createdAt: now.toISOString(),
        },
      ]);
      const prune = () =>
        createAuditPruneRepository(database.executor).prune(org, {
          generation: 2,
          configuredSinkIds: ['archive'],
          trailActive: false,
        });
      expect(await prune()).toEqual({ outcome: 'retained' });
      expect(await detectAuditFork(port, org, { ...options(), probes: [receiverAhead()] })).toBe(
        'blocked',
      );
      expect(await confirm(4)).toBe('confirmed');
      expect((await port.read(org)).sinks[0]).toMatchObject({ state: 'active', custodySeq: 3 });
      expect(await prune()).toEqual({ outcome: 'retained' });
    });
    it('lets a lagging exporter deliver capacity gaps recorded before a bump and confirmation', async () => {
      await sealEvents(12);
      await database.executor.batch([
        {
          sql: `UPDATE audit_sink SET progress_seq = 0, progress_hash = ?, custody_seq = 0 WHERE org_id = ?`,
          params: [zero, org.orgId],
        },
        {
          sql: "UPDATE audit_chain SET mode = 'export', policy = 'availability' WHERE org_id = ?",
          params: [org.orgId],
        },
        {
          sql: `INSERT INTO job (id, org_id, type, resource_key, state, lease_owner, fence, lease_until)
          VALUES ('export-job', ?, 'audit-export-archive', 'audit-export:archive', 'running', 'worker', 3, '2099-01-01T00:00:00.000Z')`,
          params: [org.orgId],
        },
      ]);
      expect(
        await createAuditPruneRepository(database.executor).evict(org, {
          generation: 2,
          maxJournalBytes: 1,
          limit: 10,
        }),
      ).toMatchObject({ outcome: 'evicted', boundarySeq: 11 });
      expect(await detectAuditFork(port, org, { ...options(), probes: [receiverAhead()] })).toBe(
        'blocked',
      );
      expect(await confirm(11)).toBe('confirmed');
      const delivered: AuditBatchV1[] = [];
      const run = () =>
        exportAuditBatch(
          createAuditExportRepository(database.executor),
          org,
          systemMutationFence('audit-export', { id: 'export-job', owner: 'worker', fence: 3 }, {}),
          {
            id: 'archive',
            generation: 2,
            pluginVersion: '1.0',
            sourceIp: 'omit',
            now: () => new Date(),
            random: () => 0,
            sink: {
              deliver: async (batch) => {
                delivered.push(batch);
                return {
                  outcome: 'accepted',
                  chainId: batch.chainId,
                  epoch: batch.epoch,
                  throughSeq: batch.throughSeq,
                  throughHash: batch.throughHash,
                };
              },
            },
            rejectionRetries: 'terminal',
          },
          new AbortController().signal,
        );
      for (let attempt = 0; attempt < 10 && (await run()) !== 'idle'; attempt++);
      const records = delivered.flatMap((batch) => batch.records);
      expect(records.find((record) => record.kind === 'gap')).toMatchObject({
        reason: 'capacity',
        fromSeq: 1,
        toSeq: 10,
      });
      expect(records.flatMap((record) => ('seq' in record ? [record.seq] : []))).toEqual([11, 12]);
      expect((await port.read(org)).sinks[0]).toMatchObject({ progressSeq: 12 });
    });
    it('isolates foreign generation, chain, sinks, ledger, pending and verification', async () => {
      const foreign = database.orgs!.b;
      await seedAuditFork(database.executor, foreign);
      await database.executor.batch([
        { sql: 'UPDATE audit_sink SET generation = 99 WHERE org_id = ?', params: [foreign.orgId] },
      ]);
      const foreignBefore = await port.read(foreign);
      expect(await detectAuditFork(port, org, options())).toBe('blocked');
      expect(await port.read(foreign)).toEqual(foreignBefore);
      expect(
        (await rows('audit_chain')).find((row) => row.org_id === foreign.orgId)?.verified_at,
      ).toBe(now.toISOString());
      expect(
        (await rows('organization')).find((row) => row.id === foreign.orgId)
          ?.audit_last_verified_at,
      ).toBe(now.toISOString());
      expect(await rows('audit_ledger')).toEqual([expect.objectContaining({ org_id: org.orgId })]);
      expect(await rows('audit_pending')).toEqual([expect.objectContaining({ org_id: org.orgId })]);
    });
  });
}
