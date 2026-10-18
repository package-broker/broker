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
import { createAuditSealRepository } from '@package-broker/db-sqlite/repositories/audit-seal';
import { discoveredMigrations } from '@package-broker/db-sqlite/testing/migrated-database';
import { createD1Executor, type D1DatabaseLike } from './d1-executor.js';

const bindings = Array.from({ length: 16 }, (_, index) => `SDB${index}`);

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

  it('3: seals 120 rows as 100 then 20 with a valid chain (101 statements in a full batch)', async () => {
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
    expect(batchSizes).toEqual([101]);
    expect(await repository.seal(a)).toMatchObject({ outcome: 'sealed', sealed: 20, headSeq: 120 });
    expect(batchSizes).toEqual([101, 21]);

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
