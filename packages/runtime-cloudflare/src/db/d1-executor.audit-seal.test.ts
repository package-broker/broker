import { afterAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import {
  AUDIT_GENESIS_HASH,
  hashRow,
  verifyChain,
  type AuditRow,
} from '@package-broker/core/audit/chain';
import type { SqlExecutor, Statement } from '@package-broker/core/db/port';
import { seedTwoOrganizations } from '@package-broker/db-sqlite/contract/two-organizations';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { createAuditLedgerRepository } from '@package-broker/db-sqlite/repositories/audit-ledger';
import { createAuditSealRepository } from '@package-broker/db-sqlite/repositories/audit-seal';
import { discoveredMigrations } from '@package-broker/db-sqlite/testing/migrated-database';
import { createD1Executor, type D1DatabaseLike } from './d1-executor.js';

const bindings = Array.from({ length: 32 }, (_, index) => `SDB${index}`);

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-10-01',
    d1Databases: bindings,
  } as Parameters<typeof convertV4MiniflareOptions>[0]),
);
let next = 0;

afterAll(async () => {
  await mf.dispose();
});

async function open() {
  const binding = bindings[next];
  next += 1;
  if (binding === undefined) throw new Error('out of D1 bindings');
  const db = (await mf.getD1Database(binding)) as unknown as D1DatabaseLike;
  const executor = createD1Executor(db);
  await migrate(executor, await discoveredMigrations(), { holder: 'audit-seal-test' });
  const orgs = await seedTwoOrganizations(executor);
  return { executor, ...orgs };
}

function pendingId(n: number): string {
  return `01J0PENDING${String(n).padStart(15, '0')}`;
}

async function addPending(executor: SqlExecutor, orgId: string, from: number, count: number) {
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
  for (let i = 0; i < statements.length; i += 50) {
    await executor.batch(statements.slice(i, i + 50));
  }
}

async function events(executor: SqlExecutor, orgId: string): Promise<AuditRow[]> {
  return executor.all<AuditRow>({
    sql: 'SELECT * FROM audit_event WHERE org_id = ? ORDER BY seq',
    params: [orgId],
  });
}

async function pendingIds(executor: SqlExecutor, orgId: string): Promise<string[]> {
  const rows = await executor.all<{ id: string }>({
    sql: 'SELECT id FROM audit_pending WHERE org_id = ? ORDER BY id',
    params: [orgId],
  });
  return rows.map((row) => row.id);
}

describe('audit seal on Miniflare D1', () => {
  it('1: seals three pending rows into a chain from genesis', async () => {
    const { executor, a } = await open();
    await addPending(executor, a.orgId, 1, 3);

    const outcome = await createAuditSealRepository(executor).seal(a);

    const rows = await events(executor, a.orgId);
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(rows[0]?.prev_hash).toBe(AUDIT_GENESIS_HASH);
    expect(rows[1]?.prev_hash).toBe(rows[0]?.hash);
    for (const row of rows) expect(row.hash).toBe(await hashRow(row.prev_hash, row));
    expect(await pendingIds(executor, a.orgId)).toEqual([]);
    expect(outcome).toEqual({ outcome: 'sealed', sealed: 3, headSeq: 3, headHash: rows[2]?.hash });
  });

  it('2: answers empty when nothing is pending', async () => {
    const { executor, a } = await open();

    expect(await createAuditSealRepository(executor).seal(a)).toEqual({ outcome: 'empty' });
    expect(await events(executor, a.orgId)).toEqual([]);
  });

  it('3: seals 120 rows as 100 then 20 with a valid chain (105 statements in a full batch)', async () => {
    const { executor, a } = await open();
    await addPending(executor, a.orgId, 1, 120);
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

    expect(await repository.seal(a)).toMatchObject({
      outcome: 'sealed',
      sealed: 100,
      headSeq: 100,
    });
    expect(batchSizes).toEqual([105]);
    expect(await repository.seal(a)).toMatchObject({ outcome: 'sealed', sealed: 20, headSeq: 120 });
    expect(batchSizes).toEqual([105, 25]);

    const rows = await events(executor, a.orgId);
    expect(rows.map((row) => row.seq)).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
    expect(await verifyChain(rows)).toBeNull();
  }, 60_000);

  it('4: a second sealer built from the same head answers contended and changes nothing', async () => {
    const { executor, a } = await open();
    await addPending(executor, a.orgId, 1, 3);
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

    expect(await createAuditSealRepository(racing).seal(a)).toEqual({ outcome: 'contended' });

    const rows = await events(executor, a.orgId);
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(await verifyChain(rows)).toBeNull();
    expect(await pendingIds(executor, a.orgId)).toEqual([]);
  });

  it('4b: a contended batch leaves the pending rows that the loser had read in place', async () => {
    const { executor, a } = await open();
    await addPending(executor, a.orgId, 1, 2);
    let raced = false;
    const racing: SqlExecutor = {
      ...executor,
      driver: executor.driver,
      all: (statement) => executor.all(statement),
      batch: async (statements) => {
        if (!raced) {
          raced = true;
          await addPending(executor, a.orgId, 3, 1);
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
    expect(await pendingIds(executor, a.orgId)).toEqual([pendingId(1), pendingId(2), pendingId(3)]);
    expect((await events(executor, a.orgId)).map((row) => row.id)).toEqual(['foreign-event']);
  });

  it('4c: already sealed pending ids with a current head contend on the primary key only', async () => {
    const { executor, a } = await open();
    await addPending(executor, a.orgId, 2, 1);
    await createAuditSealRepository(executor).seal(a);
    const before = await events(executor, a.orgId);
    await addPending(executor, a.orgId, 1, 2);
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
    expect(await pendingIds(executor, a.orgId)).toEqual([pendingId(1), pendingId(2)]);
    expect(await events(executor, a.orgId)).toEqual(before);
  });

  it('5: does not seal or delete pending rows of another organization', async () => {
    const { executor, a, b } = await open();
    await addPending(executor, a.orgId, 1, 2);
    await addPending(executor, b.orgId, 3, 2);

    await createAuditSealRepository(executor).seal(a);

    expect(await pendingIds(executor, b.orgId)).toEqual([pendingId(3), pendingId(4)]);
    expect(await events(executor, b.orgId)).toEqual([]);
    expect((await events(executor, a.orgId)).map((row) => row.id)).toEqual([
      pendingId(1),
      pendingId(2),
    ]);
  });

  it('6: source_ip changes keep the chain valid', async () => {
    const { executor, a } = await open();
    await addPending(executor, a.orgId, 1, 2);
    await createAuditSealRepository(executor).seal(a);

    expect((await events(executor, a.orgId)).map((row) => row.source_ip)).toEqual([
      '203.0.113.7',
      '203.0.113.7',
    ]);
    await executor.batch([
      {
        sql: "UPDATE audit_event SET source_ip = '198.51.100.9' WHERE org_id = ?",
        params: [a.orgId],
      },
    ]);
    expect(await verifyChain(await events(executor, a.orgId))).toBeNull();
  });

  it('6b: action changes break the hash', async () => {
    const { executor, a } = await open();
    await addPending(executor, a.orgId, 1, 2);
    await createAuditSealRepository(executor).seal(a);

    await executor.batch([
      {
        sql: "UPDATE audit_event SET action = 'package.delete' WHERE org_id = ? AND seq = 2",
        params: [a.orgId],
      },
    ]);
    expect(await verifyChain(await events(executor, a.orgId))).toEqual({ seq: 2, reason: 'hash' });
  });

  it('records an internal hole once across repeated passes and continues sealing', async () => {
    const { executor, a } = await open();
    await addPending(executor, a.orgId, 1, 5);
    const repo = createAuditSealRepository(executor);
    await repo.seal(a);
    await executor.batch([
      { sql: 'DELETE FROM audit_event WHERE org_id = ? AND seq IN (3, 4)', params: [a.orgId] },
      { sql: 'UPDATE audit_chain SET journal_rows = 3 WHERE org_id = ?', params: [a.orgId] },
    ]);
    await addPending(executor, a.orgId, 6, 1);
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
    await addPending(executor, a.orgId, 7, 1);
    expect(await createAuditSealRepository(executor).seal(a)).toMatchObject({
      outcome: 'sealed',
      headSeq: 7,
    });
    expect(await ledger.page(a, null, 100)).toEqual(gaps);
    expect(await pendingIds(executor, a.orgId)).toEqual([]);
  });

  it.each(['head', 'boundary'] as const)(
    'records %s tampering and continues sealing',
    async (kind) => {
      const { executor, a, b } = await open();
      await addPending(executor, a.orgId, 1, 2);
      const repo = createAuditSealRepository(executor);
      await repo.seal(a);
      const before = await events(executor, a.orgId);
      await executor.batch([
        {
          sql:
            kind === 'head'
              ? 'UPDATE audit_chain SET head_hash = ? WHERE org_id = ?'
              : 'UPDATE audit_chain SET boundary_prev_hash = ? WHERE org_id = ?',
          params: ['f'.repeat(64), a.orgId],
        },
      ]);
      await addPending(executor, a.orgId, 3, 1);
      expect(await repo.seal(a)).toMatchObject({
        outcome: 'sealed',
        headSeq: 3,
        integrity: [kind === 'head' ? 'head_mismatch' : 'boundary_mismatch'],
      });
      const after = await events(executor, a.orgId);
      expect(after.slice(0, 2)).toEqual(before);
      expect(after[2]?.prev_hash).toBe(before[1]?.hash);
      expect(await verifyChain(after)).toBeNull();
      expect(await repo.seal(a)).toEqual({ outcome: 'empty' });
      const ledger = createAuditLedgerRepository(executor);
      expect(await ledger.page(a, null, 100)).toEqual([
        expect.objectContaining({ kind: 'chain_reset', reasonCode: 'tamper_detected' }),
      ]);
      expect(await ledger.page(b, null, 100)).toEqual([]);
    },
  );

  it('records a pending-row mismatch and seals the new snapshot', async () => {
    const { executor, a } = await open();
    await addPending(executor, a.orgId, 1, 2);
    let raced = false;
    const racing: SqlExecutor = {
      ...executor,
      all: (s) => executor.all(s),
      batch: async (statements) => {
        if (!raced) {
          raced = true;
          await executor.batch([
            {
              sql: `UPDATE audit_pending SET payload_json = '{}' WHERE org_id = ?`,
              params: [a.orgId],
            },
          ]);
        }
        return executor.batch(statements);
      },
    };
    expect(await createAuditSealRepository(racing).seal(a)).toMatchObject({
      outcome: 'sealed',
      sealed: 2,
      integrity: ['head_mismatch'],
    });
    const rows = await events(executor, a.orgId);
    expect(rows.map((row) => row.payload_json)).toEqual(['{}', '{}']);
    expect(await verifyChain(rows)).toBeNull();
    expect(await createAuditLedgerRepository(executor).page(a, null, 100)).toEqual([
      expect.objectContaining({ kind: 'chain_reset', reasonCode: 'tamper_detected' }),
    ]);
  });

  it('keeps gap recovery and full sealing within D1 statement and parameter limits', async () => {
    const { executor, a } = await open();
    await addPending(executor, a.orgId, 1, 201);
    const repo = createAuditSealRepository(executor);
    await repo.seal(a);
    await repo.seal(a);
    await repo.seal(a);
    await executor.batch([
      { sql: 'DELETE FROM audit_event WHERE org_id = ? AND seq % 2 = 0', params: [a.orgId] },
      { sql: 'UPDATE audit_chain SET journal_rows = 101 WHERE org_id = ?', params: [a.orgId] },
    ]);
    await addPending(executor, a.orgId, 202, 100);
    const batches: (readonly Statement[])[] = [];
    const recording: SqlExecutor = {
      ...executor,
      all: (s) => executor.all(s),
      batch: (statements) => {
        batches.push(statements);
        return executor.batch(statements);
      },
    };
    expect(await createAuditSealRepository(recording).seal(a)).toMatchObject({
      outcome: 'sealed',
      sealed: 100,
      headSeq: 301,
    });
    expect(batches.map((batch) => batch.length)).toEqual([196, 8, 105]);
    expect(
      Math.max(...batches.flatMap((batch) => batch.map((statement) => statement.params.length))),
    ).toBe(29);
    expect(await createAuditLedgerRepository(executor).effectiveGaps(a)).toHaveLength(100);
  }, 60_000);

  it.each(['first', 'last', 'all'] as const)(
    'records missing %s retained rows as a gap and continues after the stored head',
    async (missing) => {
      const { executor, a } = await open();
      await addPending(executor, a.orgId, 1, 3);
      await createAuditSealRepository(executor).seal(a);
      const original = await events(executor, a.orgId);
      const deleted = missing === 'first' ? [1] : missing === 'last' ? [3] : [1, 2, 3];
      await executor.batch([
        {
          sql: 'DELETE FROM audit_event WHERE org_id = ? AND seq IN (SELECT value FROM json_each(?))',
          params: [a.orgId, JSON.stringify(deleted)],
        },
      ]);
      await addPending(executor, a.orgId, 4, 1);
      const repo = createAuditSealRepository(executor);
      expect(await repo.seal(a)).toMatchObject({
        outcome: 'sealed',
        sealed: 1,
        headSeq: 4,
        integrity: ['seq_gap'],
      });
      const after = await events(executor, a.orgId);
      expect(after.at(-1)).toMatchObject({ seq: 4, prev_hash: original[2]?.hash });
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
      expect(await repo.seal(a)).toEqual({ outcome: 'empty' });
      expect(await ledger.page(a, null, 100)).toEqual(evidence);
    },
  );

  it('writes the reset with the first rewrite and resumes an interrupted recovery with gaps only', async () => {
    const { executor, a } = await open();
    await addPending(executor, a.orgId, 1, 201);
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
        if (batches.length === 2) throw new Error('recovery interrupted');
        return executor.batch(statements);
      },
    };
    await expect(createAuditSealRepository(interrupted).seal(a)).rejects.toMatchObject({
      name: 'AuditSealInterruptedError',
      integrity: ['boundary_mismatch', 'seq_gap'],
      cause: expect.objectContaining({ message: 'recovery interrupted' }),
    });
    expect(batches).toEqual([197, 8]);
    expect(await repo.seal(a)).toEqual({
      outcome: 'empty',
      repaired: true,
      integrity: ['seq_gap'],
    });
    const ledger = createAuditLedgerRepository(executor);
    expect(
      (await ledger.page(a, null, 500)).filter((entry) => entry.kind === 'chain_reset'),
    ).toHaveLength(1);
    expect(await ledger.effectiveGaps(a)).toHaveLength(100);
  }, 60_000);

  it('a second pass after a recorded hole does no journal scan and reports no repair', async () => {
    const { executor, a } = await open();
    await addPending(executor, a.orgId, 1, 5);
    const repo = createAuditSealRepository(executor);
    await repo.seal(a);
    await executor.batch([
      { sql: 'DELETE FROM audit_event WHERE org_id = ? AND seq IN (2, 3)', params: [a.orgId] },
      { sql: 'UPDATE audit_chain SET journal_rows = 3 WHERE org_id = ?', params: [a.orgId] },
    ]);
    expect(await repo.seal(a)).toEqual({
      outcome: 'empty',
      repaired: true,
      integrity: ['seq_gap'],
    });
    const reads: string[] = [];
    const watched = createAuditSealRepository({
      ...executor,
      all: (statement) => {
        reads.push(statement.sql);
        return executor.all(statement);
      },
      batch: (statements) => executor.batch(statements),
    });
    await addPending(executor, a.orgId, 6, 1);
    expect(await watched.seal(a)).toEqual({
      outcome: 'sealed',
      sealed: 1,
      headSeq: 6,
      headHash: expect.any(String),
    });
    expect(await watched.seal(a)).toEqual({ outcome: 'empty' });
    expect(reads.some((sql) => sql.includes('count(*)') || sql.includes('lag('))).toBe(false);
  });

  it.each(['low first', 'high first'] as const)(
    'two sealers with independent id clocks record one reset for the same change: %s',
    async (order) => {
      const { executor, a } = await open();
      await addPending(executor, a.orgId, 1, 2);
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
    },
  );

  it('a delayed reset of an already recorded change is refused after newer incidents', async () => {
    const { executor, a } = await open();
    await addPending(executor, a.orgId, 1, 1);
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
    expect(await pendingIds(executor, a.orgId)).toEqual([]);
  });

  it('sealers with overlapping snapshots record one reset for one change', async () => {
    const { executor, a } = await open();
    await addPending(executor, a.orgId, 1, 2);
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
    expect(await pendingIds(executor, a.orgId)).toEqual([]);
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
    const { executor, a } = await open();
    await addPending(executor, a.orgId, 1, 3);
    const repo = createAuditSealRepository(executor);
    await repo.seal(a);
    const original = await events(executor, a.orgId);
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
    await addPending(executor, a.orgId, 4, 1);
    expect(await repo.seal(a)).toMatchObject({
      outcome: 'sealed',
      headSeq: 4,
      integrity: ['head_mismatch'],
    });
    expect((await events(executor, a.orgId)).map((row) => row.seq)).toEqual([1, 2, 4]);
  });

  it('refuses to seal or record a hole while a restore is pending', async () => {
    const { executor, a } = await open();
    await addPending(executor, a.orgId, 1, 3);
    await createAuditSealRepository(executor).seal(a);
    await executor.batch([
      { sql: 'DELETE FROM audit_event WHERE org_id = ? AND seq = 3', params: [a.orgId] },
      { sql: 'UPDATE audit_chain SET restore_pending = 1 WHERE org_id = ?', params: [a.orgId] },
    ]);
    await addPending(executor, a.orgId, 4, 1);
    expect(await createAuditSealRepository(executor).seal(a)).toEqual({
      outcome: 'restore_pending',
    });
    expect(await pendingIds(executor, a.orgId)).toEqual([pendingId(4)]);
    expect(await createAuditLedgerRepository(executor).page(a, null, 100)).toEqual([]);
  });

  it('9: a non-unique D1 error propagates', async () => {
    const { executor, a } = await open();
    await addPending(executor, a.orgId, 1, 1);
    const failing: SqlExecutor = {
      ...executor,
      all: (statement) => executor.all(statement),
      batch: () =>
        executor.batch([
          {
            sql: 'UPDATE audit_pending SET action = NULL WHERE org_id = ?',
            params: [a.orgId],
          },
        ]),
    };

    await expect(createAuditSealRepository(failing).seal(a)).rejects.toMatchObject({
      kind: 'not_null',
    });
    expect(await pendingIds(executor, a.orgId)).toEqual([pendingId(1)]);
    expect(await events(executor, a.orgId)).toEqual([]);
  });

  it('10: a non-audit unique D1 error propagates', async () => {
    const { executor, a } = await open();
    await addPending(executor, a.orgId, 1, 1);
    const failing: SqlExecutor = {
      ...executor,
      all: (statement) => executor.all(statement),
      batch: () =>
        executor.batch([
          {
            sql: 'INSERT INTO audit_pending SELECT * FROM audit_pending WHERE org_id = ?',
            params: [a.orgId],
          },
        ]),
    };

    await expect(createAuditSealRepository(failing).seal(a)).rejects.toMatchObject({
      kind: 'unique',
      constraint: 'audit_pending.id',
    });
    expect(await pendingIds(executor, a.orgId)).toEqual([pendingId(1)]);
    expect(await events(executor, a.orgId)).toEqual([]);
  });
});
