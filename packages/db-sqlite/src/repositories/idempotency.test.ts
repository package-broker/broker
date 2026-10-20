import { isDeepStrictEqual } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IdempotencyRecord } from '@package-broker/core/api/idempotency';
import { DbError } from '@package-broker/core/db/errors';
import type { OrgContext, ScalarSqlExecutor } from '@package-broker/core/db/port';
import { countCalls } from '../contract/count-calls.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createIdempotencyRepository, idempotencyInsertStatement } from './idempotency.js';

const NOW = '2026-10-18T12:00:00.000Z';
const EXPIRY = '2026-10-19T12:00:00.000Z';
const AFTER = '2026-10-19T12:00:00.001Z';
const record: IdempotencyRecord = {
  principalKey: 'user:alice',
  key: 'create-project',
  route: 'POST /api/projects',
  requestHash: 'ab'.repeat(32),
  status: 201,
  responseJson: '{"id":"project-a"}',
  createdAt: NOW,
  expiresAt: EXPIRY,
};

let database: MigratedDatabase;
let executor: ScalarSqlExecutor;
let a: OrgContext;
let b: OrgContext;
let repo: ReturnType<typeof createIdempotencyRepository>;

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
  if (database.orgs === null) throw new Error('organizations were not seeded');
  ({ a, b } = database.orgs);
  executor = database.executor;
  repo = createIdempotencyRepository(executor);
});
afterEach(async () => database.close());

async function seed(ctx = a, overrides: Partial<IdempotencyRecord> = {}): Promise<void> {
  await executor.batch([idempotencyInsertStatement(ctx, { ...record, ...overrides })]);
}

async function rows(ctx = a): Promise<unknown[]> {
  return executor.all({
    sql: 'SELECT * FROM api_idempotency WHERE org_id = ?',
    params: [ctx.orgId],
  });
}

describe('idempotency repository', () => {
  it('round trips the entire record', async () => {
    await seed();
    expect(await repo.find(a, record.principalKey, record.key, NOW)).toEqual(record);
  });
  it('does not find an unknown key', async () => {
    await seed();
    expect(await repo.find(a, record.principalKey, 'unknown', NOW)).toBeNull();
  });
  it('does not find another principal key', async () => {
    await seed();
    expect(await repo.find(a, 'user:bob', record.key, NOW)).toBeNull();
  });
  it('does not find another organization record', async () => {
    await seed(b);
    expect(await repo.find(a, record.principalKey, record.key, NOW)).toBeNull();
  });
  it('rejects a duplicate with a unique DbError and preserves the first record', async () => {
    await seed();
    const duplicate = executor.batch([
      idempotencyInsertStatement(a, { ...record, responseJson: '{"id":"replacement"}' }),
    ]);
    await expect(duplicate).rejects.toBeInstanceOf(DbError);
    await expect(duplicate).rejects.toMatchObject({ kind: 'unique' });
    expect(await repo.find(a, record.principalKey, record.key, NOW)).toEqual(record);
  });
  it('allows the same key for another principal', async () => {
    await seed();
    await seed(a, { principalKey: 'user:bob' });
    expect(await rows()).toHaveLength(2);
  });
  it('allows the same principal and key in another organization', async () => {
    await seed();
    await seed(b);
    expect(await repo.find(b, record.principalKey, record.key, NOW)).toEqual(record);
  });
  it('ignores an expired row without deleting it', async () => {
    await seed();
    expect(await repo.find(a, record.principalKey, record.key, AFTER)).toBeNull();
    expect(await rows()).toHaveLength(1);
    expect(await repo.purgeExpired(a, AFTER, 1)).toBe(1);
    expect(await rows()).toHaveLength(0);
  });
  it('treats the exact expiry instant as expired', async () => {
    await seed();
    expect(await repo.find(a, record.principalKey, record.key, EXPIRY)).toBeNull();
    expect(await repo.purgeExpired(a, EXPIRY, 1)).toBe(1);
  });
  it('purges at most the limit and preserves foreign and unexpired rows', async () => {
    for (const key of ['one', 'two', 'three']) await seed(a, { key });
    await seed(a, { key: 'live', expiresAt: '2026-10-20T12:00:00.000Z' });
    await seed(b);
    const foreign = await rows(b);
    expect(await repo.purgeExpired(a, AFTER, 2)).toBe(2);
    expect(await rows()).toHaveLength(2);
    expect(await rows(b)).toEqual(foreign);
    expect(await repo.find(a, record.principalKey, 'live', AFTER)).not.toBeNull();
    expect(await repo.purgeExpired(a, AFTER, 500)).toBe(1);
    expect(await repo.purgeExpired(a, AFTER, 500)).toBe(0);
  });
  it('rolls back the idempotency record when an effect statement fails', async () => {
    await expect(
      executor.batch([
        idempotencyInsertStatement(a, record),
        { sql: 'INSERT INTO api_idempotency (org_id) VALUES (?)', params: [a.orgId] },
      ]),
    ).rejects.toBeInstanceOf(DbError);
    expect(await rows()).toHaveLength(0);
  });
  it('rolls back other effects when a duplicate idempotency insert fails', async () => {
    await seed();
    await expect(
      executor.batch([
        idempotencyInsertStatement(a, { ...record, key: 'effect' }),
        idempotencyInsertStatement(a, record),
      ]),
    ).rejects.toMatchObject({ kind: 'unique' });
    expect(await rows()).toHaveLength(1);
  });
  it('uses the expiry index in a single bounded delete batch', async () => {
    const seen: string[] = [];
    const captured: ScalarSqlExecutor = {
      driver: executor.driver,
      all: (statement) => executor.all(statement),
      batch: (statements) => {
        seen.push(...statements.map(({ sql }) => sql));
        expect(statements).toHaveLength(1);
        expect(statements[0]?.params.length).toBeLessThanOrEqual(100);
        return executor.batch(statements);
      },
    };
    await createIdempotencyRepository(captured).purgeExpired(a, AFTER, 2);
    expect(seen).toHaveLength(1);
    const plan = await executor.all<{ detail: string }>({
      sql: `EXPLAIN QUERY PLAN ${seen[0]}`,
      params: [a.orgId, a.orgId, AFTER, 2],
    });
    expect(plan.some(({ detail }) => detail.includes('api_idempotency_expiry'))).toBe(true);
  });
});

describe('expired key replacement', () => {
  const later = { createdAt: AFTER, expiresAt: '2026-10-20T12:00:00.001Z' };
  const replacement = { ...record, ...later, responseJson: '{"id":"replacement"}' };

  it('replaces an expired row with the new record', async () => {
    await seed();
    await executor.batch([idempotencyInsertStatement(a, replacement)]);
    expect(await rows()).toHaveLength(1);
    expect(await repo.find(a, record.principalKey, record.key, AFTER)).toEqual(replacement);
  });
  it('replaces a row that expires at the exact creation instant', async () => {
    await seed();
    await executor.batch([
      idempotencyInsertStatement(a, {
        ...replacement,
        createdAt: EXPIRY,
        expiresAt: later.expiresAt,
      }),
    ]);
    expect(await repo.find(a, record.principalKey, record.key, EXPIRY)).toMatchObject({
      responseJson: replacement.responseJson,
    });
  });
  it('never takes over a row that is still live at the creation instant', async () => {
    await seed();
    const createdAt = '2026-10-19T11:59:59.999Z';
    const attempt = executor.batch([
      idempotencyInsertStatement(a, { ...replacement, createdAt, expiresAt: later.expiresAt }),
    ]);
    await expect(attempt).rejects.toBeInstanceOf(DbError);
    await expect(attempt).rejects.toMatchObject({ kind: 'unique' });
    expect(await repo.find(a, record.principalKey, record.key, NOW)).toEqual(record);
  });
  it('keeps the live record when a live key is inserted again with another hash', async () => {
    await seed();
    const attempt = executor.batch([
      idempotencyInsertStatement(a, { ...record, requestHash: 'cd'.repeat(32) }),
    ]);
    await expect(attempt).rejects.toMatchObject({ kind: 'unique' });
    expect(await repo.find(a, record.principalKey, record.key, NOW)).toEqual(record);
  });
  it('leaves other keys, principals and organizations untouched', async () => {
    await seed();
    await seed(a, { key: 'other-key' });
    await seed(a, { principalKey: 'user:bob' });
    await seed(b);
    const before = [await rows(a), await rows(b)];
    await executor.batch([idempotencyInsertStatement(a, replacement)]);
    const [afterA, afterB] = [await rows(a), await rows(b)];
    expect(afterB).toEqual(before[1]);
    expect(afterA).toHaveLength(3);
    expect(
      afterA.filter((row) => !before[0]?.some((old) => isDeepStrictEqual(old, row))),
    ).toHaveLength(1);
  });
  it('lets exactly one of two concurrent inserts replace an expired row', async () => {
    await seed();
    const settled = await Promise.allSettled([
      executor.batch([idempotencyInsertStatement(a, replacement)]),
      executor.batch([
        idempotencyInsertStatement(a, { ...replacement, responseJson: '{"id":"second"}' }),
      ]),
    ]);
    expect(settled.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await rows()).toHaveLength(1);
  });
  it('rolls back the replacement with the rest of the batch', async () => {
    await seed();
    const original = await rows();
    await expect(
      executor.batch([
        idempotencyInsertStatement(a, replacement),
        { sql: 'INSERT INTO api_idempotency (org_id) VALUES (?)', params: [a.orgId] },
      ]),
    ).rejects.toBeInstanceOf(DbError);
    expect(await rows()).toEqual(original);
  });
  it('replaces an expired row when the insert runs only after a changing statement', async () => {
    await seed();
    await executor.batch([
      { sql: 'UPDATE organization SET id = id WHERE id = ?', params: [a.orgId] },
      idempotencyInsertStatement(a, replacement, true),
    ]);
    expect(await repo.find(a, record.principalKey, record.key, AFTER)).toEqual(replacement);
  });
  it.each([
    ['holds', true],
    ['fails', false],
  ])('replaces an expired row only when the extra condition %s', async (_name, holds) => {
    await seed();
    await executor.batch([
      idempotencyInsertStatement(a, replacement, false, {
        sql: 'exists (select 1 from organization where id = ? and ?)',
        params: [a.orgId, holds ? 1 : 0],
      }),
    ]);
    expect(await repo.find(a, record.principalKey, record.key, AFTER)).toEqual(
      holds ? replacement : null,
    );
    expect(await rows()).toHaveLength(1);
  });
  it('inserts nothing when the preceding statement changed nothing', async () => {
    await seed();
    await executor.batch([
      { sql: 'UPDATE organization SET id = id WHERE id = ?', params: ['missing'] },
      idempotencyInsertStatement(a, replacement, true),
    ]);
    expect(await repo.find(a, record.principalKey, record.key, AFTER)).toBeNull();
    expect(await rows()).toEqual([expect.objectContaining({ response_json: record.responseJson })]);
  });
});

describe('validation before SQL', () => {
  it.each<[string, Partial<IdempotencyRecord>]>([
    ['63-character hash', { requestHash: 'a'.repeat(63) }],
    ['uppercase hash', { requestHash: 'AB'.repeat(32) }],
    ['hash with trailing newline', { requestHash: 'a'.repeat(64) + '\n' }],
    ['status 99', { status: 99 }],
    ['status 600', { status: 600 }],
    ['fractional status', { status: 200.5 }],
    ['malformed JSON', { responseJson: '{' }],
    ['expiry without Z', { expiresAt: EXPIRY.slice(0, -1) }],
    ['invalid creation date', { createdAt: '2026-02-30T12:00:00.000Z' }],
    ['empty key', { key: '' }],
    ['overlong key', { key: 'a'.repeat(129) }],
    ['overlong non-BMP key', { key: '😀'.repeat(129) }],
    ['NUL key', { key: '\u0000' }],
    ['embedded NUL key', { key: 'before\u0000after' }],
    ['empty principal key', { principalKey: '' }],
    ['principal key without a kind', { principalKey: 'alice' }],
    ['overlong principal key', { principalKey: 'a'.repeat(81) }],
    ['overlong non-BMP principal key', { principalKey: '😀'.repeat(81) }],
    ['NUL principal key', { principalKey: '\u0000' }],
    ['embedded NUL principal key', { principalKey: 'before\u0000after' }],
  ])('rejects %s', (_name, patch) => {
    const counted = countCalls(executor);
    expect(() => idempotencyInsertStatement(a, { ...record, ...patch })).toThrow(TypeError);
    expect(counted.counts()).toEqual({ all: 0, batch: 0 });
  });
  it.each([
    ['', record.key, NOW],
    ['alice', record.key, NOW],
    ['a'.repeat(81), record.key, NOW],
    ['😀'.repeat(81), record.key, NOW],
    ['\u0000', record.key, NOW],
    ['before\u0000after', record.key, NOW],
    [record.principalKey, '', NOW],
    [record.principalKey, 'a'.repeat(129), NOW],
    [record.principalKey, '😀'.repeat(129), NOW],
    [record.principalKey, '\u0000', NOW],
    [record.principalKey, 'before\u0000after', NOW],
    [record.principalKey, record.key, NOW.slice(0, -1)],
  ])('rejects invalid find arguments (%j, %j, %j)', async (principal, key, now) => {
    const counted = countCalls(executor);
    await expect(
      createIdempotencyRepository(counted.executor).find(a, principal, key, now),
    ).rejects.toBeInstanceOf(TypeError);
    expect(counted.counts()).toEqual({ all: 0, batch: 0 });
  });
  it.each([0, 501, 1.5, NaN, Infinity])('rejects invalid purge limit %j', async (limit) => {
    const counted = countCalls(executor);
    await expect(
      createIdempotencyRepository(counted.executor).purgeExpired(a, AFTER, limit),
    ).rejects.toBeInstanceOf(TypeError);
    expect(counted.counts()).toEqual({ all: 0, batch: 0 });
  });
  it('rejects invalid purge time before SQL', async () => {
    const counted = countCalls(executor);
    await expect(
      createIdempotencyRepository(counted.executor).purgeExpired(a, 'invalid', 1),
    ).rejects.toBeInstanceOf(TypeError);
    expect(counted.counts()).toEqual({ all: 0, batch: 0 });
  });
  it.each([100, 599])('accepts status boundary %i and maximum key lengths', async (status) => {
    const value = { ...record, status, key: 'k'.repeat(128), principalKey: `${'p'.repeat(78)}:x` };
    await executor.batch([idempotencyInsertStatement(a, value)]);
    expect(await repo.find(a, value.principalKey, value.key, NOW)).toEqual(value);
  });
  it('round trips maximum code point lengths with non-BMP keys', async () => {
    const value = { ...record, key: '😀'.repeat(128), principalKey: `${'😀'.repeat(79)}:` };
    await executor.batch([idempotencyInsertStatement(a, value)]);
    expect(await repo.find(a, value.principalKey, value.key, NOW)).toEqual(value);
  });
});
