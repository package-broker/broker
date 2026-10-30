import { jobFences } from '@package-broker/core/platform/job-fences';
import type { JobContext } from '@package-broker/core/platform/jobs';
import type { AuditLedgerEntry } from '@package-broker/core/audit/ledger';
import { createAuditLedgerRepository } from '../repositories/audit-ledger.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  exportAuditBatch,
  auditExportJob,
  auditDurableCoverage,
  auditInflightEventRange,
  type AuditExportSnapshot,
  type AuditExportState,
} from '@package-broker/core/audit/export';
import { systemMutationFence } from '@package-broker/core/authz/fence';
import { orgContext, type SqlExecutor, type Statement } from '@package-broker/core/db/port';
import { createAuditExportRepository } from '../repositories/audit-export.js';
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
