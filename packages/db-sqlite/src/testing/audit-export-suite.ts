import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  exportAuditBatch,
  auditInflightEventRange,
  type AuditExportSnapshot,
  type AuditExportState,
} from '@package-broker/core/audit/export';
import { systemMutationFence } from '@package-broker/core/authz/fence';
import { orgContext, type SqlExecutor } from '@package-broker/core/db/port';
import { createAuditExportRepository } from '../repositories/audit-export.js';
import { auditEvent } from '@package-broker/core/audit/actions';
import { ulid } from '@package-broker/core/ids';
import { createAuditPruneRepository } from '../repositories/audit-prune.js';
import { createAuditSealRepository } from '../repositories/audit-seal.js';
import { createAuditLedgerRepository } from '../repositories/audit-ledger.js';
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
        resolve: async () => {
          throw new Error('Unexpected disposition');
        },
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
  describe('audit export persistence', () => {
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
              resolve: async () => {
                throw new Error('Unexpected disposition');
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
