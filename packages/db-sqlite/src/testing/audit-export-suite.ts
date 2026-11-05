import { jobFences } from '@package-broker/core/platform/job-fences';
import type { JobContext } from '@package-broker/core/platform/jobs';
import type { AuditLedgerEntry } from '@package-broker/core/audit/ledger';
import { createAuditLedgerRepository } from '../repositories/audit-ledger.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  exportAuditBatch,
  auditExportJob,
  auditDurableCoverage,
  auditInflightEventRange,
  type AuditExportPort,
  type AuditExportSnapshot,
  type AuditExportState,
} from '@package-broker/core/audit/export';
import { systemMutationFence } from '@package-broker/core/authz/fence';
import { orgContext, type SqlExecutor, type Statement } from '@package-broker/core/db/port';
import { createAuditExportRepository } from '../repositories/audit-export.js';
import { auditEvent } from '@package-broker/core/audit/actions';
import { ulid } from '@package-broker/core/ids';
import { createAuditPruneRepository } from '../repositories/audit-prune.js';
import { createAuditSealRepository } from '../repositories/audit-seal.js';
import type { MigratedDatabase } from './migrated-database.js';

export function auditExportRepositorySuite(open: () => Promise<MigratedDatabase>): void {
  let database: MigratedDatabase;
  const org = () => database.orgs!.a;
  const foreign = () => database.orgs!.b;
  const port = () => createAuditExportRepository(database.executor);
  const fence = (job = { id: 'export-job', owner: 'worker', fence: 3 }) =>
    systemMutationFence('audit-export', job, {});
  const seed = (sql: string, ...params: (string | number | null)[]) =>
    database.executor.batch([{ sql, params }]);
  beforeEach(async () => {
    database = await open();
    for (const ctx of [org(), foreign()]) {
      await seed(
        `INSERT INTO audit_sink (org_id, sink_id, plugin_id, kind, generation,
        receiver_fingerprint, durable_ack, activation_source, state, progress_seq, progress_hash,
        custody_seq, inflight_repr) VALUES (?, 'archive', 'audit', 'webhook', 1, 'fingerprint',
        1, 'ARCHIVE_URL', 'active', 0, ?, 0, ?)`,
        ctx.orgId,
        '0'.repeat(64),
        '{"custodyFromSeq":1}',
      );
    }
    await seed(
      `INSERT INTO job (id, org_id, type, resource_key, state, lease_owner, fence, lease_until)
      VALUES ('export-job', ?, 'audit-export-archive', 'audit-export:archive', 'running', 'worker', 3, '2099-01-01T00:00:00.000Z')`,
      org().orgId,
    );
  });
  afterEach(async () => database.close());

  function sending(sink: AuditExportState): AuditExportState {
    return {
      ...sink,
      inflightFrom: 1,
      inflightTo: 2,
      inflightBody: '{"frozen":"bytes"}',
      inflightRepr: '{"custodyFromSeq":1,"purpose":"events"}',
      attempt: 1,
      nextAttemptAt: '2099-01-01T00:00:00.000Z',
      lastErrorCode: 'timeout',
    };
  }
  async function journal(count = 3) {
    for (let i = 0; i < count; i++) {
      const event = auditEvent({
        id: ulid(),
        now: '2026-10-30T00:00:00.000Z',
        actor: { type: 'system', id: null },
        action: 'source.update',
        target: { type: 'source', id: 'source' },
        changes: { url: { new: 'https://host.test/repo' } },
        context: {
          opId: '01JZZZZZZZZZZZZZZZZZZZZZZY',
          requestId: '01JZZZZZZZZZZZZZZZZZZZZZZX',
          sourceIp: null,
          tokenSelector: null,
        },
      });
      if (!event.ok) throw new Error('Invalid journal fixture');
      await seed(
        `INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type, target_id, payload_json)
        VALUES (?, ?, '2026-10-30T00:00:00.000Z', 'system', 'source.update', 'source', 'source', ?)`,
        event.event.id,
        org().orgId,
        event.event.payloadJson,
      );
    }
    await createAuditSealRepository(database.executor).seal(org());
  }
  const evict = (limit = 500) =>
    createAuditPruneRepository(database.executor).evict(org(), {
      generation: 1,
      maxJournalBytes: 1,
      limit,
    });
  const runExport = (
    deliver: import('@package-broker/core/audit/plugin-api').AuditSink['deliver'],
    maxBatchEvents = 100,
  ) =>
    exportAuditBatch(
      port(),
      org(),
      fence(),
      {
        id: 'archive',
        generation: 1,
        pluginVersion: '1.0',
        sourceIp: 'omit',
        now: () => new Date(),
        random: () => 0,
        sink: { deliver },
        maxBatchEvents,
        rejectionRetries: 'terminal',
      },
      new AbortController().signal,
    );
  const ack = (batch: import('@package-broker/core/audit/plugin-api').AuditBatchV1) => ({
    outcome: 'accepted' as const,
    chainId: batch.chainId,
    epoch: batch.epoch,
    throughSeq: batch.throughSeq,
    throughHash: batch.throughHash,
  });
  describe('audit export capacity reconciliation', () => {
    it('delivers each durable gap before the surviving page and advances disposition custody', async () => {
      await journal();
      const foreignBefore = await port().read(foreign(), 'archive');
      const original = await port().page(org(), 0, 100);
      expect(await evict(1)).toMatchObject({ outcome: 'evicted', evicted: 1 });
      expect(await evict(1)).toMatchObject({ outcome: 'evicted', evicted: 1 });
      const gaps = await createAuditLedgerRepository(database.executor).effectiveGaps(org());
      expect(gaps).toMatchObject([
        {
          fromSeq: 1,
          toSeq: 2,
          count: 2,
          capacity: {
            prevHash: original[0]!.prev_hash,
            hash: original[1]!.hash,
            affectedSinkIds: ['archive'],
          },
        },
      ]);
      for (const seq of [2, 3]) {
        expect(
          await runExport(async (batch) => {
            expect(batch.throughSeq).toBe(seq);
            expect(batch.records[0]!.kind).toBe(seq < 3 ? 'gap' : 'event');
            return ack(batch);
          }),
        ).toBe('accepted');
        expect((await port().read(org(), 'archive')).sink).toMatchObject({
          progressSeq: seq,
          custodySeq: seq,
        });
      }
      expect(await port().read(foreign(), 'archive')).toEqual(foreignBefore);
    });
    it('delivers a capacity gap even when no events remain', async () => {
      await journal();
      await evict();
      expect(
        await runExport(async (batch) => {
          expect(batch.records).toMatchObject([{ kind: 'gap', fromSeq: 1, toSeq: 3 }]);
          return ack(batch);
        }),
      ).toBe('accepted');
      expect((await port().read(org(), 'archive')).sink).toMatchObject({
        progressSeq: 3,
        custodySeq: 3,
      });
    });
    it.each([1, 3])('reconciles a late exact ACK racing eviction of %s events', async (limit) => {
      await journal();
      expect(
        await runExport(async (batch) => {
          const sending = (await port().read(org(), 'archive')).sink;
          expect(await evict(limit)).toMatchObject({ outcome: 'evicted', evicted: limit });
          expect((await port().read(org(), 'archive')).sink).toEqual(sending);
          return ack(batch);
        }),
      ).toBe('accepted');
      expect((await port().read(org(), 'archive')).sink).toMatchObject({
        progressSeq: 3,
        custodySeq: 3,
        inflightBody: null,
      });
    });
    it('retries the original frozen bytes after eviction and a lost ACK', async () => {
      await journal();
      let original = '';
      expect(
        await runExport(async (batch) => {
          original = JSON.stringify(batch);
          await evict();
          return { outcome: 'retry', code: 'network' };
        }),
      ).toBe('contended');
      expect(
        await runExport(async (batch) => {
          expect(JSON.stringify(batch)).toBe(original);
          return ack(batch);
        }),
      ).toBe('accepted');
    });
    it('consumes the remaining gap after a late ACK stops inside the evicted range', async () => {
      await journal();
      expect(
        await runExport(async (batch) => {
          expect(batch.throughSeq).toBe(1);
          await evict();
          return ack(batch);
        }, 1),
      ).toBe('accepted');
      expect((await port().read(org(), 'archive')).sink.progressSeq).toBe(1);
      expect(
        await runExport(async (batch) => {
          expect(batch.records).toMatchObject([
            {
              kind: 'gap',
              fromSeq: 2,
              toSeq: 3,
              count: 2,
              prevHash: (await port().read(org(), 'archive')).sink.progressHash,
            },
          ]);
          return ack(batch);
        }),
      ).toBe('accepted');
      expect((await port().read(org(), 'archive')).sink).toMatchObject({
        progressSeq: 3,
        custodySeq: 3,
      });
    });
    it('keeps a frozen gap marker while another eviction moves the boundary', async () => {
      await journal();
      await evict(1);
      expect(
        await runExport(async (batch) => {
          expect(batch.records[0]!.kind).toBe('gap');
          const before = (await port().read(org(), 'archive')).sink;
          expect(auditInflightEventRange(before)).toBeNull();
          expect(await evict()).toMatchObject({ outcome: 'evicted', evicted: 2 });
          expect((await port().read(org(), 'archive')).sink).toEqual(before);
          return ack(batch);
        }),
      ).toBe('accepted');
      expect(
        await runExport(async (batch) => {
          expect(batch.records).toMatchObject([{ kind: 'gap', fromSeq: 2, toSeq: 3 }]);
          return ack(batch);
        }),
      ).toBe('accepted');
    });
    it('does not reconcile an ACK across an intervening sink change', async () => {
      await journal();
      expect(
        await runExport(async (batch) => {
          await evict();
          await seed(
            "UPDATE audit_sink SET state = 'blocked', blocked_reason = 'rejected' WHERE org_id = ?",
            org().orgId,
          );
          return ack(batch);
        }),
      ).toBe('contended');
      expect((await port().read(org(), 'archive')).sink).toMatchObject({
        progressSeq: 0,
        custodySeq: 0,
        state: 'blocked',
      });
    });
  });
  describe('audit export capacity with delivery rejections', () => {
    const coverage = async () =>
      JSON.parse((await port().read(org(), 'archive')).sink.inflightRepr!) as {
        durableCustodySeq: number;
        durableAckRanges: { from: number; to: number }[];
      };
    const runWith = (
      deliver: import('@package-broker/core/audit/plugin-api').AuditSink['deliver'],
      alert: (reason: string) => void = () => {},
      exportPort: AuditExportPort = port(),
    ) =>
      exportAuditBatch(
        exportPort,
        org(),
        fence(),
        {
          id: 'archive',
          generation: 1,
          pluginVersion: '1.0',
          sourceIp: 'omit',
          now: () => new Date(),
          random: () => 0,
          sink: { deliver },
          rejectionRetries: 'terminal',
          alert,
        },
        new AbortController().signal,
      );
    it('advances the durable custody frontier through an accepted gap without ACK coverage', async () => {
      await journal();
      await evict(1);
      await evict(1);
      expect(await runExport(async (batch) => ack(batch))).toBe('accepted');
      expect(await coverage()).toMatchObject({ durableCustodySeq: 2, durableAckRanges: [] });
      expect(await runExport(async (batch) => ack(batch))).toBe('accepted');
      expect(await coverage()).toMatchObject({
        durableCustodySeq: 3,
        durableAckRanges: [{ from: 3, to: 3 }],
      });
    });
    it('passes a rejected capacity marker under availability and still accounts for the loss', async () => {
      await journal();
      await evict(1);
      await evict(1);
      const alerts: string[] = [];
      expect(
        await runWith(
          async (batch) => {
            expect(batch.records).toMatchObject([{ kind: 'gap', fromSeq: 1, toSeq: 2 }]);
            return { outcome: 'rejected', code: 'http_status' };
          },
          (reason) => alerts.push(reason),
        ),
      ).toBe('resolved');
      expect(alerts).toEqual(['marker_rejected']);
      expect((await port().read(org(), 'archive')).sink).toMatchObject({
        state: 'active',
        progressSeq: 2,
        custodySeq: 2,
        inflightBody: null,
      });
      expect(await coverage()).toMatchObject({ durableCustodySeq: 2, durableAckRanges: [] });
      expect(await runExport(async (batch) => ack(batch))).toBe('accepted');
      expect((await port().read(org(), 'archive')).sink).toMatchObject({
        progressSeq: 3,
        custodySeq: 3,
      });
    });
    it('blocks on a rejected capacity marker once the policy was raised to required', async () => {
      await journal();
      await evict(1);
      await seed("UPDATE audit_chain SET policy = 'required' WHERE org_id = ?", org().orgId);
      const alerts: string[] = [];
      expect(
        await runWith(
          async () => ({ outcome: 'rejected', code: 'http_status' }),
          (reason) => alerts.push(reason),
        ),
      ).toBe('resolved');
      expect(alerts).toEqual(['blocked']);
      expect((await port().read(org(), 'archive')).sink).toMatchObject({
        state: 'blocked',
        progressSeq: 0,
        custodySeq: 0,
      });
    });
    it('keeps an uncertain disposition when eviction moves the boundary during delivery', async () => {
      await journal();
      const delivered: string[] = [];
      expect(
        await runWith(async (batch) => {
          delivered.push(batch.records.map((record) => record.kind).join());
          expect(await evict()).toMatchObject({ outcome: 'evicted', evicted: 3 });
          return { outcome: 'uncertain', code: 'partial_rejected', rejectedCount: 1 };
        }),
      ).toBe('resolved');
      const ledger = await database.executor.all<{ kind: string; count: number }>({
        sql: "SELECT kind, count FROM audit_ledger WHERE org_id = ? AND kind IN ('uncertain', 'gap') ORDER BY kind",
        params: [org().orgId],
      });
      expect(ledger).toEqual([
        { kind: 'gap', count: 3 },
        { kind: 'uncertain', count: 1 },
      ]);
      expect(
        await runWith(async (batch) => {
          delivered.push(batch.records.map((record) => record.kind).join());
          return ack(batch);
        }),
      ).toBe('accepted');
      expect(delivered).toEqual(['event,event,event', 'delivery_uncertain']);
      expect((await port().read(org(), 'archive')).sink).toMatchObject({
        progressSeq: 3,
        custodySeq: 3,
        inflightBody: null,
      });
      expect(await runWith(async () => Promise.reject(new Error('unexpected')))).toBe('idle');
    });
    const partial = { outcome: 'uncertain', code: 'partial_rejected', rejectedCount: 1 } as const;
    const kinds = (batch: import('@package-broker/core/audit/plugin-api').AuditBatchV1) =>
      batch.records.map((record) => record.kind).join();
    const ledgerKinds = async () =>
      database.executor.all<{ kind: string; count: number }>({
        sql: "SELECT kind, count FROM audit_ledger WHERE org_id = ? AND kind IN ('uncertain', 'gap') AND superseded_by IS NULL ORDER BY kind",
        params: [org().orgId],
      });
    it('retries reconciliation when another eviction lands between its read and save', async () => {
      await journal();
      const real = port();
      let saves = 0;
      const racing: AuditExportPort = {
        ...real,
        save: async (...args) => {
          saves += 1;
          if (saves === 3) expect(await evict(1)).toMatchObject({ outcome: 'evicted' });
          return real.save(...args);
        },
      };
      const delivered: string[] = [];
      expect(
        await runWith(
          async (batch) => {
            delivered.push(kinds(batch));
            expect(await evict(1)).toMatchObject({ outcome: 'evicted', evicted: 1 });
            return partial;
          },
          undefined,
          racing,
        ),
      ).toBe('resolved');
      expect(saves).toBe(4);
      expect(await ledgerKinds()).toEqual([
        { kind: 'gap', count: 2 },
        { kind: 'uncertain', count: 1 },
      ]);
      expect(
        await runWith(async (batch) => {
          delivered.push(kinds(batch));
          return ack(batch);
        }),
      ).toBe('accepted');
      expect(delivered).toEqual(['event,event,event', 'delivery_uncertain']);
    });
    it('reconciles a partial success after the delivery deadline while the lease is valid', async () => {
      await journal();
      const start = Date.now();
      const clock = vi.spyOn(Date, 'now');
      try {
        expect(
          await exportAuditBatch(
            port(),
            org(),
            fence(),
            {
              id: 'archive',
              generation: 1,
              pluginVersion: '1.0',
              sourceIp: 'omit',
              now: () => new Date(),
              random: () => 0,
              sink: {
                deliver: async () => {
                  await evict();
                  clock.mockReturnValue(start + 6_000);
                  return partial;
                },
              },
              rejectionRetries: 'terminal',
            },
            new AbortController().signal,
            5_000,
          ),
        ).toBe('resolved');
      } finally {
        clock.mockRestore();
      }
      expect(await ledgerKinds()).toEqual([
        { kind: 'gap', count: 3 },
        { kind: 'uncertain', count: 1 },
      ]);
    });
    it('holds a partial success past the lease so the frozen batch is never sent again', async () => {
      await journal();
      const start = Date.now();
      const clock = vi.spyOn(Date, 'now');
      const delivered: string[] = [];
      try {
        expect(
          await runWith(async (batch) => {
            delivered.push(kinds(batch));
            await evict();
            clock.mockReturnValue(start + 3_600_000);
            return partial;
          }),
        ).toBe('contended');
      } finally {
        clock.mockRestore();
      }
      const frozen = (await port().read(org(), 'archive')).sink;
      expect(JSON.parse(frozen.inflightRepr!)).toMatchObject({
        purpose: 'events',
        uncertainOutcome: { rejectedCount: 1 },
      });
      expect(await ledgerKinds()).toEqual([{ kind: 'gap', count: 3 }]);
      expect(
        await runWith(async (batch) => {
          delivered.push(kinds(batch));
          return ack(batch);
        }),
      ).toBe('resolved');
      expect(await ledgerKinds()).toEqual([
        { kind: 'gap', count: 3 },
        { kind: 'uncertain', count: 1 },
      ]);
      expect(
        await runWith(async (batch) => {
          delivered.push(kinds(batch));
          return ack(batch);
        }),
      ).toBe('accepted');
      expect(delivered).toEqual(['event,event,event', 'delivery_uncertain']);
      expect((await port().read(org(), 'archive')).sink).toMatchObject({
        progressSeq: 3,
        inflightBody: null,
      });
    });
    it('refuses a hold that changes anything but the held outcome', async () => {
      await journal();
      await runWith(async () => ({ outcome: 'retry', code: 'network' }));
      const expected = await port().read(org(), 'archive');
      const repr = JSON.parse(expected.sink.inflightRepr!) as Record<string, unknown>;
      const next = (patch: Partial<AuditExportState>, extra: Record<string, unknown> = {}) => ({
        ...expected.sink,
        inflightRepr: JSON.stringify({ ...repr, uncertainOutcome: { rejectedCount: 1 }, ...extra }),
        ...patch,
      });
      await expect(
        port().hold(org(), fence(), expected, next({ progressSeq: 3 }), 1),
      ).rejects.toThrow('Invalid audit export hold');
      await expect(
        port().hold(org(), fence(), expected, next({}, { purpose: 'idle' }), 1),
      ).rejects.toThrow('Invalid audit export hold');
      await expect(port().hold(org(), fence(), expected, next({}), 1)).resolves.toBe(true);
      await expect(port().hold(org(), fence(), expected, next({}), 1)).resolves.toBe(false);
    });
    const bodyVersion = async () =>
      (
        await database.executor.all<{ body_version: number }>({
          sql: "SELECT body_version FROM audit_sink WHERE org_id = ? AND sink_id = 'archive'",
          params: [org().orgId],
        })
      )[0]!.body_version;
    it('increments body_version in every export save', async () => {
      await journal();
      expect(await bodyVersion()).toBe(0);
      const before = await port().read(org(), 'archive');
      expect(await port().save(org(), fence(), before, sending(before.sink), 1)).toBe(true);
      expect(await bodyVersion()).toBe(1);
      const frozen = await port().read(org(), 'archive');
      expect(await port().save(org(), fence(), frozen, { ...frozen.sink, attempt: 2 }, 1)).toBe(
        true,
      );
      expect(await bodyVersion()).toBe(2);
    });
    it('increments body_version in the export hold', async () => {
      await journal();
      await runWith(async () => ({ outcome: 'retry', code: 'network' }));
      const version = await bodyVersion();
      const expected = await port().read(org(), 'archive');
      const repr = JSON.parse(expected.sink.inflightRepr!) as Record<string, unknown>;
      expect(
        await port().hold(
          org(),
          fence(),
          expected,
          {
            ...expected.sink,
            inflightRepr: JSON.stringify({ ...repr, uncertainOutcome: { rejectedCount: 1 } }),
          },
          1,
        ),
      ).toBe(true);
      expect(await bodyVersion()).toBe(version + 1);
    });
    it('accepts a capacity disposition only for the frozen marker inside a recorded gap', async () => {
      const capacityRepr = '{"custodyFromSeq":1,"purpose":"capacity"}';
      await seed(
        `UPDATE audit_sink SET inflight_from = 1, inflight_to = 2, inflight_body = '{}',
          inflight_repr = ? WHERE org_id = ? AND sink_id = 'archive'`,
        capacityRepr,
        org().orgId,
      );
      const save = async () => {
        const expected = await port().read(org(), 'archive');
        const range = { fromSeq: 1, toSeq: 2 };
        const next: AuditExportState = {
          ...expected.sink,
          progressSeq: 2,
          custodySeq: 2,
          inflightFrom: null,
          inflightTo: null,
          inflightBody: null,
          inflightRepr: JSON.stringify({
            custodyFromSeq: 1,
            purpose: 'idle',
            ...auditDurableCoverage(expected.sink, undefined, [range]),
          }),
        };
        return {
          plain: () => port().save(org(), fence(), expected, next, 1),
          wide: () =>
            port().save(org(), fence(), expected, next, 1, {
              capacity: { fromSeq: 1, toSeq: 3 },
            }),
          capacity: () => port().save(org(), fence(), expected, next, 1, { capacity: range }),
        };
      };
      await expect((await save()).capacity()).rejects.toThrow('Invalid audit capacity disposition');
      await journal();
      await evict(1);
      await expect((await save()).capacity()).rejects.toThrow('Invalid audit capacity disposition');
      await evict(1);
      const ready = await save();
      await expect(ready.plain()).rejects.toThrow('Invalid audit durable custody frontier');
      await expect(ready.wide()).rejects.toThrow('Invalid audit capacity disposition');
      expect(await ready.capacity()).toBe(true);
      expect((await port().read(org(), 'archive')).sink).toMatchObject({
        progressSeq: 2,
        custodySeq: 2,
      });
    });
  });
  describe('audit export persistence', () => {
    function incident(
      snapshot: AuditExportSnapshot,
      id = '01J00000000000000000000007',
    ): AuditLedgerEntry & { readonly kind: 'uncertain' } {
      return {
        id,
        kind: 'uncertain',
        chainId: snapshot.chainId,
        epoch: snapshot.epoch,
        fromSeq: 1,
        toSeq: 2,
        count: 2,
        sinkId: 'archive',
        reasonCode: 'partial_rejected',
        policy: snapshot.policy,
        modeGeneration: snapshot.modeGeneration,
        actorType: 'system',
        actorId: null,
        createdAt: '2026-10-30T00:00:00.000Z',
      };
    }

    it('commits dispositions and retry state atomically and refuses stale saves without ledger effects', async () => {
      const before = await port().read(org(), 'archive');
      const entry = incident(before);
      const next = {
        ...sending(before.sink),
        retryCountForSeq: 2,
        custodySeq: 2,
        inflightRepr: JSON.stringify({
          custodyFromSeq: 1,
          ...auditDurableCoverage(before.sink, undefined, [entry]),
        }),
      };
      expect(await port().save(org(), fence(), before, next, 1, { ledger: [entry] })).toBe(true);
      const ledger = createAuditLedgerRepository(database.executor);
      expect(await ledger.page(org(), null, 10)).toEqual([entry]);
      expect(
        await port().save(org(), fence(), before, next, 1, {
          ledger: [incident(before, '01J00000000000000000000008')],
        }),
      ).toBe(false);
      expect(await ledger.page(org(), null, 10)).toEqual([entry]);
      expect((await port().read(org(), 'archive')).sink).toEqual(next);
    });

    it('persists one hundred withheld dispositions within D1 statement and parameter limits', async () => {
      const before = await port().read(org(), 'archive');
      const ledger = Array.from(
        { length: 100 },
        (_, index): AuditLedgerEntry & { readonly kind: 'withheld' } => ({
          ...incident(before, String(index + 1).padStart(26, '0')),
          kind: 'withheld',
          fromSeq: index + 1,
          toSeq: index + 1,
          count: 1,
          reasonCode: 'content_unavailable',
        }),
      );
      const batches: Statement[][] = [];
      const executor: SqlExecutor = {
        ...database.executor,
        batch: async (statements) => {
          expect(statements.length).toBeLessThanOrEqual(200);
          for (const statement of statements)
            expect(statement.params.length).toBeLessThanOrEqual(100);
          batches.push([...statements]);
          return database.executor.batch(statements);
        },
      };
      expect(
        await createAuditExportRepository(executor).save(
          org(),
          fence(),
          before,
          {
            ...before.sink,
            custodySeq: 100,
            inflightRepr: JSON.stringify({
              custodyFromSeq: 1,
              ...auditDurableCoverage(before.sink, undefined, ledger),
            }),
          },
          1,
          { ledger },
        ),
      ).toBe(true);
      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(102);
      expect(await createAuditLedgerRepository(database.executor).page(org(), null, 100)).toEqual(
        ledger,
      );
    });

    it('rolls back sink state if a ledger write fails', async () => {
      const before = await port().read(org(), 'archive');
      const entry = incident(before);
      await createAuditLedgerRepository(database.executor).append(org(), [entry]);
      await expect(
        port().save(org(), fence(), before, sending(before.sink), 1, {
          ledger: [{ ...entry, reasonCode: 'different' }],
        }),
      ).rejects.toThrow();
      expect(await port().read(org(), 'archive')).toEqual(before);
    });

    it('lease expiry refuses both custody and ledger changes', async () => {
      const before = await port().read(org(), 'archive');
      await seed("UPDATE job SET lease_until = '2000-01-01T00:00:00.000Z'");
      expect(
        await port().save(
          org(),
          fence(),
          before,
          {
            ...before.sink,
            custodySeq: 2,
            inflightRepr: JSON.stringify({
              custodyFromSeq: 1,
              ...auditDurableCoverage(before.sink, undefined, [incident(before)]),
            }),
          },
          1,
          {
            ledger: [incident(before)],
          },
        ),
      ).toBe(false);
      expect(await createAuditLedgerRepository(database.executor).page(org(), null, 10)).toEqual(
        [],
      );
      expect(await port().read(org(), 'archive')).toEqual(before);
    });

    it('writes linked replay resolutions only in the covering durable ACK batch', async () => {
      const before = await port().read(org(), 'archive');
      const other = await port().read(foreign(), 'archive');
      const ledger = createAuditLedgerRepository(database.executor);
      const entry = incident(before);
      await ledger.append(org(), [
        entry,
        { ...incident(before, '01J00000000000000000000008'), toSeq: 3, count: 3 },
      ]);
      await ledger.append(foreign(), [incident(other)]);
      expect(await port().save(org(), fence(), before, sending(before.sink), 1)).toBe(true);
      const sendingSnapshot = await port().read(org(), 'archive');
      const next = {
        ...sendingSnapshot.sink,
        progressSeq: 2,
        progressHash: 'a'.repeat(64),
        custodySeq: 2,
        inflightRepr: JSON.stringify({
          custodyFromSeq: 1,
          ...auditDurableCoverage(sendingSnapshot.sink, { from: 1, to: 2 }),
        }),
        inflightFrom: null,
        inflightTo: null,
        inflightBody: null,
      };
      expect(
        await port().save(
          org(),
          fence({ id: 'export-job', owner: 'stale', fence: 3 }),
          sendingSnapshot,
          next,
          1,
          {
            replayCreatedAt: '2026-10-30T00:00:00.000Z',
            durableAck: { from: 1, to: 2 },
          },
        ),
      ).toBe(false);
      expect((await ledger.page(org(), null, 10)).filter((row) => row.kind === 'replay')).toEqual(
        [],
      );
      expect(
        await port().save(org(), fence(), sendingSnapshot, next, 1, {
          replayCreatedAt: '2026-10-30T00:00:00.000Z',
          durableAck: { from: 1, to: 2 },
        }),
      ).toBe(true);
      const replays = (await ledger.page(org(), null, 10)).filter((row) => row.kind === 'replay');
      expect(replays).toEqual([
        expect.objectContaining({
          kind: 'replay',
          resolvesId: entry.id,
          fromSeq: 1,
          toSeq: 2,
          sinkId: 'archive',
        }),
      ]);
      expect(await ledger.page(foreign(), null, 10)).toEqual([incident(other)]);
      expect((await port().read(org(), 'archive')).sink).toEqual(next);
    });

    it('resolves uncertainty across contiguous ACK batches and drains more than 100 incidents across saves', async () => {
      const repository = port();
      const before = await repository.read(org(), 'archive');
      const ledger = createAuditLedgerRepository(database.executor);
      const incidents = Array.from({ length: 105 }, (_, index) =>
        incident(before, String(index + 1).padStart(26, '0')),
      );
      await ledger.append(org(), incidents);
      let snapshot = before;
      const createdAt = '2026-10-29T12:34:56.000Z';
      for (const seq of [1, 2]) {
        const send = { ...snapshot.sink, inflightFrom: seq, inflightTo: seq };
        expect(await repository.save(org(), fence(), snapshot, send, 1)).toBe(true);
        snapshot = await repository.read(org(), 'archive');
        const next = {
          ...snapshot.sink,
          progressSeq: seq,
          custodySeq: seq,
          inflightRepr: JSON.stringify({
            custodyFromSeq: 1,
            ...auditDurableCoverage(snapshot.sink, { from: seq, to: seq }),
          }),
        };
        expect(
          await repository.save(org(), fence(), snapshot, next, 1, {
            durableAck: { from: seq, to: seq },
            replayCreatedAt: createdAt,
          }),
        ).toBe(true);
        snapshot = await repository.read(org(), 'archive');
        const rows = await ledger.page(org(), null, 500);
        expect(rows.filter((row) => row.kind === 'replay')).toHaveLength(seq === 1 ? 0 : 100);
      }
      expect(
        await repository.save(org(), fence(), snapshot, { ...snapshot.sink, attempt: 2 }, 1, {
          replayCreatedAt: createdAt,
        }),
      ).toBe(true);
      snapshot = await repository.read(org(), 'archive');
      expect(
        await repository.save(org(), fence(), snapshot, { ...snapshot.sink, attempt: 3 }, 1, {
          replayCreatedAt: createdAt,
        }),
      ).toBe(true);
      const replays = (await ledger.page(org(), null, 500)).filter((row) => row.kind === 'replay');
      expect(replays).toHaveLength(105);
      expect(new Set(replays.map((row) => row.resolvesId)).size).toBe(105);
      expect(replays.every((row) => row.createdAt === createdAt)).toBe(true);
    });

    it('accounts for dispositions without resolving uncertainty until covering durable redelivery', async () => {
      const repository = port();
      let snapshot = await repository.read(org(), 'archive');
      const skipped = {
        ...incident(snapshot),
        kind: 'skipped' as const,
        fromSeq: 1,
        toSeq: 1,
        count: 1,
      };
      const uncertain = {
        ...incident(snapshot, '01J00000000000000000000008'),
        fromSeq: 2,
        toSeq: 3,
      };
      for (const entry of [skipped, uncertain]) {
        const next = {
          ...snapshot.sink,
          progressSeq: entry.toSeq,
          custodySeq: entry.toSeq,
          inflightRepr: JSON.stringify({
            custodyFromSeq: 1,
            ...auditDurableCoverage(snapshot.sink, undefined, [entry]),
          }),
        };
        expect(await repository.save(org(), fence(), snapshot, next, 1, { ledger: [entry] })).toBe(
          true,
        );
        snapshot = await repository.read(org(), 'archive');
        expect(JSON.parse(snapshot.sink.inflightRepr!).durableCustodySeq).toBe(entry.toSeq);
      }
      for (const range of [
        { from: 4, to: 4 },
        { from: 2, to: 2 },
        { from: 3, to: 3 },
      ]) {
        expect(
          await repository.save(
            org(),
            fence(),
            snapshot,
            { ...snapshot.sink, inflightFrom: range.from, inflightTo: range.to },
            1,
          ),
        ).toBe(true);
        snapshot = await repository.read(org(), 'archive');
        const next = {
          ...snapshot.sink,
          progressSeq: range.to,
          inflightRepr: JSON.stringify({
            custodyFromSeq: 1,
            ...auditDurableCoverage(snapshot.sink, range),
          }),
        };
        expect(
          await repository.save(org(), fence(), snapshot, next, 1, {
            durableAck: range,
            replayCreatedAt: uncertain.createdAt,
          }),
        ).toBe(true);
        snapshot = await repository.read(org(), 'archive');
        expect(JSON.parse(snapshot.sink.inflightRepr!).durableCustodySeq).toBe(4);
        const replays = (
          await createAuditLedgerRepository(database.executor).page(org(), null, 10)
        ).filter((row) => row.kind === 'replay');
        expect(replays).toHaveLength(range.from === 3 ? 1 : 0);
        if (range.from === 3) expect(replays[0]?.resolvesId).toBe(uncertain.id);
      }
    });

    it('drains earned resolutions in the idle job loop even after durable ACK is disabled', async () => {
      const repository = port();
      const before = await repository.read(org(), 'archive');
      const ledger = createAuditLedgerRepository(database.executor);
      const incidents = Array.from({ length: 205 }, (_, index) =>
        incident(before, String(index + 1).padStart(26, '0')),
      );
      for (let offset = 0; offset < incidents.length; offset += 100)
        await ledger.append(org(), incidents.slice(offset, offset + 100));
      expect(
        await repository.save(
          org(),
          fence(),
          before,
          { ...before.sink, inflightFrom: 1, inflightTo: 2 },
          1,
        ),
      ).toBe(true);
      const snapshot = await repository.read(org(), 'archive');
      expect(
        await repository.save(
          org(),
          fence(),
          snapshot,
          {
            ...snapshot.sink,
            progressSeq: 2,
            inflightFrom: null,
            inflightTo: null,
            inflightRepr: JSON.stringify({
              custodyFromSeq: 1,
              ...auditDurableCoverage(snapshot.sink, { from: 1, to: 2 }),
            }),
          },
          1,
          { durableAck: { from: 1, to: 2 }, replayCreatedAt: '2026-10-30T00:00:00.000Z' },
        ),
      ).toBe(true);
      await seed('UPDATE audit_sink SET durable_ack = 0 WHERE org_id = ?', org().orgId);
      expect((await repository.read(org(), 'archive')).replayPending).toBe(true);
      let deliveries = 0;
      await auditExportJob(repository, {
        id: 'archive',
        generation: 1,
        pluginVersion: '1',
        sourceIp: 'omit',
        rejectionRetries: 'terminal',
        now: () => new Date('2026-10-30T00:00:00.000Z'),
        sink: {
          async deliver() {
            deliveries++;
            throw new Error('Unexpected delivery');
          },
        },
      }).handler({}, {
        org: org(),
        signal: new AbortController().signal,
        fences: jobFences({ id: 'export-job', owner: 'worker', fence: 3 }),
        observability: { log() {} },
      } as unknown as JobContext);
      expect(deliveries).toBe(0);
      expect(
        (await ledger.page(org(), null, 500)).filter((row) => row.kind === 'replay'),
      ).toHaveLength(205);
      expect((await repository.read(org(), 'archive')).replayPending).toBe(false);
    });

    it('rejects forged custody frontiers with and without a durable ACK', async () => {
      const repository = port();
      const before = await repository.read(org(), 'archive');
      expect(
        await repository.save(
          org(),
          fence(),
          before,
          { ...before.sink, inflightFrom: 1, inflightTo: 2 },
          1,
        ),
      ).toBe(true);
      const snapshot = await repository.read(org(), 'archive');
      for (const ack of [undefined, { from: 1, to: 2 }]) {
        await expect(
          repository.save(
            org(),
            fence(),
            snapshot,
            {
              ...snapshot.sink,
              progressSeq: ack ? 2 : 0,
              inflightRepr: JSON.stringify({ custodyFromSeq: 1, durableCustodySeq: 99 }),
            },
            1,
            { durableAck: ack },
          ),
        ).rejects.toThrow('Invalid audit durable custody frontier');
        expect(await repository.read(org(), 'archive')).toEqual(snapshot);
      }
    });

    it('guards replay insertion against a resolution committed after selection', async () => {
      const repository = port();
      const before = await repository.read(org(), 'archive');
      const entry = incident(before);
      const ledger = createAuditLedgerRepository(database.executor);
      await ledger.append(org(), [entry]);
      expect(await repository.save(org(), fence(), before, sending(before.sink), 1)).toBe(true);
      const snapshot = await repository.read(org(), 'archive');
      let inserted = false;
      const executor: SqlExecutor = {
        ...database.executor,
        batch: async (statements) => {
          if (!inserted) {
            inserted = true;
            await ledger.append(org(), [
              {
                ...entry,
                id: '01J00000000000000000000008',
                kind: 'replay',
                resolvesId: entry.id,
                reasonCode: 'durable_ack',
              },
            ]);
          }
          return database.executor.batch(statements);
        },
      };
      expect(
        await createAuditExportRepository(executor).save(
          org(),
          fence(),
          snapshot,
          {
            ...snapshot.sink,
            progressSeq: 2,
            custodySeq: 2,
            inflightRepr: JSON.stringify({
              custodyFromSeq: 1,
              ...auditDurableCoverage(snapshot.sink, { from: 1, to: 2 }),
            }),
          },
          1,
          { durableAck: { from: 1, to: 2 }, replayCreatedAt: entry.createdAt },
        ),
      ).toBe(true);
      expect(
        (await ledger.page(org(), null, 10)).filter((row) => row.kind === 'replay'),
      ).toHaveLength(1);
    });

    it('deduplicates withheld entries by sequence and sink inside the insert', async () => {
      const repository = port();
      const before = await repository.read(org(), 'archive');
      const entry = {
        ...incident(before),
        kind: 'withheld' as const,
        toSeq: 1,
        count: 1,
        reasonCode: 'unreadable',
      };
      expect(
        await repository.save(
          org(),
          fence(),
          before,
          {
            ...before.sink,
            attempt: 1,
            inflightRepr: JSON.stringify({
              custodyFromSeq: 1,
              ...auditDurableCoverage(before.sink, undefined, [entry]),
            }),
          },
          1,
          {
            ledger: [entry],
          },
        ),
      ).toBe(true);
      const snapshot = await repository.read(org(), 'archive');
      expect(
        await repository.save(org(), fence(), snapshot, { ...snapshot.sink, attempt: 2 }, 1, {
          ledger: [{ ...entry, id: '01J00000000000000000000008' }],
        }),
      ).toBe(true);
      expect(await createAuditLedgerRepository(database.executor).page(org(), null, 10)).toEqual([
        entry,
      ]);
    });

    it('reads a complete snapshot and writes exporter-owned sink fields, preserving foreign rows', async () => {
      const before = await port().read(org(), 'archive');
      expect(before).toMatchObject({
        highestGeneration: 1,
        restorePending: false,
        sink: {
          id: 'archive',
          durableAck: true,
          attempt: 0,
          nextAttemptAt: null,
          lastErrorCode: null,
        },
      });
      const other = await port().read(foreign(), 'archive');
      const next: AuditExportState = {
        ...sending(before.sink),
        state: 'blocked',
        progressSeq: 2,
        progressHash: 'a'.repeat(64),
        custodySeq: 1,
        blockedReason: 'rejected',
      };
      expect(await port().save(org(), fence(), before, next, 1)).toBe(true);
      expect((await port().read(org(), 'archive')).sink).toEqual(next);
      expect(await port().read(foreign(), 'archive')).toEqual(other);
    });

    it('rejects every stale chain and highest-generation snapshot field', async () => {
      const before = await port().read(org(), 'archive');
      const changes: Partial<AuditExportSnapshot>[] = [
        { chainId: 'f'.repeat(32) },
        { epoch: 1 },
        { incarnation: before.incarnation + 1 },
        { modeGeneration: 1 },
        { boundarySeq: 2 },
        { boundaryPrevHash: 'a'.repeat(64) },
        { policy: 'required' },
        { restorePending: true },
        { highestGeneration: 0 },
      ];
      for (const change of changes) {
        expect(
          await port().save(org(), fence(), { ...before, ...change }, sending(before.sink), 1),
          JSON.stringify(change),
        ).toBe(false);
        expect(await port().read(org(), 'archive')).toEqual(before);
      }
    });

    it('CAS compares every sink field including nullable and retry fields', async () => {
      const before = await port().read(org(), 'archive');
      const changes: Partial<AuditExportState>[] = [
        { id: 'missing' },
        { pluginId: 'other' },
        { kind: 'otlp' },
        { generation: 2 },
        { receiverFingerprint: 'other' },
        { durableAck: false },
        { activationSource: 'OTHER' },
        { state: 'disabled' },
        { progressSeq: 1 },
        { progressHash: 'b'.repeat(64) },
        { custodySeq: 1 },
        { blockedReason: 'fork' },
        { inflightFrom: 1 },
        { inflightTo: 2 },
        { inflightBody: '{}' },
        { inflightRepr: null },
        { attempt: 1 },
        { retryCountForSeq: 1 },
        { nextAttemptAt: '2099-01-01T00:00:00.000Z' },
        { lastErrorCode: 'timeout' },
      ];
      for (const change of changes) {
        const stale = { ...before, sink: { ...before.sink, ...change } };
        expect(
          await port().save(
            org(),
            fence(),
            stale,
            { ...sending(before.sink), id: stale.sink.id },
            1,
          ),
          JSON.stringify(change),
        ).toBe(false);
        expect(await port().read(org(), 'archive')).toEqual(before);
      }
      expect(await port().save(org(), fence(), before, sending(before.sink), 1)).toBe(true);
      const current = await port().read(org(), 'archive');
      for (const key of [
        'inflightFrom',
        'inflightTo',
        'inflightBody',
        'inflightRepr',
        'nextAttemptAt',
        'lastErrorCode',
      ] as const) {
        expect(
          await port().save(
            org(),
            fence(),
            { ...current, sink: { ...current.sink, [key]: null } },
            before.sink,
            1,
          ),
          key,
        ).toBe(false);
      }
      expect(await port().read(org(), 'archive')).toEqual(current);
    });

    it('rejects stale lease id, owner and fence', async () => {
      const before = await port().read(org(), 'archive');
      for (const job of [
        { id: 'missing', owner: 'worker', fence: 3 },
        { id: 'export-job', owner: 'stale', fence: 3 },
        { id: 'export-job', owner: 'worker', fence: 2 },
      ])
        expect(await port().save(org(), fence(job), before, sending(before.sink), 1)).toBe(false);
      expect(await port().read(org(), 'archive')).toEqual(before);
    });

    it.each(['expired', 'equal', 'null', 'queued', 'foreign', 'other-sink'])(
      'rejects a %s lease at database time',
      async (kind) => {
        const before = await port().read(org(), 'archive');
        if (kind === 'expired')
          await seed("UPDATE job SET lease_until = '2000-01-01T00:00:00.000Z'");
        if (kind === 'equal')
          await seed("UPDATE job SET lease_until = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
        if (kind === 'null') await seed("UPDATE job SET state = 'queued', lease_until = NULL");
        if (kind === 'queued') await seed("UPDATE job SET state = 'queued'");
        if (kind === 'other-sink') await seed("UPDATE job SET resource_key = 'audit-export:other'");
        if (kind === 'foreign') await seed('UPDATE job SET org_id = ?', foreign().orgId);
        expect(await port().save(org(), fence(), before, sending(before.sink), 1)).toBe(false);
        expect(await port().read(org(), 'archive')).toEqual(before);
      },
    );

    it('fences lower builds against the highest sink generation within the organization', async () => {
      const before = await port().read(org(), 'archive');
      await seed(
        `INSERT INTO audit_sink (org_id, sink_id, plugin_id, kind, generation, receiver_fingerprint,
        durable_ack, activation_source, state, progress_seq, progress_hash, custody_seq)
        SELECT org_id, 'newer', plugin_id, kind, 4, receiver_fingerprint, durable_ack, activation_source,
        state, progress_seq, progress_hash, custody_seq FROM audit_sink WHERE org_id = ?`,
        org().orgId,
      );
      expect(await port().save(org(), fence(), before, sending(before.sink), 1)).toBe(false);
      const current = await port().read(org(), 'archive');
      expect(current.highestGeneration).toBe(4);
      expect(await port().save(org(), fence(), current, sending(current.sink), 1)).toBe(false);
      await seed('UPDATE audit_sink SET generation = 99 WHERE org_id = ?', foreign().orgId);
      expect((await port().read(org(), 'archive')).highestGeneration).toBe(4);
      expect(await port().save(org(), fence(), current, sending(current.sink), 4)).toBe(true);
    });

    it.each([3, 4, 5])(
      'checks acting build %s independently of the sink generation',
      async (generation) => {
        await seed('UPDATE audit_sink SET generation = 4 WHERE org_id = ?', org().orgId);
        const before = await port().read(org(), 'archive');
        const next = sending(before.sink);
        expect(await port().save(org(), fence(), before, next, generation)).toBe(generation >= 4);
        expect((await port().read(org(), 'archive')).sink).toEqual(
          generation >= 4 ? next : before.sink,
        );
      },
    );

    it('refuses changes to every registry-owned field even from a newer build', async () => {
      const before = await port().read(org(), 'archive');
      for (const change of [
        { pluginId: 'other' },
        { kind: 'otlp' },
        { generation: 99 },
        { receiverFingerprint: 'other' },
        { durableAck: false },
        { activationSource: 'OTHER' },
      ]) {
        expect(
          await port().save(org(), fence(), before, { ...sending(before.sink), ...change }, 99),
        ).toBe(false);
        expect(await port().read(org(), 'archive')).toEqual(before);
      }
    });

    it('compares frozen bodies near 512 KiB exactly on retry and ACK', async () => {
      const before = await port().read(org(), 'archive');
      const next = {
        ...sending(before.sink),
        inflightBody: JSON.stringify({ padding: 'x'.repeat(512 * 1024 - 64) }),
      };
      expect(await port().save(org(), fence(), before, next, 1)).toBe(true);
      const current = await port().read(org(), 'archive');
      expect(current.sink).toEqual(next);
      const stale = {
        ...current,
        sink: { ...current.sink, inflightBody: next.inflightBody.replace('x', 'y') },
      };
      expect(await port().save(org(), fence(), stale, next, 1)).toBe(false);
      expect(await port().save(org(), fence(), current, { ...next, attempt: 2 }, 1)).toBe(true);
      const retry = await port().read(org(), 'archive');
      expect(await port().save(org(), fence(), retry, before.sink, 1)).toBe(true);
    });

    it.each(['marker', 'registry_markers'])(
      'delivers a stored %s body without advancing custody',
      async (purpose) => {
        const before = await port().read(org(), 'archive');
        const body = JSON.stringify({
          v: 1,
          frozenAt: 0,
          orgId: org().orgId,
          chainId: before.chainId,
          epoch: before.epoch,
          records: [
            {
              kind: 'head',
              chainId: before.chainId,
              epoch: before.epoch,
              markerId: '01J00000000000000000000006',
              seq: 0,
              hash: before.sink.progressHash,
              boundarySeq: 1,
            },
          ],
          throughSeq: 0,
          throughHash: before.sink.progressHash,
        });
        expect(
          await port().save(
            org(),
            fence(),
            before,
            {
              ...sending(before.sink),
              inflightBody: body,
              inflightRepr: JSON.stringify({ custodyFromSeq: 1, purpose }),
              nextAttemptAt: null,
            },
            1,
          ),
        ).toBe(true);
        const stored = await port().read(org(), 'archive');
        expect(stored.sink.inflightFrom).toBe(1);
        expect(auditInflightEventRange(stored.sink)).toBeNull();
        let deliveries = 0;
        expect(
          await exportAuditBatch(
            port(),
            org(),
            fence(),
            {
              id: 'archive',
              generation: 1,
              pluginVersion: '1.0',
              sourceIp: 'omit',
              rejectionRetries: 3,
              now: () => new Date(),
              sink: {
                deliver: async (batch) => {
                  deliveries++;
                  return {
                    outcome: 'accepted',
                    chainId: batch.chainId,
                    epoch: batch.epoch,
                    throughSeq: batch.throughSeq,
                    throughHash: batch.throughHash,
                  };
                },
              },
            },
            new AbortController().signal,
          ),
        ).toBe('accepted');
        expect(deliveries).toBe(1);
        expect((await port().read(org(), 'archive')).sink).toMatchObject({
          progressSeq: 0,
          custodySeq: 0,
          inflightBody: null,
        });
      },
    );

    it('validates lease inputs with the shared job guard checks', async () => {
      const before = await port().read(org(), 'archive');
      for (const job of [
        { id: 'x'.repeat(513), owner: 'worker', fence: 3 },
        { id: 'export-job', owner: 'x'.repeat(513), fence: 3 },
      ])
        await expect(
          port().save(org(), fence(job), before, sending(before.sink), 1),
        ).rejects.toThrow(RangeError);
      expect(await port().read(org(), 'archive')).toEqual(before);
    });

    it('retains frozen bytes across a crash before ACK save and rejects late duplicate ACKs', async () => {
      const before = await port().read(org(), 'archive');
      const frozen = sending(before.sink);
      expect(await port().save(org(), fence(), before, frozen, 1)).toBe(true);
      const restarted = createAuditExportRepository(database.executor);
      const persisted = await restarted.read(org(), 'archive');
      expect(persisted.sink).toEqual(frozen);
      const retried = { ...frozen, attempt: 2 };
      expect(await restarted.save(org(), fence(), persisted, retried, 1)).toBe(true);
      const ack = { ...before.sink, progressSeq: 2, progressHash: 'a'.repeat(64), custodySeq: 2 };
      expect(await port().save(org(), fence(), persisted, ack, 1)).toBe(false);
      expect((await port().read(org(), 'archive')).sink).toEqual(retried);
      expect(await restarted.save(org(), fence(), { ...persisted, sink: retried }, ack, 1)).toBe(
        true,
      );
      expect(await port().save(org(), fence(), { ...persisted, sink: retried }, ack, 1)).toBe(
        false,
      );
      expect((await port().read(org(), 'archive')).sink).toEqual(ack);
    });

    it('checks a lease lost after snapshot read inside the bounded save batch', async () => {
      const before = await port().read(org(), 'archive');
      let batches = 0;
      const executor: SqlExecutor = {
        driver: database.executor.driver,
        all: async () => {
          throw new Error('Unexpected save read');
        },
        batch: async (statements) => {
          batches += 1;
          expect(statements).toHaveLength(1);
          expect(statements[0]!.params.length).toBeLessThanOrEqual(100);
          await seed("UPDATE job SET lease_until = '2000-01-01T00:00:00.000Z'");
          return database.executor.batch(statements);
        },
      };
      expect(
        await createAuditExportRepository(executor).save(
          org(),
          fence(),
          before,
          sending(before.sink),
          1,
        ),
      ).toBe(false);
      expect(batches).toBe(1);
      expect(await port().read(org(), 'archive')).toEqual(before);
    });

    it('rejects an ACK after lease takeover and lets the new holder resume frozen state', async () => {
      const before = await port().read(org(), 'archive');
      expect(await port().save(org(), fence(), before, sending(before.sink), 1)).toBe(true);
      const persisted = await port().read(org(), 'archive');
      await seed("UPDATE job SET lease_owner = 'new-worker', fence = 4");
      const ack = { ...before.sink, progressSeq: 2, progressHash: 'a'.repeat(64), custodySeq: 2 };
      expect(await port().save(org(), fence(), persisted, ack, 1)).toBe(false);
      expect(await port().read(org(), 'archive')).toEqual(persisted);
      expect(
        await port().save(
          org(),
          fence({ id: 'export-job', owner: 'new-worker', fence: 4 }),
          persisted,
          ack,
          1,
        ),
      ).toBe(true);
      expect((await port().read(org(), 'archive')).sink).toEqual(ack);
    });

    it('uses RETURNING rows even when executor change counts disagree', async () => {
      const executor: SqlExecutor = {
        driver: database.executor.driver,
        all: (statement) => database.executor.all(statement),
        batch: async (statements) =>
          (await database.executor.batch(statements)).map((result) => ({ ...result, changes: 99 })),
      };
      const repository = createAuditExportRepository(executor);
      const before = await repository.read(org(), 'archive');
      expect(await repository.save(org(), fence(), before, sending(before.sink), 1)).toBe(true);
      expect(await repository.save(org(), fence(), before, sending(before.sink), 1)).toBe(false);
    });

    it('pages only sealed rows of its organization in bounded sequence order', async () => {
      for (const ctx of [org(), foreign()]) {
        for (const seq of [3, 1, 2])
          await seed(
            `INSERT INTO audit_event
          (id, org_id, seq, prev_hash, hash, created_at, actor_type, action, target_type)
          VALUES (?, ?, ?, ?, ?, '2026-10-28T00:00:00.000Z', 'system', 'org.update', 'organization')`,
            `${ctx.orgId}-${seq}`,
            ctx.orgId,
            seq,
            String(seq - 1).repeat(64),
            String(seq).repeat(64),
          );
        await seed(
          'UPDATE audit_chain SET head_seq = ? WHERE org_id = ?',
          ctx.orgId === org().orgId ? 2 : 3,
          ctx.orgId,
        );
      }
      expect((await port().page(org(), 0, 100)).map((row) => [row.org_id, row.seq])).toEqual([
        [org().orgId, 1],
        [org().orgId, 2],
      ]);
      expect((await port().page(org(), 1, 1)).map((row) => row.seq)).toEqual([2]);
      expect(await port().page(org(), 2, 100)).toEqual([]);
      expect(await port().page(orgContext('missing'), 0, 100)).toEqual([]);
    });
    it('rejects unbounded pages and missing snapshots without request data in errors', async () => {
      for (const [after, limit] of [
        [-1, 1],
        [0, 0],
        [0, 101],
        [0, 1.5],
        [NaN, 1],
        [0, Infinity],
      ])
        await expect(port().page(org(), after!, limit!)).rejects.toThrow(
          'Invalid audit export page',
        );
      await expect(port().read(org(), 'private-input')).rejects.toThrow(
        /^Audit export snapshot unavailable$/,
      );
    });
  });
}
