import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AUDIT_LEDGER_KINDS,
  AuditLedgerOverlapError,
  type AuditLedgerEntry,
} from '@package-broker/core/audit/ledger';
import { orgContext } from '@package-broker/core/db/port';
import type { MigratedDatabase } from './migrated-database.js';
import {
  AuditLedgerIntegrityError,
  createAuditLedgerRepository,
} from '../repositories/audit-ledger.js';

export function auditLedgerRepositorySuite(open: () => Promise<MigratedDatabase>): void {
  let database: MigratedDatabase;
  beforeEach(async () => {
    database = await open();
  });
  afterEach(async () => {
    await database.close();
  });
  const entry: AuditLedgerEntry = {
    id: '01K7R5V0000000000000000001',
    kind: 'gap',
    chainId: 'a'.repeat(32),
    epoch: 0,
    fromSeq: 1,
    toSeq: 2,
    count: 2,
    sinkId: null,
    reasonCode: 'capacity',
    policy: 'availability',
    modeGeneration: 0,
    actorType: 'system',
    actorId: null,
    createdAt: '2026-10-28T10:00:00.000Z',
  };
  function orgs() {
    if (database.orgs === null) throw new Error('missing organizations');
    return database.orgs;
  }

  async function seedSink(orgId: string) {
    await database.executor.batch([
      {
        sql: `INSERT INTO audit_sink (org_id, sink_id, plugin_id, kind, generation, receiver_fingerprint,
      durable_ack, activation_source, state, progress_seq, progress_hash, custody_seq)
      VALUES (?, 'archive', 'test', 'webhook', 0, 'fingerprint', 1, 'build', 'active', 0, ?, 0)`,
        params: [orgId, '0'.repeat(64)],
      },
    ]);
  }

  function rawRow(orgId: string, row: AuditLedgerEntry, supersededBy: string | null = null) {
    return {
      sql: `INSERT INTO audit_ledger (org_id, id, kind, chain_id, epoch, from_seq, to_seq, count,
        sink_id, reason_code, policy, mode_generation, actor_type, actor_id, created_at, superseded_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        orgId,
        row.id,
        row.kind,
        row.chainId,
        row.epoch,
        row.fromSeq,
        row.toSeq,
        row.count,
        row.sinkId,
        row.reasonCode,
        row.policy,
        row.modeGeneration,
        row.actorType,
        row.actorId,
        row.createdAt,
        supersededBy,
      ],
    };
  }

  function supersede(orgId: string, id: string, by: string) {
    return {
      sql: 'UPDATE audit_ledger SET superseded_by = ? WHERE org_id = ? AND id = ?',
      params: [by, orgId, id],
    };
  }

  async function rows(orgId: string) {
    return database.executor.all({
      sql: 'SELECT * FROM audit_ledger WHERE org_id = ? ORDER BY id',
      params: [orgId],
    });
  }

  describe('audit ledger repository', () => {
    it('merges gaps across appends with an append-only superseding row', async () => {
      const repository = createAuditLedgerRepository(database.executor);
      const { a } = orgs();
      await repository.append(a, [
        { ...entry, id: '01K7R5V0000000000000000002', fromSeq: 3, toSeq: 5, count: 3 },
        entry,
      ]);
      expect(await repository.page(a, null, 500)).toEqual([{ ...entry, toSeq: 5, count: 5 }]);
      const later = { ...entry, id: '01K7R5V0000000000000000003', fromSeq: 6, toSeq: 7 };
      await repository.append(a, [later]);
      expect(await repository.page(a, null, 500)).toEqual([{ ...later, fromSeq: 1, count: 7 }]);
      expect(await repository.effectiveGaps(a)).toEqual([{ ...later, fromSeq: 1, count: 7 }]);
      expect(await repository.page(a, entry.id, 1)).toEqual([{ ...later, fromSeq: 1, count: 7 }]);
      expect(
        await database.executor.all({
          sql: 'SELECT id, from_seq, to_seq, count, superseded_by FROM audit_ledger WHERE org_id = ? ORDER BY id',
          params: [a.orgId],
        }),
      ).toEqual([
        { id: entry.id, from_seq: 1, to_seq: 5, count: 5, superseded_by: later.id },
        {
          id: '01K7R5V0000000000000000002',
          from_seq: 3,
          to_seq: 5,
          count: 3,
          superseded_by: entry.id,
        },
        { id: later.id, from_seq: 1, to_seq: 7, count: 7, superseded_by: null },
      ]);
    });

    it('merges backwards adjacent appends with bounded summed counts', async () => {
      const repository = createAuditLedgerRepository(database.executor);
      const { a } = orgs();
      await repository.append(a, [{ ...entry, fromSeq: 3, toSeq: 5, count: 1 }]);
      const second = { ...entry, id: '01K7R5V0000000000000000002', toSeq: 2, count: 1 };
      await repository.append(a, [second]);
      const third = { ...entry, id: '01K7R5V0000000000000000003', fromSeq: 6, toSeq: 7, count: 1 };
      await repository.append(a, [third]);
      expect(await repository.page(a, null, 1)).toEqual([{ ...third, fromSeq: 1, count: 3 }]);
      expect(await repository.page(a, third.id, 1)).toEqual([]);
    });

    it('keeps non-adjacent appends separate and merges every matching adjacent gap', async () => {
      const repository = createAuditLedgerRepository(database.executor);
      const { a } = orgs();
      const second = { ...entry, id: '01K7R5V0000000000000000002', fromSeq: 5, toSeq: 6 };
      const third = { ...entry, id: '01K7R5V0000000000000000003', fromSeq: 7, toSeq: 8 };
      await repository.append(a, [entry]);
      await repository.append(a, [second]);
      expect(await repository.page(a, null, 500)).toEqual([entry, second]);
      await repository.append(a, [third]);
      expect(await repository.page(a, null, 500)).toEqual([
        entry,
        { ...third, fromSeq: 5, count: 4 },
      ]);
    });

    it.each([
      { chainId: 'b'.repeat(32) },
      { epoch: 1 },
      { sinkId: 'archive' },
      { reasonCode: 'other' },
    ])('does not merge across incident keys: %j', async (change) => {
      const repository = createAuditLedgerRepository(database.executor);
      const { a } = orgs();
      await seedSink(a.orgId);
      const second = { ...entry, ...change, id: '01K7R5V0000000000000000002', count: 1 };
      await repository.append(a, [entry]);
      await repository.append(a, [second]);
      expect(await repository.page(a, null, 500)).toEqual([entry, second]);
    });

    it('merges by incident key across attribution changes and accepts UUID actors', async () => {
      const repository = createAuditLedgerRepository(database.executor);
      const { a } = orgs();
      await repository.append(a, [entry]);
      const second = {
        ...entry,
        id: '01K7R5V0000000000000000002',
        fromSeq: 3,
        toSeq: 4,
        policy: 'required' as const,
        modeGeneration: 1,
        actorType: 'user' as const,
        actorId: '00112233-4455-6677-8899-aabbccddeeff',
      };
      await repository.append(a, [second]);
      expect(await repository.page(a, null, 500)).toEqual([{ ...second, fromSeq: 1, count: 4 }]);
    });

    it('rejects overlapping composed writes with the generic sentinel error and rolls back', async () => {
      const repository = createAuditLedgerRepository(database.executor);
      const { a } = orgs();
      await repository.append(a, [entry]);
      const control = { ...entry, id: '01K7R5V0000000000000000002', kind: 'export' as const };
      await expect(
        database.executor.batch([
          ...repository.statements(a, [control]),
          ...repository.statements(a, [{ ...entry, id: '01K7R5V0000000000000000003' }]),
        ]),
      ).rejects.toMatchObject({
        name: 'DbError',
        kind: 'not_null',
        constraint: 'audit_ledger.count',
      });
      expect(await repository.page(a, null, 500)).toEqual([entry]);
    });

    it.each([{ first: [1, 2, 2], second: [5, 6, 2], incoming: [3, 4, 2], end: 6, count: 6 }])(
      'merges all visible rows bridged by an append: %j',
      async (scenario) => {
        const repository = createAuditLedgerRepository(database.executor);
        const { a } = orgs();
        const make = (range: number[], id: string) => ({
          ...entry,
          id,
          fromSeq: range[0]!,
          toSeq: range[1]!,
          count: range[2]!,
        });
        await repository.append(a, [make(scenario.first, entry.id)]);
        await repository.append(a, [make(scenario.second, '01K7R5V0000000000000000002')]);
        const incoming = make(scenario.incoming, '01K7R5V0000000000000000003');
        await repository.append(a, [incoming]);
        const expected = [{ ...incoming, fromSeq: 1, toSeq: scenario.end, count: scenario.count }];
        expect(await repository.effectiveGaps(a)).toEqual(expected);
        expect(await repository.page(a, null, 500)).toEqual(expected);
      },
    );

    it.each([
      { fromSeq: 1, toSeq: 19, count: 1 },
      { fromSeq: 10, toSeq: 11, count: 1 },
      { fromSeq: 2, toSeq: 3, count: 1 },
      { fromSeq: 1, toSeq: 10, count: 1 },
    ])('rejects every shared sequence with a visible gap: %j', async (range) => {
      const repository = createAuditLedgerRepository(database.executor);
      const { a } = orgs();
      const first = { ...entry, toSeq: 10, count: 3 };
      const second = { ...entry, id: '01K7R5V0000000000000000002', fromSeq: 20, toSeq: 21 };
      await repository.append(a, [first, second]);
      await expect(
        repository.append(a, [{ ...entry, ...range, id: '01K7R5V0000000000000000003' }]),
      ).rejects.toThrow(new AuditLedgerOverlapError());
      expect(await repository.effectiveGaps(a)).toEqual([first, second]);
    });

    it('keeps statement counts fixed with 300 superseding rows for one key', async () => {
      let statements = 0;
      const repository = createAuditLedgerRepository({
        driver: database.executor.driver,
        all(statement) {
          statements++;
          return database.executor.all(statement);
        },
        batch(batch) {
          statements += batch.length;
          return database.executor.batch(batch);
        },
      });
      const { a } = orgs();
      for (let i = 1; i <= 300; i++) {
        const before = statements;
        await repository.append(a, [
          {
            ...entry,
            id: `${entry.id.slice(0, -4)}${String(i).padStart(4, '0')}`,
            fromSeq: i,
            toSeq: i,
            count: 1,
          },
        ]);
        expect(statements - before).toBe(2);
      }
      statements = 0;
      const expected = [{ ...entry, id: `${entry.id.slice(0, -4)}0300`, toSeq: 300, count: 300 }];
      expect(await repository.effectiveGaps(a)).toEqual(expected);
      expect(await repository.page(a, null, 500)).toEqual(expected);
      expect(statements).toBe(2);
      expect(
        await database.executor.all({
          sql: 'SELECT count(*) AS visible FROM audit_ledger WHERE org_id = ? AND superseded_by IS NULL',
          params: [a.orgId],
        }),
      ).toEqual([{ visible: 1 }]);
    });

    it('executes two batches built before either append without a stale merge', async () => {
      const repository = createAuditLedgerRepository(database.executor);
      const { a } = orgs();
      const first = repository.statements(a, [entry]);
      const later = { ...entry, id: '01K7R5V0000000000000000002', fromSeq: 3, toSeq: 4 };
      const second = repository.statements(a, [later]);
      await Promise.all([database.executor.batch(first), database.executor.batch(second)]);
      const [visible, ...rest] = await repository.effectiveGaps(a);
      expect(rest).toEqual([]);
      expect([
        { ...later, fromSeq: 1, count: 4 },
        { ...entry, toSeq: 4, count: 4 },
      ]).toContainEqual(visible);
    });

    it.each([
      { order: 'earlier first', reverse: false },
      { order: 'later first', reverse: true },
    ])(
      'merges two separately built batches in either serial order: $order',
      async ({ reverse }) => {
        const repository = createAuditLedgerRepository(database.executor);
        const { a } = orgs();
        const later = { ...entry, id: '01K7R5V0000000000000000002', fromSeq: 3, toSeq: 4 };
        const batches = [repository.statements(a, [entry]), repository.statements(a, [later])];
        for (const batch of reverse ? batches.reverse() : batches)
          await database.executor.batch(batch);
        expect(await repository.effectiveGaps(a)).toEqual([
          reverse ? { ...entry, toSeq: 4, count: 4 } : { ...later, fromSeq: 1, count: 4 },
        ]);
      },
    );

    it('reads history whose markers were set through the guarded update, in any insertion order', async () => {
      const repository = createAuditLedgerRepository(database.executor);
      const { a } = orgs();
      const first = { ...entry, id: '01K7R5V0000000000000000003' };
      const second = { ...entry, id: '01K7R5V0000000000000000002', toSeq: 4, count: 3 };
      const third = { ...entry, id: '01K7R5V0000000000000000001', toSeq: 6, count: 4 };
      await database.executor.batch([
        rawRow(a.orgId, third),
        rawRow(a.orgId, first),
        rawRow(a.orgId, second),
        supersede(a.orgId, first.id, second.id),
        supersede(a.orgId, second.id, third.id),
      ]);
      expect(await repository.effectiveGaps(a)).toEqual([third]);
      expect(await repository.page(a, null, 500)).toEqual([third]);
    });

    it('refuses to insert a row that is already hidden', async () => {
      const { a } = orgs();
      const covering = { ...entry, id: '01K7R5V0000000000000000002', toSeq: 4, count: 3 };
      await database.executor.batch([rawRow(a.orgId, covering)]);
      await expect(
        database.executor.batch([rawRow(a.orgId, entry, covering.id)]),
      ).rejects.toMatchObject({
        name: 'DbError',
        message: expect.stringContaining('audit ledger rows are inserted visible'),
      });
      expect(await rows(a.orgId)).toHaveLength(1);
    });

    it('refuses a coverer whose count is below the sum of the gaps it hides', async () => {
      const { a } = orgs();
      const low = { ...entry, id: '01K7R5V0000000000000000001', toSeq: 2, count: 2 };
      const high = { ...entry, id: '01K7R5V0000000000000000002', fromSeq: 5, toSeq: 6, count: 2 };
      const coverer = { ...entry, id: '01K7R5V0000000000000000003', toSeq: 6, count: 3 };
      await database.executor.batch([
        rawRow(a.orgId, low),
        rawRow(a.orgId, high),
        rawRow(a.orgId, coverer),
        supersede(a.orgId, low.id, coverer.id),
      ]);
      await expect(
        database.executor.batch([supersede(a.orgId, high.id, coverer.id)]),
      ).rejects.toMatchObject({
        name: 'DbError',
        message: expect.stringContaining('audit ledger is append-only'),
      });
      expect(
        await database.executor.all({
          sql: 'SELECT id, superseded_by FROM audit_ledger WHERE org_id = ? ORDER BY id',
          params: [a.orgId],
        }),
      ).toEqual([
        { id: low.id, superseded_by: coverer.id },
        { id: high.id, superseded_by: null },
        { id: coverer.id, superseded_by: null },
      ]);
    });

    it.each([
      { name: 'equal ranges', first: [1, 2, 1], second: [1, 2, 2] },
      { name: 'a larger range with a smaller count', first: [1, 3, 1], second: [1, 2, 2] },
      { name: 'a partial overlap', first: [1, 3, 2], second: [3, 5, 2] },
    ])(
      'names visible rows sharing a sequence an integrity failure when a read returns them or an append touches them: $name',
      async (scenario) => {
        const repository = createAuditLedgerRepository(database.executor);
        const { a } = orgs();
        const cursor = '01K7R5V0000000000000000004';
        for (const [id, [fromSeq = 0, toSeq = 0, count = 0]] of [
          ['01K7R5V0000000000000000005', scenario.first],
          [cursor, scenario.second],
        ] as const) {
          const row = { ...entry, id, fromSeq, toSeq, count };
          await database.executor.batch([rawRow(a.orgId, row)]);
        }
        await expect(repository.effectiveGaps(a)).rejects.toThrow(new AuditLedgerIntegrityError());
        await expect(repository.page(a, null, 500)).rejects.toThrow(
          new AuditLedgerIntegrityError(),
        );
        await expect(repository.page(a, cursor, 1)).rejects.toThrow(
          new AuditLedgerIntegrityError(),
        );
        for (const report of [
          { fromSeq: 6, toSeq: 6 },
          { fromSeq: 2, toSeq: 2 },
        ]) {
          await expect(
            repository.append(a, [
              { ...entry, ...report, id: '01K7R5V0000000000000000009', count: 1 },
            ]),
          ).rejects.toThrow(new AuditLedgerIntegrityError());
        }
      },
    );

    it('names an over-counted visible row an integrity failure on append', async () => {
      const repository = createAuditLedgerRepository(database.executor);
      const { a } = orgs();
      await database.executor.batch([rawRow(a.orgId, { ...entry, count: 3 })]);
      await expect(
        repository.append(a, [
          { ...entry, id: '01K7R5V0000000000000000002', fromSeq: 3, toSeq: 3, count: 1 },
        ]),
      ).rejects.toThrow(new AuditLedgerIntegrityError());
      await expect(repository.effectiveGaps(a)).rejects.toThrow(new AuditLedgerIntegrityError());
    });

    it('treats a retried identical append as acknowledged and a changed one as a duplicate', async () => {
      const repository = createAuditLedgerRepository(database.executor);
      const { a } = orgs();
      const second = { ...entry, id: '01K7R5V0000000000000000002', fromSeq: 3, toSeq: 4, count: 1 };
      const third = { ...entry, id: '01K7R5V0000000000000000003', fromSeq: 6, toSeq: 6, count: 1 };
      const control = { ...entry, id: '01K7R5V0000000000000000004', kind: 'export' as const };
      await repository.append(a, [entry]);
      await repository.append(a, [second, control]);
      const merged = [{ ...second, fromSeq: 1, count: 3 }, control];
      for (const retry of [[entry], [second], [control], [second, control]]) {
        await repository.append(a, retry);
        expect(await repository.page(a, null, 500)).toEqual(merged);
      }
      await repository.append(a, [{ ...third, fromSeq: 5 }]);
      const later = { ...third, fromSeq: 1, count: 4 };
      await repository.append(a, [second]);
      expect(await repository.effectiveGaps(a)).toEqual([later]);
      for (const changed of [
        { ...second, count: 2 },
        { ...second, fromSeq: 2 },
        { ...second, policy: 'required' as const },
        { ...second, createdAt: '2026-10-28T10:00:01.000Z' },
        { ...control, count: 1 },
      ]) {
        await expect(repository.append(a, [changed])).rejects.toMatchObject({
          name: 'DbError',
          kind: 'unique',
          constraint: 'audit_ledger.org_id, audit_ledger.id',
        });
      }
      await expect(
        repository.append(a, [{ ...second, id: '01K7R5V0000000000000000009' }]),
      ).rejects.toThrow(new AuditLedgerOverlapError());
      expect(await repository.page(a, null, 500)).toEqual([later, control]);
    });

    it.each([
      { order: 'in sequence order', batch: (x: AuditLedgerEntry, y: AuditLedgerEntry) => [x, y] },
      { order: 'in reverse order', batch: (x: AuditLedgerEntry, y: AuditLedgerEntry) => [y, x] },
    ])('acknowledges a retry of every report of a coalesced batch, $order', async ({ batch }) => {
      const repository = createAuditLedgerRepository(database.executor);
      const { a } = orgs();
      const first = { ...entry, id: '01K7R5V0000000000000000001', count: 2 };
      const second = { ...entry, id: '01K7R5V0000000000000000002', fromSeq: 3, toSeq: 4, count: 2 };
      await repository.append(a, batch(first, second));
      const before = await rows(a.orgId);
      const visible = await repository.effectiveGaps(a);
      expect(visible).toHaveLength(1);
      expect(visible[0]).toMatchObject({ fromSeq: 1, toSeq: 4, count: 4 });
      for (const retry of [[first], [second], batch(first, second), batch(second, first)]) {
        await repository.append(a, retry);
        expect(await rows(a.orgId)).toEqual(before);
      }
      for (const changed of [
        { ...second, fromSeq: 1, count: 4 },
        { ...first, toSeq: 4, count: 4 },
        { ...second, count: 1 },
      ]) {
        await expect(repository.append(a, [changed])).rejects.toMatchObject({
          name: 'DbError',
          kind: 'unique',
          constraint: 'audit_ledger.org_id, audit_ledger.id',
        });
      }
      expect(await rows(a.orgId)).toEqual(before);
    });

    it('names corruption next to a retried report an integrity failure and writes nothing', async () => {
      const repository = createAuditLedgerRepository(database.executor);
      const { a } = orgs();
      const stored = { ...entry, toSeq: 4, count: 4 };
      await repository.append(a, [stored]);
      const corrupt = { ...entry, id: '01K7R5V0000000000000000002', fromSeq: 2, toSeq: 3 };
      await database.executor.batch([rawRow(a.orgId, corrupt)]);
      const before = await rows(a.orgId);
      await expect(repository.append(a, [stored])).rejects.toThrow(new AuditLedgerIntegrityError());
      expect(await rows(a.orgId)).toEqual(before);
    });

    it('writes nothing on an identical retry, even with untouched corrupt rows inside its range', async () => {
      const repository = createAuditLedgerRepository(database.executor);
      const { a } = orgs();
      const head = { ...entry, toSeq: 7, count: 7 };
      const tail = { ...entry, id: '01K7R5V0000000000000000002', fromSeq: 8, toSeq: 10, count: 1 };
      await repository.append(a, [head]);
      await repository.append(a, [tail]);
      await database.executor.batch([
        rawRow(a.orgId, {
          ...entry,
          id: '01K7R5V0000000000000000003',
          fromSeq: 2,
          toSeq: 2,
          count: 1,
        }),
        rawRow(a.orgId, {
          ...entry,
          id: '01K7R5V0000000000000000004',
          fromSeq: 4,
          toSeq: 4,
          count: 1,
        }),
      ]);
      const before = await rows(a.orgId);
      await repository.append(a, [tail]);
      expect(await rows(a.orgId)).toEqual(before);
    });

    it('handles the largest safe sequence at the range boundary', async () => {
      const repository = createAuditLedgerRepository(database.executor);
      const { a } = orgs();
      const top = Number.MAX_SAFE_INTEGER;
      const last = { ...entry, fromSeq: top, toSeq: top, count: 1 };
      const below = {
        ...entry,
        id: '01K7R5V0000000000000000002',
        fromSeq: top - 2,
        toSeq: top - 1,
      };
      const control = {
        ...entry,
        id: '01K7R5V0000000000000000003',
        kind: 'export' as const,
        fromSeq: top,
        toSeq: top,
        count: 0,
      };
      await repository.append(a, [last, control]);
      await repository.append(a, [below]);
      await repository.append(a, [below]);
      expect(await repository.page(a, null, 500)).toEqual([
        { ...below, toSeq: top, count: 3 },
        control,
      ]);
      await expect(
        repository.append(a, [{ ...last, id: '01K7R5V0000000000000000004' }]),
      ).rejects.toThrow(new AuditLedgerOverlapError());
    });

    const report = (n: number, fromSeq: number, toSeq: number, count: number) => ({
      ...entry,
      id: `01K7R5V000000000000000000${String(n)}`,
      fromSeq,
      toSeq,
      count,
      modeGeneration: n,
    });
    const one = report(1, 1, 2, 1);
    const two = report(2, 3, 5, 3);
    const three = report(3, 6, 6, 1);
    it.each([
      { name: 'sorted', reports: [one, two, three], expected: three },
      { name: 'out of sequence order', reports: [three, one, two], expected: two },
    ])(
      'merges adjacent gaps submitted in one batch, $name, with the latest report attribution',
      async ({ reports, expected }) => {
        const repository = createAuditLedgerRepository(database.executor);
        const { a } = orgs();
        const control = {
          ...entry,
          id: '01K7R5V0000000000000000009',
          kind: 'mode_change' as const,
        };
        await repository.append(a, [...reports.slice(0, 1), control, ...reports.slice(1)]);
        expect(await repository.effectiveGaps(a)).toEqual([
          { ...expected, fromSeq: 1, toSeq: 6, count: 5 },
        ]);
        expect(await repository.page(a, expected.id, 500)).toEqual([control]);
      },
    );

    it('keeps interleaved incident keys of one batch apart while merging each', async () => {
      const repository = createAuditLedgerRepository(database.executor);
      const { a } = orgs();
      await seedSink(a.orgId);
      const keys = [
        {},
        { chainId: 'b'.repeat(32) },
        { epoch: 1 },
        { sinkId: 'archive' },
        { reasonCode: 'other' },
      ];
      const reports = keys.flatMap((key, n) => [
        { ...entry, ...key, id: `01K7R5V00000000000000001${String(n)}0`, toSeq: 2, count: 1 },
        {
          ...entry,
          ...key,
          id: `01K7R5V00000000000000001${String(n)}1`,
          fromSeq: 3,
          toSeq: 4,
          count: 1,
        },
      ]);
      await repository.append(a, reports.reverse());
      const visible = await repository.effectiveGaps(a);
      expect(visible).toHaveLength(keys.length);
      for (const gap of visible) expect(gap).toMatchObject({ fromSeq: 1, toSeq: 4, count: 2 });
    });

    it('rejects a batch whose reports share a sequence and persists none of it', async () => {
      const repository = createAuditLedgerRepository(database.executor);
      const { a } = orgs();
      for (const second of [
        { fromSeq: 2, toSeq: 5, count: 1 },
        { fromSeq: 1, toSeq: 2, count: 1 },
      ]) {
        await expect(
          repository.append(a, [
            { ...entry, count: 1 },
            { ...entry, ...second, id: '01K7R5V0000000000000000002' },
          ]),
        ).rejects.toThrow(new AuditLedgerOverlapError());
      }
      expect(await rows(a.orgId)).toEqual([]);
    });

    it('refuses to hide a gap behind anything but a covering visible gap', async () => {
      const repository = createAuditLedgerRepository(database.executor);
      const { a } = orgs();
      const wide = { ...entry, id: '01K7R5V0000000000000000002', fromSeq: 4, toSeq: 9, count: 1 };
      await repository.append(a, [entry, wide]);
      for (const [target, by] of [
        [entry.id, wide.id],
        [wide.id, entry.id],
        [entry.id, entry.id],
        [entry.id, '01K7R5V0000000000000000009'],
      ]) {
        await expect(
          database.executor.batch([
            {
              sql: 'UPDATE audit_ledger SET superseded_by = ? WHERE org_id = ? AND id = ?',
              params: [by!, a.orgId, target!],
            },
          ]),
        ).rejects.toMatchObject({ name: 'DbError' });
      }
      expect(await repository.effectiveGaps(a)).toEqual([entry, wide]);
    });

    it('pages by identity and scopes identical ids to their organization', async () => {
      const repository = createAuditLedgerRepository(database.executor);
      const { a, b } = orgs();
      const second = { ...entry, id: '01K7R5V0000000000000000002', kind: 'export' as const };
      await repository.append(a, [second, entry]);
      await repository.append(b, [{ ...entry, count: 1 }]);
      expect(await repository.page(a, null, 1)).toEqual([entry]);
      expect(await repository.page(a, entry.id, 1)).toEqual([second]);
      expect(await repository.effectiveGaps(a)).toEqual([entry]);
      expect(await repository.effectiveGaps(b)).toEqual([{ ...entry, count: 1 }]);
      expect(await repository.page(a, second.id, 1)).toEqual([]);
      expect(await repository.page(b, null, 500)).toEqual([{ ...entry, count: 1 }]);
    });

    it('supports every disposition and control kind in the frozen schema', async () => {
      const repository = createAuditLedgerRepository(database.executor);
      const entries = AUDIT_LEDGER_KINDS.map((kind, i) => ({
        ...entry,
        kind,
        sinkId: 'archive',
        id: `${entry.id.slice(0, -4)}${String(i).padStart(4, '0')}`,
      }));
      await seedSink(orgs().a.orgId);
      await repository.append(orgs().a, entries);
      expect(await repository.page(orgs().a, null, 500)).toEqual(entries);
    });

    it('returns statements that persist when composed with another write', async () => {
      const { a } = orgs();
      const repository = createAuditLedgerRepository(database.executor);
      const statements = repository.statements(a, [entry]);
      expect(statements).toHaveLength(2);
      expect(await repository.page(a, null, 500)).toEqual([]);
      await database.executor.batch([
        ...statements,
        { sql: "UPDATE organization SET name = 'Ledger batch' WHERE id = ?", params: [a.orgId] },
      ]);
      expect(await repository.page(a, null, 500)).toEqual([entry]);
      expect(
        await database.executor.all({
          sql: 'SELECT name FROM organization WHERE id = ?',
          params: [a.orgId],
        }),
      ).toEqual([{ name: 'Ledger batch' }]);
    });

    it('rejects duplicate inserts, updates and deletes', async () => {
      const { a } = orgs();
      const repository = createAuditLedgerRepository(database.executor);
      await repository.append(a, [entry]);
      await expect(repository.append(a, [{ ...entry, kind: 'export' }])).rejects.toMatchObject({
        name: 'DbError',
        kind: 'unique',
        constraint: 'audit_ledger.org_id, audit_ledger.id',
      });
      for (const sql of [
        'UPDATE audit_ledger SET count = 0 WHERE org_id = ?',
        'DELETE FROM audit_ledger WHERE org_id = ?',
      ])
        await expect(database.executor.batch([{ sql, params: [a.orgId] }])).rejects.toMatchObject({
          name: 'DbError',
          kind: 'unknown',
          message: expect.stringContaining('audit ledger is append-only'),
        });
      expect(await repository.page(a, null, 500)).toEqual([entry]);
    });

    it('rejects a sink id that exists only in another organization', async () => {
      const { a, b } = orgs();
      await database.executor.batch([
        {
          sql: `INSERT INTO audit_sink (org_id, sink_id, plugin_id, kind, generation, receiver_fingerprint,
        durable_ack, activation_source, state, progress_seq, progress_hash, custody_seq)
        VALUES (?, 'archive', 'test', 'webhook', 0, 'fingerprint', 1, 'build', 'active', 0, ?, 0)`,
          params: [b.orgId, '0'.repeat(64)],
        },
      ]);
      const repository = createAuditLedgerRepository(database.executor);
      const sinkEntry = {
        ...entry,
        sinkId: 'archive',
        actorType: 'user' as const,
        actorId: entry.id,
      };
      await repository.append(b, [sinkEntry]);
      expect(await repository.page(b, null, 1)).toEqual([sinkEntry]);
      await expect(repository.append(a, [sinkEntry])).rejects.toMatchObject({
        name: 'DbError',
        kind: 'foreign_key',
      });
      expect(await repository.page(a, null, 500)).toEqual([]);
    });

    it('refuses unsafe stored identifiers without returning or echoing them', async () => {
      const { a } = orgs();
      const repository = createAuditLedgerRepository(database.executor);
      const [statement] = repository.statements(a, [entry]);
      if (statement === undefined) throw new Error('missing insert');
      const params = [...statement.params];
      params[13] = 'secret@example.com';
      await database.executor.batch([{ ...statement, params }]);
      await expect(repository.page(a, null, 500)).rejects.toThrow(new AuditLedgerIntegrityError());
      await expect(repository.effectiveGaps(a)).rejects.toThrow(new AuditLedgerIntegrityError());
    });

    it('validates the whole batch and page arguments before issuing SQL', async () => {
      const repository = createAuditLedgerRepository({
        driver: 'none',
        all() {
          throw new Error('unexpected query');
        },
        batch() {
          throw new Error('unexpected batch');
        },
      });
      await expect(
        repository.append(orgs().a, [entry, { ...entry, actorId: 'secret@example.com' }]),
      ).rejects.toThrow(new TypeError('invalid audit ledger entry'));
      await repository.append(orgs().a, []);
      for (const limit of [0, 501, 1.5, NaN])
        await expect(repository.page(orgs().a, null, limit)).rejects.toThrow(
          new RangeError('invalid audit ledger page'),
        );
      await expect(repository.page(orgContext('unknown'), 'secret@example.com', 1)).rejects.toThrow(
        new RangeError('invalid audit ledger page'),
      );
    });
  });
}
