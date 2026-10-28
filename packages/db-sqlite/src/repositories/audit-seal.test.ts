import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AUDIT_GENESIS_HASH,
  hashRow,
  verifyChain,
  type AuditRow,
} from '@package-broker/core/audit/chain';
import { sql } from 'kysely';
import { AuditIntegrityError } from '@package-broker/core/audit/sealer';
import { assertCheck } from '../kysely.js';
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
    'refuses a mismatching head hash: %s',
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
      for (let n = 0; n < 2; n += 1)
        await expect(repo.seal(a)).rejects.toEqual(new AuditIntegrityError('head_mismatch'));
      expect(await events(a.orgId)).toEqual(before);
      expect(await pendingIds(a.orgId)).toEqual([pendingId(3)]);
      expect(
        await executor.all({
          sql: 'SELECT head_hash FROM audit_chain WHERE org_id = ?',
          params: [a.orgId],
        }),
      ).toEqual([{ head_hash: 'f'.repeat(64) }]);
    },
  );

  it('repairs an extension only when the retained anchor still matches', async () => {
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
    'refuses a mismatching first retained prev_hash with stale head %s',
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
      await expect(repo.seal(a)).rejects.toEqual(new AuditIntegrityError('boundary_mismatch'));
      expect(await pendingIds(a.orgId)).toEqual([pendingId(3)]);
    },
  );

  it.each([0, 2])('requires an empty journal boundary to equal head + 1: %s', async (boundary) => {
    const { a } = orgs();
    // A missing retained row and a boundary ahead of the head are both integrity failures.
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
    await expect(createAuditSealRepository(executor).seal(a)).rejects.toEqual(
      new AuditIntegrityError('seq_gap'),
    );
    expect(await pendingIds(a.orgId)).toEqual([pendingId(2)]);
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

  it('surfaces an internal backfilled sequence hole without consuming pending rows', async () => {
    const { a } = orgs();
    await addPending(a.orgId, 1, 5);
    const repo = createAuditSealRepository(executor);
    await repo.seal(a);
    await executor.batch([
      { sql: 'DELETE FROM audit_event WHERE org_id = ? AND seq IN (3, 4)', params: [a.orgId] },
      { sql: 'UPDATE audit_chain SET journal_rows = 3 WHERE org_id = ?', params: [a.orgId] },
    ]);
    await addPending(a.orgId, 6, 1);
    await expect(repo.seal(a)).rejects.toEqual(new AuditIntegrityError('seq_gap'));
    expect(await pendingIds(a.orgId)).toEqual([pendingId(6)]);
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

  it.each(['delete', 'modify'])('rolls back a changed pending snapshot: %s', async (change) => {
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
    if (change === 'modify')
      await expect(result).rejects.toEqual(new AuditIntegrityError('head_mismatch'));
    else expect(await result).toEqual({ outcome: 'contended' });
    expect(await pendingIds(a.orgId)).toEqual(
      change === 'modify' ? [pendingId(1), pendingId(2)] : [pendingId(2)],
    );
    expect(await events(a.orgId)).toEqual([]);
    expect(
      await executor.all({
        sql: 'SELECT head_seq, journal_rows, journal_bytes FROM audit_chain WHERE org_id = ?',
        params: [a.orgId],
      }),
    ).toEqual([{ head_seq: 0, journal_rows: 0, journal_bytes: 0 }]);
  });

  it('persists an integrity stop across repository instances and isolates it by organization', async () => {
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
    await expect(createAuditSealRepository(racing).seal(a)).rejects.toEqual(
      new AuditIntegrityError('head_mismatch'),
    );
    await expect(createAuditSealRepository(executor).seal(a)).rejects.toEqual(
      new AuditIntegrityError('head_mismatch'),
    );
    expect(await pendingIds(a.orgId)).toEqual([pendingId(1)]);
    expect(await events(a.orgId)).toEqual([]);
    await addPending(b.orgId, 2, 1);
    expect(await createAuditSealRepository(executor).seal(b)).toMatchObject({
      outcome: 'sealed',
      headSeq: 1,
    });
    // Simulate operator resolution; a sealer never clears the persisted stop.
    await executor.batch([
      { sql: 'UPDATE audit_chain SET restore_pending = 0 WHERE org_id = ?', params: [a.orgId] },
    ]);
    expect(await createAuditSealRepository(executor).seal(a)).toMatchObject({
      outcome: 'sealed',
      headSeq: 1,
    });
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
