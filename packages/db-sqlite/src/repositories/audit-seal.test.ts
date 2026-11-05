import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AUDIT_GENESIS_HASH,
  hashRow,
  verifyChain,
  type AuditRow,
} from '@package-broker/core/audit/chain';
import { sql } from 'kysely';
import { createAuditLedgerRepository } from './audit-ledger.js';
import { assertCheck } from '../kysely.js';
import { AuditLedgerIntegrityError } from '@package-broker/core/audit/ledger';
import { auditSealJob } from '@package-broker/core/audit/sealer';
import type { JobContext } from '@package-broker/core/platform/jobs';
import { DbError } from '@package-broker/core/db/errors';
import type { SqlExecutor, Statement } from '@package-broker/core/db/port';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createAuditSealRepository } from './audit-seal.js';

let database: MigratedDatabase;
let executor: SqlExecutor;

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  executor = database.executor;
});

afterEach(async () => {
  await database.close();
});

function orgs() {
  if (database.orgs === null) throw new Error('organizations were not seeded');
  return database.orgs;
}

function pendingId(n: number): string {
  return `01J0PENDING${String(n).padStart(15, '0')}`;
}

async function addPending(orgId: string, from: number, count: number): Promise<void> {
  const statements: Statement[] = [];
  for (let n = from; n < from + count; n += 1) {
    statements.push({
      sql: 'INSERT INTO audit_pending (id, org_id, created_at, actor_type, actor_id, source_ip, action, target_type, target_id, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      params: [
        pendingId(n),
        orgId,
        '2026-10-17T10:00:00.000Z',
        'user',
        'actor-1',
        '203.0.113.7',
        'package.publish',
        'package',
        `pkg-${n}`,
        `{"n":${n}}`,
      ],
    });
  }
  await executor.batch(statements);
}

async function events(orgId: string): Promise<AuditRow[]> {
  return executor.all<AuditRow>({
    sql: 'SELECT * FROM audit_event WHERE org_id = ? ORDER BY seq',
    params: [orgId],
  });
}

async function pendingIds(orgId: string): Promise<string[]> {
  const rows = await executor.all<{ id: string }>({
    sql: 'SELECT id FROM audit_pending WHERE org_id = ? ORDER BY id',
    params: [orgId],
  });
  return rows.map((row) => row.id);
}

async function scalar(sql: string): Promise<number> {
  const [row] = await executor.all<{ n: number }>({ sql, params: [] });
  return row?.n ?? -1;
}

describe('createAuditSealRepository', () => {
  it('1: seals three pending rows into a chain from genesis and empties audit_pending', async () => {
    const { a } = orgs();
    await addPending(a.orgId, 1, 3);

    const outcome = await createAuditSealRepository(executor).seal(a);

    const rows = await events(a.orgId);
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(rows.map((row) => row.id)).toEqual([pendingId(1), pendingId(2), pendingId(3)]);
    expect(rows[0]?.prev_hash).toBe(AUDIT_GENESIS_HASH);
    expect(rows[1]?.prev_hash).toBe(rows[0]?.hash);
    expect(rows[2]?.prev_hash).toBe(rows[1]?.hash);
    for (const row of rows) expect(row.hash).toBe(await hashRow(row.prev_hash, row));
    expect(await pendingIds(a.orgId)).toEqual([]);
    expect(outcome).toEqual({
      outcome: 'sealed',
      sealed: 3,
      headSeq: 3,
      headHash: rows[2]?.hash,
    });
  });

  it('2: answers empty and writes nothing when nothing is pending', async () => {
    const { a } = orgs();
    const before = await scalar('SELECT total_changes() AS n');

    const outcome = await createAuditSealRepository(executor).seal(a);

    expect(outcome).toEqual({ outcome: 'empty' });
    expect(await events(a.orgId)).toEqual([]);
    expect(await scalar('SELECT total_changes() AS n')).toBe(before);
  });

  it('3: seals 120 pending rows as 100 then 20 and the whole chain verifies', async () => {
    const { a } = orgs();
    await addPending(a.orgId, 1, 120);
    const batchSizes: number[] = [];
    const recording: SqlExecutor = {
      ...executor,
      all: (statement) => executor.all(statement),
      batch: (statements) => {
        batchSizes.push(statements.length);
        return executor.batch(statements);
      },
    };
    const repository = createAuditSealRepository(recording);

    const first = await repository.seal(a);

    expect(first).toMatchObject({ outcome: 'sealed', sealed: 100, headSeq: 100 });
    expect(batchSizes).toEqual([105]);
    expect((await events(a.orgId)).map((row) => row.id)).toEqual(
      Array.from({ length: 100 }, (_, i) => pendingId(i + 1)),
    );
    expect(await pendingIds(a.orgId)).toHaveLength(20);

    const second = await repository.seal(a);

    expect(second).toMatchObject({ outcome: 'sealed', sealed: 20, headSeq: 120 });
    expect(batchSizes).toEqual([105, 25]);
    const rows = await events(a.orgId);
    expect(rows.map((row) => row.seq)).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
    expect(await verifyChain(rows)).toBeNull();
  });

  it('4: a second sealer built from the same head answers contended and changes nothing', async () => {
    const { a } = orgs();
    await addPending(a.orgId, 1, 3);
    const winner = createAuditSealRepository(executor);
    let raced = false;
    const racing: SqlExecutor = {
      ...executor,
      driver: executor.driver,
      all: (statement) => executor.all(statement),
      batch: async (statements) => {
        if (!raced) {
          raced = true;
          expect(await winner.seal(a)).toMatchObject({ outcome: 'sealed', sealed: 3 });
        }
        return executor.batch(statements);
      },
    };

    const loser = await createAuditSealRepository(racing).seal(a);

    expect(loser).toEqual({ outcome: 'contended' });
    const rows = await events(a.orgId);
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(await verifyChain(rows)).toBeNull();
    expect(await pendingIds(a.orgId)).toEqual([]);
  });

  it('4b: a contended batch leaves the pending rows that the loser had read in place', async () => {
    const { a } = orgs();
    await addPending(a.orgId, 1, 2);
    let raced = false;
    const racing: SqlExecutor = {
      ...executor,
      driver: executor.driver,
      all: (statement) => executor.all(statement),
      batch: async (statements) => {
        if (!raced) {
          raced = true;
          await addPending(a.orgId, 3, 1);
          await executor.batch([
            {
              sql: 'INSERT INTO audit_event (id, org_id, seq, prev_hash, hash, created_at, actor_type, action, target_type) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)',
              params: [
                'foreign-event',
                a.orgId,
                AUDIT_GENESIS_HASH,
                'f'.repeat(64),
                '2026-10-17T09:00:00.000Z',
                'system',
                'org.seed',
                'organization',
              ],
            },
          ]);
        }
        return executor.batch(statements);
      },
    };

    const outcome = await createAuditSealRepository(racing).seal(a);

    expect(outcome).toEqual({ outcome: 'contended' });
    expect(await pendingIds(a.orgId)).toEqual([pendingId(1), pendingId(2), pendingId(3)]);
    expect((await events(a.orgId)).map((row) => row.id)).toEqual(['foreign-event']);
  });

  it('4c: already sealed pending ids with a current head contend on the primary key only', async () => {
    const { a } = orgs();
    await addPending(a.orgId, 2, 1);
    await createAuditSealRepository(executor).seal(a);
    const before = await events(a.orgId);
    await addPending(a.orgId, 1, 2);
    const recording: SqlExecutor = {
      ...executor,
      all: (statement) => executor.all(statement),
      batch: async (statements) => {
        try {
          return await executor.batch(statements);
        } catch (error) {
          expect(error).toMatchObject({ kind: 'unique', constraint: 'audit_event.id' });
          throw error;
        }
      },
    };

    expect(await createAuditSealRepository(recording).seal(a)).toEqual({ outcome: 'contended' });
    expect(await pendingIds(a.orgId)).toEqual([pendingId(1), pendingId(2)]);
    expect(await events(a.orgId)).toEqual(before);
  });

  it('5: does not seal or delete pending rows of another organization', async () => {
    const { a, b } = orgs();
    await addPending(a.orgId, 1, 2);
    await addPending(b.orgId, 3, 2);

    const outcome = await createAuditSealRepository(executor).seal(a);

    expect(outcome).toMatchObject({ outcome: 'sealed', sealed: 2 });
    expect(await pendingIds(b.orgId)).toEqual([pendingId(3), pendingId(4)]);
    expect(await events(b.orgId)).toEqual([]);
    expect((await events(a.orgId)).map((row) => row.id)).toEqual([pendingId(1), pendingId(2)]);
  });

  it('5b: sealing an organization with only foreign pending rows answers empty', async () => {
    const { a, b } = orgs();
    await addPending(b.orgId, 1, 2);

    expect(await createAuditSealRepository(executor).seal(a)).toEqual({ outcome: 'empty' });
    expect(await pendingIds(b.orgId)).toHaveLength(2);
  });

  it('5c: chains each organization from its own head', async () => {
    const { a, b } = orgs();
    await addPending(a.orgId, 1, 2);
    await addPending(b.orgId, 3, 1);
    const repository = createAuditSealRepository(executor);

    await repository.seal(a);
    await repository.seal(b);

    const rowsB = await events(b.orgId);
    expect(rowsB.map((row) => row.seq)).toEqual([1]);
    expect(rowsB[0]?.prev_hash).toBe(AUDIT_GENESIS_HASH);
    expect(await verifyChain(await events(a.orgId))).toBeNull();
  });

  it('5d: every statement is scoped by the organization id', async () => {
    const { a } = orgs();
    await addPending(a.orgId, 1, 2);
    const seen: Statement[] = [];
    const recording: SqlExecutor = {
      ...executor,
      driver: executor.driver,
      all: (statement) => {
        seen.push(statement);
        return executor.all(statement);
      },
      batch: (statements) => {
        seen.push(...statements);
        return executor.batch(statements);
      },
    };

    await createAuditSealRepository(recording).seal(a);

    expect(seen).toHaveLength(2 + 7);
    for (const statement of seen) {
      const guard = [
        ...assertCheck(sql`changes() = 1`),
        ...assertCheck(sql`changes() = ${2}`),
      ].find((candidate) => candidate.sql === statement.sql);
      if (guard !== undefined) {
        expect(statement.params).toEqual(
          guard.params.map((value) =>
            typeof value === 'string' ? expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/) : value,
          ),
        );
        continue;
      }
      expect(statement.params).toContain(a.orgId);
      if (!statement.sql.startsWith('INSERT')) expect(statement.sql).toMatch(/org_id = \?/);
    }
  });

  it('6: changing source_ip after sealing keeps the chain valid', async () => {
    const { a } = orgs();
    await addPending(a.orgId, 1, 2);
    await createAuditSealRepository(executor).seal(a);
    const sealed = await events(a.orgId);
    expect(sealed.map((row) => row.source_ip)).toEqual(['203.0.113.7', '203.0.113.7']);

    await executor.batch([
      {
        sql: "UPDATE audit_event SET source_ip = '198.51.100.9' WHERE org_id = ?",
        params: [a.orgId],
      },
    ]);

    expect(await verifyChain(await events(a.orgId))).toBeNull();
  });

  it('6b: changing action after sealing is reported as a hash break', async () => {
    const { a } = orgs();
    await addPending(a.orgId, 1, 2);
    await createAuditSealRepository(executor).seal(a);

    await executor.batch([
      {
        sql: "UPDATE audit_event SET action = 'package.delete' WHERE org_id = ? AND seq = 2",
        params: [a.orgId],
      },
    ]);

    expect(await verifyChain(await events(a.orgId))).toEqual({ seq: 2, reason: 'hash' });
  });

  it('keeps chain counters equal to the migration byte representation, including Unicode', async () => {
    const { a } = orgs();
    await addPending(a.orgId, 1, 3);
    await executor.batch([
      {
        sql: `UPDATE audit_pending SET payload_json = '{"label":"żółw 🐢"}' WHERE org_id = ?`,
        params: [a.orgId],
      },
    ]);
    await createAuditSealRepository(executor).seal(a);
    const rows = await events(a.orgId);
    const [chain] = await executor.all<{
      journal_rows: number;
      journal_bytes: number;
      head_seq: number;
      head_hash: string;
    }>({ sql: 'SELECT * FROM audit_chain WHERE org_id = ?', params: [a.orgId] });
    expect(chain).toMatchObject({
      journal_rows: 3,
      journal_bytes: rows.reduce(
        (n, row) => n + new TextEncoder().encode(JSON.stringify(row)).length,
        0,
      ),
      head_seq: 3,
      head_hash: rows[2]?.hash,
    });
  });

  it('repairs an old sealer head and counters before extending the journal', async () => {
    const { a } = orgs();
    await addPending(a.orgId, 1, 2);
    const repo = createAuditSealRepository(executor);
    await repo.seal(a);
    await executor.batch([
      {
        sql: 'UPDATE audit_chain SET head_seq = 0, head_hash = ?, journal_rows = 0, journal_bytes = 0 WHERE org_id = ?',
        params: [AUDIT_GENESIS_HASH, a.orgId],
      },
    ]);
    await addPending(a.orgId, 3, 1);
    expect(await repo.seal(a)).toMatchObject({ outcome: 'sealed', headSeq: 3 });
    expect(await verifyChain(await events(a.orgId))).toBeNull();
    expect(
      await executor.all({
        sql: 'SELECT journal_rows FROM audit_chain WHERE org_id = ?',
        params: [a.orgId],
      }),
    ).toEqual([{ journal_rows: 3 }]);
  });

  it.each(['same sequence', 'extension anchor'] as const)(
    'records and repairs a mismatching head hash: %s',
    async (kind) => {
      const { a } = orgs();
      await addPending(a.orgId, 1, 2);
      const repo = createAuditSealRepository(executor);
      await repo.seal(a);
      await executor.batch([
        {
          sql: 'UPDATE audit_chain SET head_seq = ?, head_hash = ? WHERE org_id = ?',
          params: [kind === 'same sequence' ? 2 : 1, 'f'.repeat(64), a.orgId],
        },
      ]);
      await addPending(a.orgId, 3, 1);
      const before = await events(a.orgId);
      expect(await repo.seal(a)).toMatchObject({
        outcome: 'sealed',
        headSeq: 3,
        integrity: ['head_mismatch'],
      });
      expect(await repo.seal(a)).toEqual({ outcome: 'empty' });
      const after = await events(a.orgId);
      expect(after.slice(0, 2)).toEqual(before);
      expect(after[2]?.prev_hash).toBe(before[1]?.hash);
      expect(await pendingIds(a.orgId)).toEqual([]);
      expect(await createAuditLedgerRepository(executor).page(a, null, 100)).toEqual([
        expect.objectContaining({ kind: 'chain_reset', reasonCode: 'tamper_detected' }),
      ]);
      expect(
        await executor.all({
          sql: 'SELECT head_hash, restore_pending FROM audit_chain WHERE org_id = ?',
          params: [a.orgId],
        }),
      ).toEqual([{ head_hash: after[2]?.hash, restore_pending: 0 }]);
    },
  );

  it('repairs a matching retained anchor without a tamper reset', async () => {
    const { a } = orgs();
    await addPending(a.orgId, 1, 3);
    const repo = createAuditSealRepository(executor);
    await repo.seal(a);
    const before = await events(a.orgId);
    await executor.batch([
      {
        sql: 'UPDATE audit_chain SET head_seq = 1, head_hash = ?, journal_rows = 1, journal_bytes = 1 WHERE org_id = ?',
        params: [before[0]!.hash, a.orgId],
      },
    ]);
    expect(await repo.seal(a)).toEqual({ outcome: 'empty', repaired: true });
    expect(await events(a.orgId)).toEqual(before);
    expect(
      await executor.all({
        sql: 'SELECT head_seq, head_hash, journal_rows FROM audit_chain WHERE org_id = ?',
        params: [a.orgId],
      }),
    ).toEqual([{ head_seq: 3, head_hash: before[2]!.hash, journal_rows: 3 }]);
  });

  it.each([false, true])(
    'records and repairs a mismatching first retained prev_hash with stale head %s',
    async (stale) => {
      const { a } = orgs();
      await addPending(a.orgId, 1, 2);
      const repo = createAuditSealRepository(executor);
      await repo.seal(a);
      await executor.batch([
        {
          sql: 'UPDATE audit_event SET prev_hash = ? WHERE org_id = ? AND seq = 1',
          params: ['f'.repeat(64), a.orgId],
        },
        ...(stale
          ? [
              {
                sql: 'UPDATE audit_chain SET head_seq = 0, head_hash = ? WHERE org_id = ?',
                params: [AUDIT_GENESIS_HASH, a.orgId],
              },
            ]
          : []),
      ]);
      await addPending(a.orgId, 3, 1);
      expect(await repo.seal(a)).toMatchObject({
        outcome: 'sealed',
        headSeq: 3,
        integrity: ['boundary_mismatch'],
      });
      expect(await pendingIds(a.orgId)).toEqual([]);
      expect(await createAuditLedgerRepository(executor).page(a, null, 100)).toEqual([
        expect.objectContaining({ kind: 'chain_reset', reasonCode: 'tamper_detected' }),
      ]);
      expect(
        await executor.all({
          sql: 'SELECT boundary_prev_hash FROM audit_chain WHERE org_id = ?',
          params: [a.orgId],
        }),
      ).toEqual([{ boundary_prev_hash: 'f'.repeat(64) }]);
    },
  );

  it.each([0, 2])('recovers an inconsistent empty journal boundary: %s', async (boundary) => {
    const { a } = orgs();
    // Losing every retained row keeps the head and records a gap; a boundary ahead of the head is reset.
    if (boundary === 0) {
      await addPending(a.orgId, 1, 1);
      await createAuditSealRepository(executor).seal(a);
      await executor.batch([
        { sql: 'DELETE FROM audit_event WHERE org_id = ?', params: [a.orgId] },
      ]);
    } else
      await executor.batch([
        { sql: 'UPDATE audit_chain SET boundary_seq = 2 WHERE org_id = ?', params: [a.orgId] },
      ]);
    await addPending(a.orgId, 2, 1);
    expect(await createAuditSealRepository(executor).seal(a)).toMatchObject({
      outcome: 'sealed',
      headSeq: boundary === 0 ? 2 : 1,
    });
    expect(await pendingIds(a.orgId)).toEqual([]);
    const ledger = await createAuditLedgerRepository(executor).page(a, null, 100);
    expect(ledger).toEqual([
      boundary === 0
        ? expect.objectContaining({ kind: 'gap', fromSeq: 1, toSeq: 1, count: 1 })
        : expect.objectContaining({
            kind: 'chain_reset',
            reasonCode: 'tamper_detected',
            fromSeq: 1,
            toSeq: 1,
          }),
    ]);
    expect(
      await executor.all({
        sql: 'SELECT boundary_seq, boundary_reason FROM audit_chain WHERE org_id = ?',
        params: [a.orgId],
      }),
    ).toEqual([
      boundary === 0
        ? { boundary_seq: 1, boundary_reason: null }
        : { boundary_seq: 1, boundary_reason: 'chain_reset' },
    ]);
  });

  it('recounts counter-only stale state and avoids full recounts on ordinary seals', async () => {
    const { a } = orgs();
    await addPending(a.orgId, 1, 2);
    const reads: Statement[] = [];
    const batches: Statement[][] = [];
    const repo = createAuditSealRepository({
      ...executor,
      batch: (statements) => {
        batches.push([...statements]);
        return executor.batch(statements);
      },
      all: (statement) => {
        reads.push(statement);
        return executor.all(statement);
      },
    });
    await repo.seal(a);
    await repo.seal(a);
    expect(reads.some((statement) => statement.sql.includes('count(*)'))).toBe(false);
    expect(batches[0]?.[0]?.sql).not.toMatch(/count\(|sum\(/);
    const deletion = batches[0]?.find((statement) => statement.sql.startsWith('DELETE'));
    expect(deletion).toBeDefined();
    const plan = await executor.all<{ detail: string }>({
      sql: `EXPLAIN QUERY PLAN ${deletion!.sql}`,
      params: deletion!.params,
    });
    expect(plan.some((row) => /SEARCH audit_pending .*\([^)]*id=\?[^)]*\)/.test(row.detail))).toBe(
      true,
    );
    await executor.batch([
      {
        sql: 'UPDATE audit_chain SET journal_rows = 0, journal_bytes = 0 WHERE org_id = ?',
        params: [a.orgId],
      },
    ]);
    expect(await repo.seal(a)).toEqual({ outcome: 'empty', repaired: true });
    expect(reads.filter((statement) => statement.sql.includes('count(*)'))).toHaveLength(1);
    expect(
      await executor.all({
        sql: 'SELECT journal_rows FROM audit_chain WHERE org_id = ?',
        params: [a.orgId],
      }),
    ).toEqual([{ journal_rows: 2 }]);
  });

  it('records an internal backfilled sequence hole once across repeated passes and keeps sealing', async () => {
    const { a } = orgs();
    await addPending(a.orgId, 1, 5);
    const repo = createAuditSealRepository(executor);
    await repo.seal(a);
    await executor.batch([
      { sql: 'DELETE FROM audit_event WHERE org_id = ? AND seq IN (3, 4)', params: [a.orgId] },
      { sql: 'UPDATE audit_chain SET journal_rows = 3 WHERE org_id = ?', params: [a.orgId] },
    ]);
    await addPending(a.orgId, 6, 1);
    expect(await repo.seal(a)).toMatchObject({
      outcome: 'sealed',
      headSeq: 6,
      integrity: ['seq_gap'],
    });
    const ledger = createAuditLedgerRepository(executor);
    const gaps = await ledger.effectiveGaps(a);
    expect(gaps).toEqual([
      expect.objectContaining({
        kind: 'gap',
        fromSeq: 3,
        toSeq: 4,
        count: 2,
        reasonCode: 'seq_gap',
      }),
    ]);
    await repo.seal(a);
    await addPending(a.orgId, 7, 1);
    expect(await createAuditSealRepository(executor).seal(a)).toMatchObject({
      outcome: 'sealed',
      headSeq: 7,
    });
    expect(await ledger.effectiveGaps(a)).toEqual(gaps);
    expect(await ledger.page(a, null, 100)).toEqual(gaps);
    expect(await pendingIds(a.orgId)).toEqual([]);
  });

  it.each(['first', 'last', 'all'] as const)(
    'records missing %s retained rows and keeps sealing',
    async (missing) => {
      const { a } = orgs();
      await addPending(a.orgId, 1, 3);
      await createAuditSealRepository(executor).seal(a);
      const original = await events(a.orgId);
      const deleted = missing === 'first' ? [1] : missing === 'last' ? [3] : [1, 2, 3];
      await executor.batch([
        {
          sql: 'DELETE FROM audit_event WHERE org_id = ? AND seq IN (SELECT value FROM json_each(?))',
          params: [a.orgId, JSON.stringify(deleted)],
        },
      ]);
      const sealed = await events(a.orgId);
      const [stored] = await executor.all<{ head_seq: number; head_hash: string }>({
        sql: 'SELECT head_seq, head_hash FROM audit_chain WHERE org_id = ?',
        params: [a.orgId],
      });
      expect(stored).toEqual({ head_seq: 3, head_hash: original[2]?.hash });
      await addPending(a.orgId, 4, 1);
      const repo = createAuditSealRepository(executor);
      expect(await repo.seal(a)).toMatchObject({
        outcome: 'sealed',
        sealed: 1,
        headSeq: 4,
        integrity: ['seq_gap'],
      });
      const after = await events(a.orgId);
      expect(after.map((row) => row.seq)).toEqual([...sealed.map((row) => row.seq), 4]);
      expect(after.at(-1)?.prev_hash).toBe(stored?.head_hash);
      const ledger = createAuditLedgerRepository(executor);
      const evidence = await ledger.page(a, null, 100);
      expect(evidence).toEqual([
        expect.objectContaining({
          kind: 'gap',
          fromSeq: deleted[0],
          toSeq: deleted.at(-1),
          count: deleted.length,
        }),
      ]);
      expect(
        await executor.all({
          sql: 'SELECT head_seq, boundary_seq, boundary_reason, journal_rows FROM audit_chain WHERE org_id = ?',
          params: [a.orgId],
        }),
      ).toEqual([
        { head_seq: 4, boundary_seq: 1, boundary_reason: null, journal_rows: 4 - deleted.length },
      ]);
      await addPending(a.orgId, 5, 1);
      expect(await repo.seal(a)).toEqual(
        expect.objectContaining({ outcome: 'sealed', headSeq: 5 }),
      );
      expect(await repo.seal(a)).toEqual({ outcome: 'empty' });
      expect(await ledger.page(a, null, 100)).toEqual(evidence);
      expect(await pendingIds(a.orgId)).toEqual([]);
    },
  );

  it('extends an already recorded hole without reporting its range twice', async () => {
    const { a } = orgs();
    await addPending(a.orgId, 1, 5);
    const repo = createAuditSealRepository(executor);
    await repo.seal(a);
    await executor.batch([
      { sql: 'DELETE FROM audit_event WHERE org_id = ? AND seq IN (3, 4)', params: [a.orgId] },
      { sql: 'UPDATE audit_chain SET journal_rows = 3 WHERE org_id = ?', params: [a.orgId] },
    ]);
    await repo.seal(a);
    await executor.batch([
      { sql: 'DELETE FROM audit_event WHERE org_id = ? AND seq = 2', params: [a.orgId] },
      { sql: 'UPDATE audit_chain SET journal_rows = 2 WHERE org_id = ?', params: [a.orgId] },
    ]);
    await repo.seal(a);
    await repo.seal(a);
    expect(await createAuditLedgerRepository(executor).effectiveGaps(a)).toEqual([
      expect.objectContaining({ fromSeq: 2, toSeq: 4, count: 3 }),
    ]);
    expect(
      await executor.all({
        sql: 'SELECT count(*) AS n FROM audit_ledger WHERE org_id = ?',
        params: [a.orgId],
      }),
    ).toEqual([{ n: 2 }]);
  });

  it('a competing recovery of an unchanged head records a hole only once', async () => {
    const { a } = orgs();
    await addPending(a.orgId, 1, 3);
    const winner = createAuditSealRepository(executor);
    await winner.seal(a);
    await executor.batch([
      { sql: 'DELETE FROM audit_event WHERE org_id = ? AND seq = 2', params: [a.orgId] },
      { sql: 'UPDATE audit_chain SET journal_rows = 2 WHERE org_id = ?', params: [a.orgId] },
    ]);
    let raced = false;
    const racing: SqlExecutor = {
      ...executor,
      all: (s) => executor.all(s),
      batch: async (statements) => {
        if (!raced) {
          raced = true;
          await winner.seal(a);
        }
        return executor.batch(statements);
      },
    };
    expect(await createAuditSealRepository(racing).seal(a)).toEqual({ outcome: 'contended' });
    expect(
      await executor.all({
        sql: 'SELECT count(*) AS n FROM audit_ledger WHERE org_id = ?',
        params: [a.orgId],
      }),
    ).toEqual([{ n: 1 }]);
    await winner.seal(a);
    expect(await createAuditLedgerRepository(executor).effectiveGaps(a)).toEqual([
      expect.objectContaining({ fromSeq: 2, toSeq: 2, count: 1 }),
    ]);
  });

  it('rolls back head recovery when its atomic ledger append fails', async () => {
    const { a } = orgs();
    await addPending(a.orgId, 1, 1);
    await createAuditSealRepository(executor).seal(a);
    await executor.batch([
      {
        sql: 'UPDATE audit_chain SET head_hash = ? WHERE org_id = ?',
        params: ['f'.repeat(64), a.orgId],
      },
    ]);
    await addPending(a.orgId, 2, 1);
    const failing: SqlExecutor = {
      ...executor,
      all: (s) => executor.all(s),
      batch: (statements) =>
        executor.batch([
          ...statements,
          { sql: 'UPDATE audit_pending SET action = NULL WHERE org_id = ?', params: [a.orgId] },
        ]),
    };
    await expect(createAuditSealRepository(failing).seal(a)).rejects.toMatchObject({
      kind: 'not_null',
    });
    expect(
      await executor.all({
        sql: 'SELECT head_hash FROM audit_chain WHERE org_id = ?',
        params: [a.orgId],
      }),
    ).toEqual([{ head_hash: 'f'.repeat(64) }]);
    expect(await createAuditLedgerRepository(executor).page(a, null, 100)).toEqual([]);
    expect(await pendingIds(a.orgId)).toEqual([pendingId(2)]);
  });

  it.each([false, true])(
    'keeps gap recovery within D1 limits with interrupted recovery %s',
    async (interrupt) => {
      const { a } = orgs();
      await addPending(a.orgId, 1, 100);
      await addPending(a.orgId, 101, 100);
      await addPending(a.orgId, 201, 1);
      const repo = createAuditSealRepository(executor);
      await repo.seal(a);
      await repo.seal(a);
      await repo.seal(a);
      await executor.batch([
        { sql: 'DELETE FROM audit_event WHERE org_id = ? AND seq % 2 = 0', params: [a.orgId] },
        { sql: 'UPDATE audit_chain SET journal_rows = 101 WHERE org_id = ?', params: [a.orgId] },
      ]);
      await addPending(a.orgId, 202, 100);
      const batches: (readonly Statement[])[] = [];
      const recording: SqlExecutor = {
        ...executor,
        all: (s) => executor.all(s),
        batch: (statements) => {
          batches.push(statements);
          if (interrupt && batches.length === 2) throw new DbError('busy', 'recovery interrupted');
          return executor.batch(statements);
        },
      };
      await expect(createAuditSealRepository(recording).seal(a)).resolves.toMatchObject({
        outcome: 'recovering',
        integrity: ['seq_gap'],
      });
      if (interrupt) {
        await expect(createAuditSealRepository(recording).seal(a)).rejects.toMatchObject({
          kind: 'busy',
        });
        expect(await createAuditLedgerRepository(executor).effectiveGaps(a)).toHaveLength(97);
        expect(await pendingIds(a.orgId)).toHaveLength(100);
      }
      expect(await createAuditSealRepository(recording).seal(a)).toMatchObject({
        outcome: 'sealed',
        sealed: 100,
        headSeq: 301,
      });
      expect(batches.map((batch) => batch.length)).toEqual(
        interrupt ? [196, 8, 8, 105] : [196, 8, 105],
      );
      expect(
        Math.max(...batches.flatMap((batch) => batch.map((statement) => statement.params.length))),
      ).toBe(29);
      expect(await createAuditLedgerRepository(executor).effectiveGaps(a)).toHaveLength(100);
      expect(await pendingIds(a.orgId)).toEqual([]);
    },
  );

  it('keeps recovery within 200 statements with 98 gaps, a reset and a capacity budget', async () => {
    const { a } = orgs();
    await addPending(a.orgId, 1, 100);
    await addPending(a.orgId, 101, 97);
    const repository = createAuditSealRepository(executor);
    await repository.seal(a);
    await repository.seal(a);
    await executor.batch([
      { sql: 'DELETE FROM audit_event WHERE org_id = ? AND seq % 2 = 0', params: [a.orgId] },
      {
        sql: 'UPDATE audit_chain SET boundary_prev_hash = ? WHERE org_id = ?',
        params: ['e'.repeat(64), a.orgId],
      },
    ]);
    const sizes: number[] = [];
    const recording: SqlExecutor = {
      ...executor,
      all: (statement) => executor.all(statement),
      batch: (statements) => {
        sizes.push(statements.length);
        expect(statements.length).toBeLessThanOrEqual(200);
        return executor.batch(statements);
      },
    };
    await expect(
      createAuditSealRepository(recording, { maxJournalBytes: 1_000_000 }).seal(a),
    ).resolves.toMatchObject({
      outcome: 'recovering',
      repaired: true,
      integrity: ['boundary_mismatch', 'seq_gap'],
    });
    await expect(
      createAuditSealRepository(recording, { maxJournalBytes: 1_000_000 }).seal(a),
    ).resolves.toMatchObject({ outcome: 'empty', integrity: ['seq_gap'] });
    expect(sizes).toEqual([198, 5, 1]);
    const entries = await createAuditLedgerRepository(executor).page(a, null, 500);
    expect(entries.filter((entry) => entry.kind === 'gap')).toHaveLength(98);
    expect(entries.filter((entry) => entry.kind === 'chain_reset')).toHaveLength(1);
  });

  it('writes the reset with the first boundary rewrite and resumes an interrupted recovery with gaps only', async () => {
    const { a } = orgs();
    await addPending(a.orgId, 1, 100);
    await addPending(a.orgId, 101, 100);
    await addPending(a.orgId, 201, 1);
    const repo = createAuditSealRepository(executor);
    await repo.seal(a);
    await repo.seal(a);
    await repo.seal(a);
    await executor.batch([
      { sql: 'DELETE FROM audit_event WHERE org_id = ? AND seq % 2 = 0', params: [a.orgId] },
      {
        sql: 'UPDATE audit_chain SET journal_rows = 101, boundary_prev_hash = ? WHERE org_id = ?',
        params: ['e'.repeat(64), a.orgId],
      },
    ]);
    const batches: number[] = [];
    const interrupted: SqlExecutor = {
      ...executor,
      all: (s) => executor.all(s),
      batch: (statements) => {
        batches.push(statements.length);
        if (batches.length === 2) throw new DbError('busy', 'recovery interrupted');
        return executor.batch(statements);
      },
    };
    await expect(createAuditSealRepository(interrupted).seal(a)).resolves.toMatchObject({
      outcome: 'recovering',
      integrity: ['boundary_mismatch', 'seq_gap'],
    });
    await expect(createAuditSealRepository(interrupted).seal(a)).rejects.toMatchObject({
      kind: 'busy',
    });
    expect(batches).toEqual([197, 8]);
    const ledger = createAuditLedgerRepository(executor);
    const first = await ledger.page(a, null, 500);
    expect(first.filter((entry) => entry.kind === 'chain_reset')).toEqual([
      expect.objectContaining({ reasonCode: 'tamper_detected', fromSeq: 1, toSeq: 201 }),
    ]);
    expect(first.filter((entry) => entry.kind === 'gap')).toHaveLength(97);
    expect(
      await executor.all({
        sql: 'SELECT head_seq, boundary_seq, boundary_prev_hash, boundary_reason FROM audit_chain WHERE org_id = ?',
        params: [a.orgId],
      }),
    ).toEqual([
      {
        head_seq: 201,
        boundary_seq: 1,
        boundary_prev_hash: AUDIT_GENESIS_HASH,
        boundary_reason: 'chain_reset',
      },
    ]);
    expect(await repo.seal(a)).toEqual({
      outcome: 'empty',
      repaired: true,
      integrity: ['seq_gap'],
    });
    const entries = await ledger.page(a, null, 500);
    expect(entries.filter((entry) => entry.kind === 'chain_reset')).toHaveLength(1);
    expect(await ledger.effectiveGaps(a)).toHaveLength(100);
    expect((await ledger.effectiveGaps(a)).reduce((total, entry) => total + entry.count, 0)).toBe(
      100,
    );
    expect(await repo.seal(a)).toEqual({ outcome: 'empty' });
  });

  it('keeps the normal path cheap after a recorded hole', async () => {
    const { a } = orgs();
    await addPending(a.orgId, 1, 5);
    const repo = createAuditSealRepository(executor);
    await repo.seal(a);
    await executor.batch([
      { sql: 'DELETE FROM audit_event WHERE org_id = ? AND seq IN (2, 3)', params: [a.orgId] },
      { sql: 'DELETE FROM audit_event WHERE org_id = ? AND seq = 5', params: [a.orgId] },
      { sql: 'UPDATE audit_chain SET journal_rows = 3 WHERE org_id = ?', params: [a.orgId] },
    ]);
    expect(await repo.seal(a)).toEqual({
      outcome: 'empty',
      repaired: true,
      integrity: ['seq_gap'],
    });
    const reads: string[] = [];
    const batches: Statement[][] = [];
    const watched = createAuditSealRepository({
      ...executor,
      all: (statement) => {
        reads.push(statement.sql);
        return executor.all(statement);
      },
      batch: (statements) => {
        batches.push([...statements]);
        return executor.batch(statements);
      },
    });
    expect(await watched.seal(a)).toEqual({ outcome: 'empty' });
    await addPending(a.orgId, 6, 1);
    expect(await watched.seal(a)).toEqual({
      outcome: 'sealed',
      sealed: 1,
      headSeq: 6,
      headHash: expect.any(String),
    });
    expect(await watched.seal(a)).toEqual({ outcome: 'empty' });
    expect(reads.some((sql) => sql.includes('count(*)') || sql.includes('lag('))).toBe(false);
    expect(batches).toHaveLength(1);
    expect(
      batches[0]?.some((statement) => statement.sql.includes('INSERT INTO audit_ledger')),
    ).toBe(false);
    expect(await createAuditLedgerRepository(executor).effectiveGaps(a)).toEqual([
      expect.objectContaining({ fromSeq: 2, toSeq: 3, count: 2 }),
      expect.objectContaining({ fromSeq: 5, toSeq: 5, count: 1 }),
    ]);
  });

  it('refuses to seal or record evidence while a restore is pending', async () => {
    const { a, b } = orgs();
    await addPending(a.orgId, 1, 3);
    await createAuditSealRepository(executor).seal(a);
    await executor.batch([
      { sql: 'DELETE FROM audit_event WHERE org_id = ? AND seq = 3', params: [a.orgId] },
      { sql: 'UPDATE audit_chain SET restore_pending = 1 WHERE org_id = ?', params: [a.orgId] },
    ]);
    await addPending(a.orgId, 4, 1);
    const before = await executor.all({
      sql: 'SELECT * FROM audit_chain WHERE org_id = ?',
      params: [a.orgId],
    });
    expect(await createAuditSealRepository(executor).seal(a)).toEqual({
      outcome: 'restore_pending',
    });
    expect(await pendingIds(a.orgId)).toEqual([pendingId(4)]);
    expect(await createAuditLedgerRepository(executor).page(a, null, 100)).toEqual([]);
    expect(
      await executor.all({ sql: 'SELECT * FROM audit_chain WHERE org_id = ?', params: [a.orgId] }),
    ).toEqual(before);
    await addPending(b.orgId, 5, 1);
    expect(await createAuditSealRepository(executor).seal(b)).toMatchObject({ outcome: 'sealed' });
  });

  it('a restore flag raised after the read still stops recovery and sealing', async () => {
    const { a } = orgs();
    await addPending(a.orgId, 1, 3);
    await createAuditSealRepository(executor).seal(a);
    await executor.batch([
      { sql: 'DELETE FROM audit_event WHERE org_id = ? AND seq = 3', params: [a.orgId] },
    ]);
    await addPending(a.orgId, 4, 1);
    let raised = false;
    const racing: SqlExecutor = {
      ...executor,
      all: (s) => executor.all(s),
      batch: async (statements) => {
        if (!raised) {
          raised = true;
          await executor.batch([
            {
              sql: 'UPDATE audit_chain SET restore_pending = 1 WHERE org_id = ?',
              params: [a.orgId],
            },
          ]);
        }
        return executor.batch(statements);
      },
    };
    expect(await createAuditSealRepository(racing).seal(a)).toEqual({ outcome: 'contended' });
    expect(await createAuditLedgerRepository(executor).page(a, null, 100)).toEqual([]);
    expect(await pendingIds(a.orgId)).toEqual([pendingId(4)]);
  });

  it('does not seal past a hole the ledger refuses to record', async () => {
    const { a } = orgs();
    await addPending(a.orgId, 1, 6);
    await createAuditSealRepository(executor).seal(a);
    const [chain] = await executor.all<{ chain_id: string; head_hash: string }>({
      sql: 'SELECT chain_id, head_hash FROM audit_chain WHERE org_id = ?',
      params: [a.orgId],
    });
    await executor.batch([
      ...[
        ['01K7R5V0000000000000000001', 2],
        ['01K7R5V0000000000000000002', 3],
      ].map(([id, from]) => ({
        sql: `INSERT INTO audit_ledger (org_id, id, kind, chain_id, epoch, from_seq, to_seq, count, sink_id,
          reason_code, policy, mode_generation, actor_type, actor_id, created_at)
          VALUES (?, ?, 'gap', ?, 0, ?, 3, 1, NULL, 'seq_gap', 'availability', 0, 'system', NULL, '2026-10-28T10:00:00.000Z')`,
        params: [a.orgId, id!, chain!.chain_id, from!],
      })),
      { sql: 'DELETE FROM audit_event WHERE org_id = ? AND seq = 5', params: [a.orgId] },
      { sql: 'UPDATE audit_chain SET journal_rows = 5 WHERE org_id = ?', params: [a.orgId] },
    ]);
    await addPending(a.orgId, 7, 1);
    await expect(createAuditSealRepository(executor).seal(a)).rejects.toBeInstanceOf(
      AuditLedgerIntegrityError,
    );
    expect(await pendingIds(a.orgId)).toEqual([pendingId(7)]);
    expect(
      await executor.all({
        sql: 'SELECT head_seq, head_hash, journal_rows FROM audit_chain WHERE org_id = ?',
        params: [a.orgId],
      }),
    ).toEqual([{ head_seq: 6, head_hash: chain!.head_hash, journal_rows: 5 }]);
    expect(
      await executor.all({
        sql: 'SELECT count(*) AS n FROM audit_ledger WHERE org_id = ?',
        params: [a.orgId],
      }),
    ).toEqual([{ n: 2 }]);
  });

  it('two sealers that observe the same pending change record one reset', async () => {
    const { a } = orgs();
    await addPending(a.orgId, 1, 2);
    let arrived = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const racing: SqlExecutor = {
      ...executor,
      all: (s) => executor.all(s),
      batch: async (statements) => {
        if (
          arrived < 2 &&
          statements.some((statement) => statement.sql.startsWith('DELETE FROM audit_pending'))
        ) {
          arrived += 1;
          if (arrived === 2) {
            await executor.batch([
              {
                sql: "UPDATE audit_pending SET payload_json = '{}' WHERE org_id = ? AND id = ?",
                params: [a.orgId, pendingId(1)],
              },
            ]);
            release();
          }
          await gate;
        }
        return executor.batch(statements);
      },
    };
    const results = await Promise.all([
      createAuditSealRepository(racing).seal(a),
      createAuditSealRepository(racing).seal(a),
    ]);
    expect(results).toContainEqual({
      outcome: 'sealed',
      sealed: 2,
      headSeq: 2,
      headHash: expect.any(String),
      integrity: ['head_mismatch'],
    });
    expect(results).toContainEqual({ outcome: 'contended' });
    expect(await createAuditLedgerRepository(executor).page(a, null, 100)).toEqual([
      expect.objectContaining({
        kind: 'chain_reset',
        reasonCode: 'tamper_detected',
        fromSeq: 1,
        toSeq: 2,
      }),
    ]);
    expect(await pendingIds(a.orgId)).toEqual([]);
  });

  it('alerts on the committed boundary tamper when a later recovery batch fails', async () => {
    const { a } = orgs();
    await addPending(a.orgId, 1, 100);
    await addPending(a.orgId, 101, 100);
    await addPending(a.orgId, 201, 1);
    const repo = createAuditSealRepository(executor);
    await repo.seal(a);
    await repo.seal(a);
    await repo.seal(a);
    await executor.batch([
      { sql: 'DELETE FROM audit_event WHERE org_id = ? AND seq % 2 = 0', params: [a.orgId] },
      {
        sql: 'UPDATE audit_chain SET journal_rows = 101, boundary_prev_hash = ? WHERE org_id = ?',
        params: ['e'.repeat(64), a.orgId],
      },
    ]);
    let batches = 0;
    const interrupted: SqlExecutor = {
      ...executor,
      all: (s) => executor.all(s),
      batch: (statements) => {
        batches += 1;
        if (batches === 2) throw new DbError('busy', 'recovery interrupted');
        return executor.batch(statements);
      },
    };
    const logs: Record<string, unknown>[] = [];
    const counters: string[] = [];
    const ctx = {
      org: a,
      jobId: 'job-a',
      signal: new AbortController().signal,
      observability: {
        log: (record: Record<string, unknown>) => void logs.push(record),
        counter: (name: string) => void counters.push(name),
        histogram: () => {},
      },
    } as unknown as JobContext;
    await expect(
      auditSealJob(createAuditSealRepository(interrupted)).handler({}, ctx),
    ).rejects.toMatchObject({ kind: 'busy' });
    expect(logs).toEqual([
      { level: 'error', event: 'audit.chain_integrity', reason: 'boundary_mismatch' },
      { level: 'error', event: 'audit.chain_integrity', reason: 'seq_gap' },
      { level: 'warn', event: 'audit.seal_repaired' },
    ]);
    expect(counters.filter((name) => name === 'pb.audit.chain_integrity')).toHaveLength(2);
  });

  it('a delayed reset of an already recorded change is refused after newer incidents', async () => {
    const { a } = orgs();
    await addPending(a.orgId, 1, 1);
    const isDelete = (statements: readonly Statement[]) =>
      statements.some((statement) => statement.sql.startsWith('DELETE FROM audit_pending'));
    const isReset = (statements: readonly Statement[]) =>
      statements.some((statement) => statement.sql.includes('integrity_incidents + 1'));
    const tamper = (payload: string) =>
      executor.batch([
        {
          sql: 'UPDATE audit_pending SET payload_json = ? WHERE org_id = ?',
          params: [payload, a.orgId],
        },
      ]);
    let arrived = 0;
    let releaseFirst = () => {};
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let releaseDelayed = () => {};
    const delayed = new Promise<void>((resolve) => {
      releaseDelayed = resolve;
    });
    let delayedSettled = () => {};
    const settled = new Promise<void>((resolve) => {
      delayedSettled = resolve;
    });
    let aDeletes = 0;
    const racer = (name: 'a' | 'b'): SqlExecutor => ({
      ...executor,
      all: (s) => executor.all(s),
      batch: async (statements) => {
        if (isDelete(statements)) {
          if (name === 'a') aDeletes += 1;
          if (name === 'b' || aDeletes === 1) {
            arrived += 1;
            if (arrived === 2) {
              await tamper('{"k":1}');
              releaseFirst();
            }
            await first;
          } else if (aDeletes === 2) await tamper('{"k":2}');
          else {
            releaseDelayed();
            await settled;
          }
        }
        if (name === 'b' && isReset(statements)) {
          await delayed;
          try {
            return await executor.batch(statements);
          } finally {
            delayedSettled();
          }
        }
        return executor.batch(statements);
      },
    });
    const [winner, delayedResult] = await Promise.all([
      createAuditSealRepository(racer('a')).seal(a),
      createAuditSealRepository(racer('b')).seal(a),
    ]);
    expect(winner).toMatchObject({
      outcome: 'sealed',
      sealed: 1,
      integrity: ['head_mismatch', 'head_mismatch'],
    });
    expect(delayedResult).toEqual({ outcome: 'contended' });
    const ledger = await createAuditLedgerRepository(executor).page(a, null, 100);
    expect(ledger.filter((entry) => entry.kind === 'chain_reset')).toHaveLength(2);
    expect(
      await executor.all({
        sql: 'SELECT integrity_incidents FROM audit_chain WHERE org_id = ?',
        params: [a.orgId],
      }),
    ).toEqual([{ integrity_incidents: 2 }]);
    expect(await pendingIds(a.orgId)).toEqual([]);
  });

  it('sealers with overlapping snapshots record one reset for one change', async () => {
    const { a } = orgs();
    await addPending(a.orgId, 1, 2);
    let arrived = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const racing: SqlExecutor = {
      ...executor,
      all: (s) => executor.all(s),
      batch: async (statements) => {
        if (
          arrived < 2 &&
          statements.some((statement) => statement.sql.startsWith('DELETE FROM audit_pending'))
        ) {
          arrived += 1;
          if (arrived === 2) {
            await executor.batch([
              {
                sql: "UPDATE audit_pending SET payload_json = '{}' WHERE org_id = ? AND id = ?",
                params: [a.orgId, pendingId(1)],
              },
            ]);
            release();
          }
          await gate;
        }
        return executor.batch(statements);
      },
    };
    const results = await Promise.all([
      createAuditSealRepository(racing).seal(a, 1),
      createAuditSealRepository(racing).seal(a, 100),
    ]);
    expect(results).toContainEqual({ outcome: 'contended' });
    expect(results).toContainEqual(
      expect.objectContaining({ outcome: 'sealed', integrity: ['head_mismatch'] }),
    );
    expect(await createAuditSealRepository(executor).seal(a)).not.toHaveProperty('integrity');
    expect(await pendingIds(a.orgId)).toEqual([]);
    const ledger = await createAuditLedgerRepository(executor).page(a, null, 100);
    expect(ledger).toEqual([expect.objectContaining({ kind: 'chain_reset', fromSeq: 1 })]);
    expect(
      await executor.all({
        sql: 'SELECT integrity_incidents FROM audit_chain WHERE org_id = ?',
        params: [a.orgId],
      }),
    ).toEqual([{ integrity_incidents: 1 }]);
  });

  it('never allocates a seq inside a recorded gap after the stored head rolls back', async () => {
    const { a } = orgs();
    await addPending(a.orgId, 1, 3);
    const repo = createAuditSealRepository(executor);
    await repo.seal(a);
    const original = await events(a.orgId);
    await executor.batch([
      { sql: 'DELETE FROM audit_event WHERE org_id = ? AND seq = 3', params: [a.orgId] },
    ]);
    expect(await repo.seal(a)).toEqual({
      outcome: 'empty',
      repaired: true,
      integrity: ['seq_gap'],
    });
    await executor.batch([
      {
        sql: 'UPDATE audit_chain SET head_seq = 2, head_hash = ? WHERE org_id = ?',
        params: [original[1]!.hash, a.orgId],
      },
    ]);
    await addPending(a.orgId, 4, 1);
    expect(await repo.seal(a)).toEqual({
      outcome: 'sealed',
      sealed: 1,
      headSeq: 4,
      headHash: expect.any(String),
      repaired: true,
      integrity: ['head_mismatch'],
    });
    const after = await events(a.orgId);
    expect(after.map((row) => row.seq)).toEqual([1, 2, 4]);
    expect(after[2]?.prev_hash).toBe(original[1]?.hash);
    const ledger = await createAuditLedgerRepository(executor).page(a, null, 100);
    expect(ledger).toEqual([
      expect.objectContaining({ kind: 'gap', fromSeq: 3, toSeq: 3, count: 1 }),
      expect.objectContaining({ kind: 'chain_reset', reasonCode: 'tamper_detected' }),
    ]);
    expect(await repo.seal(a)).toEqual({ outcome: 'empty' });
  });

  it.each(['low first', 'high first'] as const)(
    'two sealers with independent id clocks record one reset for the same change: %s',
    async (order) => {
      const { a } = orgs();
      await addPending(a.orgId, 1, 2);
      const clock = (prefix: string) => {
        let n = 0;
        return () => {
          n += 1;
          return prefix + String(n).padStart(26 - prefix.length, '0');
        };
      };
      const [first, second] =
        order === 'low first' ? [clock('01K0'), clock('7ZZZ')] : [clock('7ZZZ'), clock('01K0')];
      let arrived = 0;
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const racing: SqlExecutor = {
        ...executor,
        all: (s) => executor.all(s),
        batch: async (statements) => {
          if (
            arrived < 2 &&
            statements.some((statement) => statement.sql.startsWith('DELETE FROM audit_pending'))
          ) {
            arrived += 1;
            if (arrived === 2) {
              await executor.batch([
                {
                  sql: "UPDATE audit_pending SET payload_json = '{}' WHERE org_id = ? AND id = ?",
                  params: [a.orgId, pendingId(1)],
                },
              ]);
              release();
            }
            await gate;
          }
          return executor.batch(statements);
        },
      };
      const results = await Promise.all([
        createAuditSealRepository(racing, { ids: first }).seal(a),
        createAuditSealRepository(racing, { ids: second }).seal(a),
      ]);
      expect(results).toContainEqual(
        expect.objectContaining({ outcome: 'sealed', sealed: 2, integrity: ['head_mismatch'] }),
      );
      expect(results).toContainEqual({ outcome: 'contended' });
      expect(await createAuditLedgerRepository(executor).page(a, null, 100)).toEqual([
        expect.objectContaining({ kind: 'chain_reset', fromSeq: 1, toSeq: 2 }),
      ]);
      expect(
        await executor.all({
          sql: 'SELECT integrity_incidents FROM audit_chain WHERE org_id = ?',
          params: [a.orgId],
        }),
      ).toEqual([{ integrity_incidents: 1 }]);
    },
  );

  it('records a later incident that observes the same rows at the same seq again', async () => {
    const { a } = orgs();
    await addPending(a.orgId, 1, 1);
    let reads = 0;
    let deletes = 0;
    const tampering: SqlExecutor = {
      ...executor,
      all: async (statement) => {
        if (statement.sql.includes('FROM audit_pending WHERE org_id = ? ORDER BY id')) {
          reads += 1;
          if (reads === 2)
            await executor.batch([
              {
                sql: `UPDATE audit_pending SET payload_json = '{"x":1}' WHERE org_id = ?`,
                params: [a.orgId],
              },
            ]);
        }
        return executor.all(statement);
      },
      batch: async (statements) => {
        if (
          deletes < 2 &&
          statements.some((statement) => statement.sql.startsWith('DELETE FROM audit_pending'))
        ) {
          deletes += 1;
          await executor.batch([
            {
              sql: `UPDATE audit_pending SET payload_json = '{"same":true}' WHERE org_id = ?`,
              params: [a.orgId],
            },
          ]);
        }
        return executor.batch(statements);
      },
    };
    expect(await createAuditSealRepository(tampering).seal(a)).toMatchObject({
      outcome: 'sealed',
      sealed: 1,
      integrity: ['head_mismatch', 'head_mismatch'],
    });
    const resets = await createAuditLedgerRepository(executor).page(a, null, 100);
    expect(resets).toEqual([
      expect.objectContaining({ kind: 'chain_reset', fromSeq: 1, toSeq: 1 }),
      expect.objectContaining({ kind: 'chain_reset', fromSeq: 1, toSeq: 1 }),
    ]);
    expect((await events(a.orgId))[0]?.payload_json).toBe('{"same":true}');
  });

  it('answers contended if pruning races the repair recount', async () => {
    const { a } = orgs();
    await addPending(a.orgId, 1, 2);
    await createAuditSealRepository(executor).seal(a);
    await executor.batch([
      { sql: 'UPDATE audit_chain SET journal_rows = 0 WHERE org_id = ?', params: [a.orgId] },
    ]);
    await addPending(a.orgId, 3, 1);
    let raced = false;
    const racing: SqlExecutor = {
      ...executor,
      all: async (statement) => {
        if (!raced && statement.sql.startsWith('SELECT count(*)')) {
          raced = true;
          await executor.batch([
            { sql: 'DELETE FROM audit_event WHERE org_id = ?', params: [a.orgId] },
            {
              sql: "UPDATE audit_chain SET boundary_seq = 3, boundary_prev_hash = head_hash, boundary_reason = 'prune', journal_bytes = 0 WHERE org_id = ?",
              params: [a.orgId],
            },
          ]);
        }
        return executor.all(statement);
      },
    };
    expect(await createAuditSealRepository(racing).seal(a)).toEqual({ outcome: 'contended' });
    expect(await pendingIds(a.orgId)).toEqual([pendingId(3)]);
    expect(
      await executor.all({
        sql: 'SELECT restore_pending FROM audit_chain WHERE org_id = ?',
        params: [a.orgId],
      }),
    ).toEqual([{ restore_pending: 0 }]);
  });

  it.each([false, true])(
    'aborts a stale sealer after pruning with changed pending set %s',
    async (changePending) => {
      const { a } = orgs();
      await addPending(a.orgId, 1, 2);
      await createAuditSealRepository(executor).seal(a);
      await addPending(a.orgId, 3, 2);
      let raced = false;
      const racing: SqlExecutor = {
        ...executor,
        all: (s) => executor.all(s),
        batch: async (statements) => {
          if (!raced) {
            raced = true;
            await executor.batch([
              { sql: 'DELETE FROM audit_event WHERE org_id = ?', params: [a.orgId] },
              {
                sql: "UPDATE audit_chain SET boundary_seq = 3, boundary_prev_hash = head_hash, boundary_reason = 'prune', journal_rows = 0, journal_bytes = 0 WHERE org_id = ?",
                params: [a.orgId],
              },
            ]);
            if (changePending)
              await executor.batch([
                {
                  sql: 'DELETE FROM audit_pending WHERE org_id = ? AND id = ?',
                  params: [a.orgId, pendingId(3)],
                },
              ]);
          }
          return executor.batch(statements);
        },
      };
      expect(await createAuditSealRepository(racing).seal(a)).toEqual({ outcome: 'contended' });
      expect(await events(a.orgId)).toEqual([]);
      expect(await pendingIds(a.orgId)).toEqual(
        changePending ? [pendingId(4)] : [pendingId(3), pendingId(4)],
      );
      expect(await createAuditSealRepository(executor).seal(a)).toMatchObject({
        outcome: 'sealed',
        headSeq: changePending ? 3 : 4,
      });
    },
  );

  it.each(['delete', 'modify'])('handles a changed pending snapshot: %s', async (change) => {
    const { a } = orgs();
    await addPending(a.orgId, 1, 2);
    const racing: SqlExecutor = {
      ...executor,
      all: (s) => executor.all(s),
      batch: async (statements) => {
        await executor.batch([
          {
            sql:
              change === 'delete'
                ? 'DELETE FROM audit_pending WHERE org_id = ? AND id = ?'
                : "UPDATE audit_pending SET payload_json = '{}' WHERE org_id = ? AND id = ?",
            params: [a.orgId, pendingId(1)],
          },
        ]);
        return executor.batch(statements);
      },
    };
    const result = createAuditSealRepository(racing).seal(a);
    if (change === 'modify') {
      expect(await result).toMatchObject({
        outcome: 'sealed',
        sealed: 2,
        integrity: ['head_mismatch'],
      });
      expect(await pendingIds(a.orgId)).toEqual([]);
      const sealed = await events(a.orgId);
      expect(sealed[0]?.payload_json).toBe('{}');
      expect(await verifyChain(sealed)).toBeNull();
      expect(await createAuditLedgerRepository(executor).page(a, null, 100)).toEqual([
        expect.objectContaining({ kind: 'chain_reset', reasonCode: 'tamper_detected' }),
      ]);
    } else {
      expect(await result).toEqual({ outcome: 'contended' });
      expect(await pendingIds(a.orgId)).toEqual([pendingId(2)]);
      expect(await events(a.orgId)).toEqual([]);
      expect(
        await executor.all({
          sql: 'SELECT head_seq, journal_rows, journal_bytes FROM audit_chain WHERE org_id = ?',
          params: [a.orgId],
        }),
      ).toEqual([{ head_seq: 0, journal_rows: 0, journal_bytes: 0 }]);
    }
  });

  it('bounds retries during continuous pending tampering and seals on a later stable pass', async () => {
    const { a } = orgs();
    await addPending(a.orgId, 1, 1);
    let changes = 0;
    const racing: SqlExecutor = {
      ...executor,
      all: (s) => executor.all(s),
      batch: async (statements) => {
        if (statements.some((statement) => statement.sql.startsWith('DELETE FROM audit_pending'))) {
          changes += 1;
          await executor.batch([
            {
              sql: 'UPDATE audit_pending SET payload_json = ? WHERE org_id = ?',
              params: [JSON.stringify({ changes }), a.orgId],
            },
          ]);
        }
        return executor.batch(statements);
      },
    };
    expect(await createAuditSealRepository(racing).seal(a)).toMatchObject({
      outcome: 'contended',
      integrity: ['head_mismatch', 'head_mismatch', 'head_mismatch'],
    });
    expect(changes).toBe(3);
    expect(await createAuditLedgerRepository(executor).page(a, null, 100)).toHaveLength(3);
    expect(await pendingIds(a.orgId)).toEqual([pendingId(1)]);
    expect(await createAuditSealRepository(executor).seal(a)).toMatchObject({
      outcome: 'sealed',
      sealed: 1,
    });
  });

  it('persists recovery evidence across repository instances and isolates it by organization', async () => {
    const { a, b } = orgs();
    await addPending(a.orgId, 1, 1);
    let raced = false;
    const racing: SqlExecutor = {
      ...executor,
      all: (statement) => executor.all(statement),
      batch: async (statements) => {
        if (!raced) {
          raced = true;
          await executor.batch([
            {
              sql: "UPDATE audit_pending SET payload_json = '{}' WHERE org_id = ?",
              params: [a.orgId],
            },
          ]);
        }
        return executor.batch(statements);
      },
    };
    expect(await createAuditSealRepository(racing).seal(a)).toMatchObject({
      outcome: 'sealed',
      headSeq: 1,
    });
    expect(await createAuditSealRepository(executor).seal(a)).toEqual({ outcome: 'empty' });
    expect(await pendingIds(a.orgId)).toEqual([]);
    expect(await events(a.orgId)).toHaveLength(1);
    const ledger = createAuditLedgerRepository(executor);
    expect(await ledger.page(a, null, 100)).toEqual([
      expect.objectContaining({ kind: 'chain_reset', reasonCode: 'tamper_detected' }),
    ]);
    expect(await ledger.page(b, null, 100)).toEqual([]);
    await addPending(b.orgId, 2, 1);
    expect(await createAuditSealRepository(executor).seal(b)).toMatchObject({
      outcome: 'sealed',
      headSeq: 1,
    });
    expect(
      await executor.all({
        sql: 'SELECT restore_pending FROM audit_chain WHERE org_id = ?',
        params: [a.orgId],
      }),
    ).toEqual([{ restore_pending: 0 }]);
  });

  it('reports pending age scoped to the organization and clamps empty and future rows to zero', async () => {
    const { a, b } = orgs();
    const repo = createAuditSealRepository(executor);
    await addPending(b.orgId, 1, 1);
    expect(await repo.pendingOldestAgeSeconds(a)).toBe(0);
    await addPending(a.orgId, 2, 1);
    await executor.batch([
      {
        sql: "UPDATE audit_pending SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-600 seconds') WHERE org_id = ?",
        params: [a.orgId],
      },
    ]);
    expect(await repo.pendingOldestAgeSeconds(a)).toBeGreaterThanOrEqual(599);
    expect(await repo.pendingOldestAgeSeconds(a)).toBeLessThan(610);
    await executor.batch([
      {
        sql: "UPDATE audit_pending SET created_at = '2999-01-01T00:00:00.000Z' WHERE org_id = ?",
        params: [a.orgId],
      },
    ]);
    expect(await repo.pendingOldestAgeSeconds(a)).toBe(0);
  });

  it('7: rejects a limit outside 1 to 100 with RangeError before touching the database', async () => {
    const { a } = orgs();
    await addPending(a.orgId, 1, 1);
    const repository = createAuditSealRepository(executor);

    for (const limit of [0, -1, 101, 1.5, Number.NaN]) {
      await expect(repository.seal(a, limit)).rejects.toBeInstanceOf(RangeError);
    }
    expect(await pendingIds(a.orgId)).toHaveLength(1);
  });

  it('8: honours a smaller limit', async () => {
    const { a } = orgs();
    await addPending(a.orgId, 1, 5);

    const outcome = await createAuditSealRepository(executor).seal(a, 2);

    expect(outcome).toMatchObject({ outcome: 'sealed', sealed: 2, headSeq: 2 });
    expect(await pendingIds(a.orgId)).toHaveLength(3);
  });

  it('9: propagates a non-chain DbError instead of answering contended', async () => {
    const { a } = orgs();
    await addPending(a.orgId, 1, 1);
    const failing: SqlExecutor = {
      ...executor,
      driver: executor.driver,
      all: (statement) => executor.all(statement),
      batch: async () => {
        throw new DbError('check', 'CHECK constraint failed: audit_event');
      },
    };

    await expect(createAuditSealRepository(failing).seal(a)).rejects.toMatchObject({
      kind: 'check',
    });
    expect(await pendingIds(a.orgId)).toHaveLength(1);
  });

  it('10: a unique violation outside audit_event propagates', async () => {
    const { a } = orgs();
    await addPending(a.orgId, 1, 1);
    const failing: SqlExecutor = {
      ...executor,
      driver: executor.driver,
      all: (statement) => executor.all(statement),
      batch: async () => {
        throw new DbError('unique', 'UNIQUE constraint failed: other.key', {
          constraint: 'other.key',
        });
      },
    };

    await expect(createAuditSealRepository(failing).seal(a)).rejects.toMatchObject({
      kind: 'unique',
    });
  });
});

it('continues a fragmented journal with at most 97 new holes per call and no early sealing', async () => {
  const { a, b } = orgs();
  const repo = createAuditSealRepository(executor);
  for (let n = 1; n <= 501; n += 100) {
    await addPending(a.orgId, n, Math.min(100, 502 - n));
    await repo.seal(a);
  }
  await executor.batch([
    { sql: 'DELETE FROM audit_event WHERE org_id = ? AND seq % 2 = 0', params: [a.orgId] },
    {
      sql: 'UPDATE audit_chain SET journal_rows = (SELECT count(*) FROM audit_event WHERE org_id = ?) WHERE org_id = ?',
      params: [a.orgId, a.orgId],
    },
  ]);
  await addPending(a.orgId, 502, 1);
  const holePages: number[] = [];
  const bounded = createAuditSealRepository({
    ...executor,
    async all<R>(statement: Statement): Promise<R[]> {
      const rows = await executor.all<R>(statement);
      if (statement.sql.includes('AS from_seq') && statement.sql.includes('audit_event')) {
        holePages.push(rows.length);
        expect(rows.length).toBeLessThanOrEqual(98);
      }
      return rows;
    },
  });
  const ledger = createAuditLedgerRepository(executor);
  for (const expected of [97, 194]) {
    await expect(bounded.seal(a)).resolves.toMatchObject({ outcome: 'recovering' });
    expect(await ledger.effectiveGaps(a)).toHaveLength(expected);
    expect(await pendingIds(a.orgId)).toHaveLength(1);
    expect(await ledger.effectiveGaps(b)).toHaveLength(0);
  }
  await expect(bounded.seal(a)).resolves.toMatchObject({
    outcome: 'sealed',
    headSeq: 502,
    sealed: 1,
  });
  expect(await ledger.effectiveGaps(a)).toHaveLength(250);
  expect(holePages).toHaveLength(3);
});

it('honours cancellation after the recovery scan and resumes without losing gaps', async () => {
  const { a } = orgs();
  await addPending(a.orgId, 1, 5);
  await createAuditSealRepository(executor).seal(a);
  await executor.batch([
    { sql: 'DELETE FROM audit_event WHERE org_id = ? AND seq = 2', params: [a.orgId] },
    { sql: 'UPDATE audit_chain SET journal_rows = 4 WHERE org_id = ?', params: [a.orgId] },
  ]);
  const abort = new AbortController();
  const interrupted: SqlExecutor = {
    ...executor,
    async all<R>(statement: Statement): Promise<R[]> {
      const rows = await executor.all<R>(statement);
      if (statement.sql.includes('actual_rows')) abort.abort();
      return rows;
    },
  };
  await expect(
    createAuditSealRepository(interrupted, { signal: abort.signal }).seal(a),
  ).resolves.toMatchObject({ outcome: 'recovering' });
  expect(await createAuditLedgerRepository(executor).effectiveGaps(a)).toHaveLength(0);
  await expect(createAuditSealRepository(executor).seal(a)).resolves.toMatchObject({
    outcome: 'empty',
    integrity: ['seq_gap'],
  });
  expect(await createAuditLedgerRepository(executor).effectiveGaps(a)).toHaveLength(1);
});

it('stops between recovery chunks when cancelled after the first commit', async () => {
  const { a } = orgs();
  const repo = createAuditSealRepository(executor);
  for (let n = 1; n <= 201; n += 100) {
    await addPending(a.orgId, n, Math.min(100, 202 - n));
    await repo.seal(a);
  }
  await executor.batch([
    { sql: 'DELETE FROM audit_event WHERE org_id = ? AND seq % 2 = 0', params: [a.orgId] },
    { sql: 'UPDATE audit_chain SET journal_rows = 101 WHERE org_id = ?', params: [a.orgId] },
  ]);
  await addPending(a.orgId, 202, 1);
  const abort = new AbortController();
  const interrupted: SqlExecutor = {
    ...executor,
    async batch(statements) {
      const result = await executor.batch(statements);
      abort.abort();
      return result;
    },
  };
  await auditSealJob(createAuditSealRepository(interrupted, { signal: abort.signal })).handler({}, {
    org: a,
    signal: abort.signal,
    observability: { log: () => {}, counter: () => {}, histogram: () => {} },
  } as unknown as JobContext);
  expect(await createAuditLedgerRepository(executor).effectiveGaps(a)).toHaveLength(97);
  expect(await pendingIds(a.orgId)).toHaveLength(1);
  await expect(repo.seal(a)).resolves.toMatchObject({ outcome: 'sealed', sealed: 1, headSeq: 202 });
  expect(await createAuditLedgerRepository(executor).effectiveGaps(a)).toHaveLength(100);
});
