import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUDIT_GENESIS_HASH } from '@package-broker/core/audit/chain';
import type { ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createAuditQueryRepository } from './audit-query.js';

let database: MigratedDatabase;
let executor: ScalarSqlExecutor;
let statements: ScalarStatement[];

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  statements = [];
  executor = {
    driver: database.executor.driver,
    all: (statement) => {
      statements.push(statement);
      return database.executor.all(statement);
    },
    batch: (batch) => database.executor.batch(batch),
  };
});

afterEach(async () => {
  await database.close();
});

function orgs() {
  if (database.orgs === null) throw new Error('organizations were not seeded');
  return database.orgs;
}

async function seed(orgId: string, count = 5): Promise<void> {
  await executor.batch(
    Array.from({ length: count }, (_, i) => ({
      sql: 'INSERT INTO audit_event (id, org_id, seq, prev_hash, hash, created_at, actor_type, actor_id, token_selector, source_ip, action, target_type, target_id, project_id, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      params: [
        `${orgId}-${i + 1}`,
        orgId,
        i + 1,
        i.toString(16).padStart(64, '0'),
        (i + 1).toString(16).padStart(64, '0'),
        '2026-10-17T10:00:00.000Z',
        'user',
        i % 2 === 0 ? 'actor-a' : 'actor-b',
        null,
        i === 4 ? null : '203.0.113.7',
        i < 3 ? 'package.publish' : 'package.publish.extra',
        'package',
        `package-${i + 1}`,
        i % 2 === 0 ? 'project-a' : 'project-b',
        '{}',
      ],
    })),
  );
}

async function pending(orgId: string, count: number): Promise<void> {
  await executor.batch(
    Array.from({ length: count }, (_, i) => ({
      sql: "INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type) VALUES (?, ?, ?, 'system', 'package.publish', 'package')",
      params: [`pending-${orgId}-${i}`, orgId, '2026-10-17T11:00:00.000Z'],
    })),
  );
}

describe('createAuditQueryRepository', () => {
  it('pages five rows as 2, 2, 1 without gaps or duplicates', async () => {
    const { a } = orgs();
    await seed(a.orgId);
    const repository = createAuditQueryRepository(executor);
    const first = await repository.list(a, { limit: 2 });
    expect(first.items.map((row) => row.seq)).toEqual([1, 2]);
    expect(first.next).toBe(`${a.orgId}-2`);
    const second = await repository.list(a, { limit: 2, afterId: first.next! });
    expect(second.items.map((row) => row.seq)).toEqual([3, 4]);
    expect(second.next).toBe(`${a.orgId}-4`);
    const third = await repository.list(a, { limit: 2, afterId: second.next! });
    expect(third.items.map((row) => row.seq)).toEqual([5]);
    expect(third.next).toBeNull();
    expect(statements).toHaveLength(3);
  });

  it.each([
    [{ projectId: 'project-a' }, [1, 3, 5]],
    [{ actor: 'actor-a' }, [1, 3, 5]],
    [{ action: 'package.publish' }, [1, 2, 3]],
    [{ projectId: 'project-a', action: 'package.publish' }, [1, 3]],
    [{ projectId: 'project-a', actor: 'actor-a', action: 'package.publish' }, [1, 3]],
  ] as const)('filters by %j', async (filter, expected) => {
    const { a } = orgs();
    await seed(a.orgId);
    const result = await createAuditQueryRepository(executor).list(a, { ...filter, limit: 200 });
    expect(result.items.map((row) => row.seq)).toEqual(expected);
    expect(result.next).toBeNull();
  });

  it('returns stored row fields including source_ip and null values', async () => {
    const { a } = orgs();
    await seed(a.orgId);
    const { items } = await createAuditQueryRepository(executor).list(a, { limit: 200 });
    expect(items).toEqual(
      await database.executor.all({
        sql: 'SELECT * FROM audit_event WHERE org_id = ? ORDER BY seq',
        params: [a.orgId],
      }),
    );
    expect(items[0]?.source_ip).toBe('203.0.113.7');
    expect(items[4]?.source_ip).toBeNull();
  });

  it.each([
    [{}, 'audit_event_seq'],
    [{ projectId: 'project-a' }, 'audit_event_project'],
    [{ actor: 'actor-a' }, 'audit_event_actor'],
    [{ action: 'package.publish' }, 'audit_event_action'],
  ] as const)('uses %s with index %s and no audit table scan', async (filter, index) => {
    const { a } = orgs();
    await seed(a.orgId);
    for (const cursor of [{}, { afterId: `${a.orgId}-1` }]) {
      await createAuditQueryRepository(executor).list(a, { ...filter, ...cursor, limit: 2 });
      const statement = statements.at(-1)!;
      expect(statement.params[0]).toBe(a.orgId);
      expect(statement.sql).toMatch(/WHERE org_id = \?/i);
      const plan = await database.executor.all<{ detail: string }>({
        ...statement,
        sql: `EXPLAIN QUERY PLAN ${statement.sql}`,
      });
      const detail = plan.map((row) => row.detail).join('\n');
      expect(detail).toMatch(new RegExp(`USING (?:COVERING )?INDEX ${index}\\b`));
      expect(detail).not.toMatch(/SCAN audit_event/);
    }
  });

  it('never returns rows of another organization', async () => {
    const { a, b } = orgs();
    await seed(a.orgId);
    await seed(b.orgId);
    const result = await createAuditQueryRepository(executor).list(a, { limit: 200 });
    expect(result.items).toHaveLength(5);
    expect(result.items.every((row) => row.org_id === a.orgId)).toBe(true);
  });

  it('returns an empty page for a foreign organization cursor', async () => {
    const { a, b } = orgs();
    await seed(a.orgId);
    await seed(b.orgId);
    expect(
      await createAuditQueryRepository(executor).list(a, { limit: 2, afterId: `${b.orgId}-1` }),
    ).toEqual({ items: [], next: null });
  });

  it('returns an empty page for an unknown cursor', async () => {
    const { a } = orgs();
    await seed(a.orgId);
    expect(
      await createAuditQueryRepository(executor).list(a, { limit: 2, afterId: 'unknown' }),
    ).toEqual({ items: [], next: null });
  });

  it.each([0, 201, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid limit %s before querying',
    async (limit) => {
      await expect(
        createAuditQueryRepository(executor).list(orgs().a, { limit }),
      ).rejects.toBeInstanceOf(RangeError);
      expect(statements).toEqual([]);
    },
  );

  it('reads the third sealed hash and counts two pending rows in one statement', async () => {
    const { a, b } = orgs();
    await seed(a.orgId, 3);
    await pending(a.orgId, 2);
    await seed(b.orgId, 5);
    await pending(b.orgId, 4);
    expect(await createAuditQueryRepository(executor).head(a)).toEqual({
      seq: 3,
      hash: '3'.padStart(64, '0'),
      pending: 2,
      lastVerifiedAt: null,
    });
    expect(statements).toHaveLength(1);
  });

  it('returns null when only the other organization has audit rows', async () => {
    const { a, b } = orgs();
    await seed(b.orgId);
    await pending(b.orgId, 2);
    expect(await createAuditQueryRepository(executor).head(a)).toBeNull();
  });

  it('returns genesis with seq zero when only pending rows exist', async () => {
    const { a } = orgs();
    await pending(a.orgId, 2);
    expect(await createAuditQueryRepository(executor).head(a)).toEqual({
      seq: 0,
      hash: AUDIT_GENESIS_HASH,
      pending: 2,
      lastVerifiedAt: null,
    });
  });
});
