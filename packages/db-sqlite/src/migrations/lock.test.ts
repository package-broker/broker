import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '@package-broker/core/db/errors';
import { openNodeSqliteExecutor, type OpenedExecutor } from '../testing/node-sqlite-executor.js';
import {
  acquireLockStatement,
  acquireMigrationLock,
  assertLockHeldStatement,
  extendLockStatement,
  MigrationLockedError,
  readLockStatement,
  releaseLockStatement,
  repairLockStatements,
} from './lock.js';

interface LockRow {
  holder: string | null;
  acquired_at: string | null;
  expires_at: string | null;
}

const EXPIRED = '2000-01-01T00:00:00.000Z';

let opened: OpenedExecutor;

beforeEach(async () => {
  opened = openNodeSqliteExecutor();
  await opened.executor.batch(repairLockStatements());
});

afterEach(async () => {
  await opened.close();
});

function rows(): Promise<LockRow[]> {
  return opened.executor.all<LockRow>({
    sql: 'SELECT holder, acquired_at, expires_at FROM migration_lock ORDER BY id',
    params: [],
  });
}

async function expectUniqueFailure(holder: string): Promise<void> {
  const error = await opened.executor.batch([assertLockHeldStatement(holder)]).catch((e) => e);
  expect(error).toBeInstanceOf(DbError);
  expect((error as DbError).kind).toBe('unique');
}

describe('fencing assertion', () => {
  it('A: fails closed when another holder owns the lock', async () => {
    await opened.executor.all(acquireLockStatement('other', 600));
    const before = await rows();

    await expectUniqueFailure('me');

    expect(await rows()).toEqual(before);
  });

  it('B and C: fails closed when the row is missing and leaves the table empty', async () => {
    await opened.executor.all({ sql: 'DELETE FROM migration_lock', params: [] });

    await expectUniqueFailure('me');

    expect(await rows()).toEqual([]);
  });

  it('D: passes for the holder of an unexpired lease', async () => {
    await opened.executor.all(acquireLockStatement('me', 600));
    const before = await rows();

    const results = await opened.executor.batch([assertLockHeldStatement('me')]);

    expect(results).toHaveLength(1);
    expect(await rows()).toEqual(before);
  });

  it('E: fails closed after another holder took over', async () => {
    await opened.executor.all(acquireLockStatement('me', 600));
    await opened.executor.all({
      sql: 'UPDATE migration_lock SET expires_at = ? WHERE id = 1',
      params: [EXPIRED],
    });
    await opened.executor.all(acquireLockStatement('other', 600));
    const before = await rows();

    await expectUniqueFailure('me');

    expect(await rows()).toEqual(before);
  });

  it('fails when the holder owns an expired lease', async () => {
    await opened.executor.all(acquireLockStatement('me', 600));
    await opened.executor.all({
      sql: 'UPDATE migration_lock SET expires_at = ? WHERE id = 1',
      params: [EXPIRED],
    });

    await expectUniqueFailure('me');
  });
});

describe('acquireMigrationLock', () => {
  it('takes a free lock with times from the database', async () => {
    await acquireMigrationLock(opened.executor, 'first', 120);

    const [row] = await rows();
    expect(row?.holder).toBe('first');
    const acquired = Date.parse(row?.acquired_at ?? '');
    const expires = Date.parse(row?.expires_at ?? '');
    expect(Number.isNaN(acquired)).toBe(false);
    expect(expires - acquired).toBeGreaterThanOrEqual(119_000);
    expect(expires - acquired).toBeLessThanOrEqual(121_000);
    expect(Math.abs(acquired - Date.now())).toBeLessThan(10_000);
  });

  it('rejects a second holder and names the first', async () => {
    await acquireMigrationLock(opened.executor, 'first', 120);
    const [row] = await rows();

    const error = await acquireMigrationLock(opened.executor, 'second', 120).catch((e) => e);

    expect(error).toBeInstanceOf(MigrationLockedError);
    expect((error as MigrationLockedError).holder).toBe('first');
    expect((error as MigrationLockedError).expiresAt).toBe(row?.expires_at);
  });

  it('lets a second holder take over after expiry', async () => {
    await acquireMigrationLock(opened.executor, 'first', 120);
    await opened.executor.all({
      sql: 'UPDATE migration_lock SET expires_at = ? WHERE id = 1',
      params: [EXPIRED],
    });

    await acquireMigrationLock(opened.executor, 'second', 120);

    expect((await rows())[0]?.holder).toBe('second');
  });

  it('reports null holder and expiry when the row is missing', async () => {
    await opened.executor.all({ sql: 'DELETE FROM migration_lock', params: [] });

    const error = await acquireMigrationLock(opened.executor, 'first', 120).catch((e) => e);

    expect(error).toBeInstanceOf(MigrationLockedError);
    expect((error as MigrationLockedError).holder).toBeNull();
    expect((error as MigrationLockedError).expiresAt).toBeNull();
  });
});

describe('extend, read and release', () => {
  it('extends only for the holder', async () => {
    await acquireMigrationLock(opened.executor, 'first', 10);
    const [before] = await rows();

    await opened.executor.all(extendLockStatement('other', 3600));
    expect((await rows())[0]).toEqual(before);

    await opened.executor.all(extendLockStatement('first', 3600));
    expect(Date.parse((await rows())[0]?.expires_at ?? '')).toBeGreaterThan(
      Date.parse(before?.expires_at ?? '') + 3_000_000,
    );
  });

  it('reads holder and expiry', async () => {
    await acquireMigrationLock(opened.executor, 'first', 10);

    const [row] = await opened.executor.all<{ holder: string; expires_at: string }>(
      readLockStatement(),
    );

    expect(row?.holder).toBe('first');
    expect(row?.expires_at).toBe((await rows())[0]?.expires_at);
  });

  it('releases only for the holder', async () => {
    await acquireMigrationLock(opened.executor, 'first', 10);

    await opened.executor.all(releaseLockStatement('other'));
    expect((await rows())[0]?.holder).toBe('first');

    await opened.executor.all(releaseLockStatement('first'));
    expect(await rows()).toEqual([{ holder: null, acquired_at: null, expires_at: null }]);
  });
});

describe('repairLockStatements', () => {
  it('creates the table and the row on an empty database', async () => {
    const fresh = openNodeSqliteExecutor();
    try {
      await fresh.executor.batch(repairLockStatements());

      const found = await fresh.executor.all({
        sql: 'SELECT id, holder, acquired_at, expires_at FROM migration_lock',
        params: [],
      });
      expect(found).toEqual([{ id: 1, holder: null, acquired_at: null, expires_at: null }]);
    } finally {
      await fresh.close();
    }
  });

  it('inserts the row into a table that lacks it', async () => {
    await opened.executor.all({ sql: 'DELETE FROM migration_lock', params: [] });

    await opened.executor.batch(repairLockStatements());

    expect(await rows()).toEqual([{ holder: null, acquired_at: null, expires_at: null }]);
  });

  it('changes nothing when run twice or on a held lock', async () => {
    await acquireMigrationLock(opened.executor, 'first', 120);
    const before = await rows();

    await opened.executor.batch(repairLockStatements());
    await opened.executor.batch(repairLockStatements());

    expect(await rows()).toEqual(before);
  });
});

describe('ttl validation', () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects %s', (ttl) => {
    expect(() => acquireLockStatement('me', ttl)).toThrow(RangeError);
    expect(() => extendLockStatement('me', ttl)).toThrow(RangeError);
  });

  it('rejects through acquireMigrationLock', async () => {
    await expect(acquireMigrationLock(opened.executor, 'me', 0)).rejects.toThrow(RangeError);
  });
});
