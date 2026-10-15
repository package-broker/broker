import { describe, expect, it } from 'vitest';
import type { ScalarSqlExecutor } from '@package-broker/core/db/port';
import { migrate, MigrationApplyError, MigrationChecksumError } from '../migrations/runner.js';
import { loadMigrationSource, type MigrationSource } from '../migrations/source.js';
import { countCalls } from './count-calls.js';
import type { OpenedExecutor } from './executor-contract.js';

export interface OpenedPair extends OpenedExecutor {
  second(): Promise<ScalarSqlExecutor>;
}

const COUNT_TABLES =
  "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'";

async function withPair(
  open: () => Promise<OpenedPair>,
  body: (pair: OpenedPair) => Promise<void>,
): Promise<void> {
  const pair = await open();
  try {
    await body(pair);
  } finally {
    await pair.close();
  }
}

async function countTables(executor: ScalarSqlExecutor): Promise<number> {
  const [row] = await executor.all<{ n: number }>({ sql: COUNT_TABLES, params: [] });
  return row?.n ?? 0;
}

async function countBookkeepingRows(executor: ScalarSqlExecutor): Promise<number> {
  const [row] = await executor.all<{ n: number }>({
    sql: 'SELECT count(*) AS n FROM schema_migration',
    params: [],
  });
  return row?.n ?? 0;
}

interface BookkeepingRecord {
  readonly id: string;
  readonly name: string;
  readonly checksum: string;
}

interface LockRecord {
  readonly id: number;
  readonly holder: string | null;
  readonly acquired_at: string | null;
  readonly expires_at: string | null;
}

async function readBookkeeping(executor: ScalarSqlExecutor): Promise<BookkeepingRecord[]> {
  return executor.all<BookkeepingRecord>({
    sql: 'SELECT id, name, checksum FROM schema_migration ORDER BY id',
    params: [],
  });
}

async function readLock(executor: ScalarSqlExecutor): Promise<LockRecord> {
  const rows = await executor.all<LockRecord>({
    sql: 'SELECT id, holder, acquired_at, expires_at FROM migration_lock',
    params: [],
  });
  expect(rows).toHaveLength(1);
  const [row] = rows;
  if (row === undefined) throw new Error('migration_lock row is missing');
  return row;
}

async function lockHolder(executor: ScalarSqlExecutor): Promise<string | null> {
  return (await readLock(executor)).holder;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

export function describeMigrationContract(
  name: string,
  open: () => Promise<OpenedPair>,
  core0001: () => Promise<MigrationSource>,
): void {
  describe(`migration contract: ${name}`, () => {
    it('1. applies the real 0001_init.sql: 37 tables, one bookkeeping row, lock free', async () => {
      await withPair(open, async ({ executor }) => {
        const init = await core0001();

        const result = await migrate(executor, [init], { holder: 'contract-1' });

        expect(result.applied).toEqual([init.id]);
        expect(await countTables(executor)).toBe(37);
        expect(await countBookkeepingRows(executor)).toBe(1);
        expect(await lockHolder(executor)).toBeNull();
      });
    });

    it('2. a rerun skips the applied source without a batch call', async () => {
      await withPair(open, async ({ executor }) => {
        const init = await core0001();
        await migrate(executor, [init], { holder: 'contract-1' });
        const counted = countCalls(executor);

        const result = await migrate(counted.executor, [init], { holder: 'contract-2' });

        expect(result.applied).toEqual([]);
        expect(result.skipped).toEqual([init.id]);
        expect(counted.counts().batch).toBe(0);
      });
    });

    it('3. an edited applied source rejects with MigrationChecksumError', async () => {
      await withPair(open, async ({ executor }) => {
        const init = await core0001();
        await migrate(executor, [init], { holder: 'contract-1' });
        const edited = await loadMigrationSource(
          'core',
          '0001_init.sql',
          `${init.sql}\n-- edited\n`,
        );

        const error = await rejection(migrate(executor, [edited], { holder: 'contract-2' }));

        expect(error).toBeInstanceOf(MigrationChecksumError);
        expect((error as MigrationChecksumError).id).toBe(init.id);
        expect((error as MigrationChecksumError).stored).toBe(init.checksum);
        expect((error as MigrationChecksumError).computed).toBe(edited.checksum);
      });
    });

    it('4. reports an applied id this build does not ship, without an error', async () => {
      await withPair(open, async ({ executor }) => {
        const init = await core0001();
        await migrate(executor, [init], { holder: 'contract-1' });
        await executor.all({
          sql: 'INSERT INTO schema_migration (id, name, checksum) VALUES (?, ?, ?)',
          params: ['legacy:0042_gone', '0042_gone', '0'.repeat(64)],
        });

        const result = await migrate(executor, [init], { holder: 'contract-2' });

        expect(result.unknown).toEqual(['legacy:0042_gone']);
        expect(result.skipped).toEqual([init.id]);
      });
    });

    it('5. a failing pending source leaves no DDL, no bookkeeping row and a free lock', async () => {
      await withPair(open, async ({ executor }) => {
        const init = await core0001();
        await migrate(executor, [init], { holder: 'contract-1' });
        const failing = await loadMigrationSource(
          'core',
          '0002_broken.sql',
          'CREATE TABLE broken (id INTEGER PRIMARY KEY);\nCREATE TABLE broken (id INTEGER PRIMARY KEY);\n',
        );

        const error = await rejection(migrate(executor, [init, failing], { holder: 'contract-2' }));

        expect(error).toBeInstanceOf(MigrationApplyError);
        expect(await countTables(executor)).toBe(37);
        expect(await countBookkeepingRows(executor)).toBe(1);
        expect(await lockHolder(executor)).toBeNull();
      });
    });

    it('6. a dry run on a fresh database writes nothing', async () => {
      await withPair(open, async ({ executor }) => {
        const init = await core0001();

        const result = await migrate(executor, [init], { holder: 'contract-1', dryRun: true });

        expect(result.pending).toEqual([init.id]);
        expect(result.applied).toEqual([]);
        expect(await countTables(executor)).toBe(0);
      });
    });

    it('7. a dry run on an initialized database leaves a pending source unwritten', async () => {
      await withPair(open, async ({ executor }) => {
        const init = await core0001();
        await migrate(executor, [init], { holder: 'contract-1' });
        const pending = await loadMigrationSource(
          'core',
          '0002_pending.sql',
          'CREATE TABLE pending_row (id INTEGER PRIMARY KEY);\n',
        );
        const bookkeepingBefore = await readBookkeeping(executor);
        const lockBefore = await readLock(executor);

        const result = await migrate(executor, [init, pending], {
          holder: 'contract-2',
          dryRun: true,
        });

        expect(result.pending).toEqual([pending.id]);
        expect(result.skipped).toEqual([init.id]);
        expect(await countTables(executor)).toBe(37);
        expect(await readBookkeeping(executor)).toEqual(bookkeepingBefore);
        expect(await readLock(executor)).toEqual(lockBefore);
      });
    });
  });
}
