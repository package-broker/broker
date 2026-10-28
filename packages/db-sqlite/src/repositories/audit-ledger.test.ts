import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUDIT_LEDGER_KINDS, type AuditLedgerEntry } from '@package-broker/core/audit/ledger';
import { DbError } from '@package-broker/core/db/errors';
import { orgContext } from '@package-broker/core/db/port';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { AuditLedgerIntegrityError, createAuditLedgerRepository } from './audit-ledger.js';

let database: MigratedDatabase;
beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
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
        sql: 'SELECT id, from_seq, to_seq, count FROM audit_ledger WHERE org_id = ? ORDER BY id',
        params: [a.orgId],
      }),
    ).toEqual([
      { id: entry.id, from_seq: 1, to_seq: 5, count: 5 },
      { id: later.id, from_seq: 1, to_seq: 7, count: 7 },
    ]);
  });

  it('merges overlapping and backwards adjacent appends with bounded summed counts', async () => {
    const repository = createAuditLedgerRepository(database.executor);
    const { a } = orgs();
    await repository.append(a, [{ ...entry, fromSeq: 3, toSeq: 5, count: 1 }]);
    const second = { ...entry, id: '01K7R5V0000000000000000002', toSeq: 3, count: 1 };
    await repository.append(a, [second]);
    const third = { ...entry, id: '01K7R5V0000000000000000003', fromSeq: 6, toSeq: 7, count: 1 };
    await repository.append(a, [third]);
    expect(await repository.page(a, null, 1)).toEqual([{ ...third, fromSeq: 1, count: 3 }]);
    expect(await repository.page(a, third.id, 1)).toEqual([]);
  });

  it('keeps non-adjacent appends separate and merges only the latest matching gap', async () => {
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

  it('rejects a merged count exceeding its range and rolls back other batch writes', async () => {
    const repository = createAuditLedgerRepository(database.executor);
    const { a } = orgs();
    await repository.append(a, [entry]);
    const control = { ...entry, id: '01K7R5V0000000000000000002', kind: 'export' as const };
    await expect(
      database.executor.batch([
        ...repository.statements(a, [control]),
        ...repository.statements(a, [{ ...entry, id: '01K7R5V0000000000000000003' }]),
      ]),
    ).rejects.toThrow(new DbError('check', 'check: CHECK constraint failed: count >= 0'));
    expect(await repository.page(a, null, 500)).toEqual([entry]);
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
    expect(statements).toHaveLength(1);
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
    await expect(repository.append(a, [{ ...entry, kind: 'export' }])).rejects.toThrow(
      new DbError(
        'unique',
        'unique: UNIQUE constraint failed: audit_ledger.org_id, audit_ledger.id',
        { constraint: 'audit_ledger.org_id, audit_ledger.id' },
      ),
    );
    for (const sql of [
      'UPDATE audit_ledger SET count = 0 WHERE org_id = ?',
      'DELETE FROM audit_ledger WHERE org_id = ?',
    ])
      await expect(database.executor.batch([{ sql, params: [a.orgId] }])).rejects.toThrow(
        new DbError('unknown', 'unknown: audit ledger is append-only'),
      );
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
    await expect(repository.append(a, [sinkEntry])).rejects.toThrow();
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
