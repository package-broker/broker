import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { countCalls } from '../contract/count-calls.js';
import { openNodeSqliteExecutor, type OpenedExecutor } from '../testing/node-sqlite-executor.js';
import {
  migrate,
  MigrationApplyError,
  MigrationChecksumError,
  type MigrateLogEvent,
  MigrationOrderError,
  MigrationStateError,
} from './runner.js';
import { MigrationLockedError } from './lock.js';
import type { ScalarSqlExecutor } from '@package-broker/core/db/port';
import { loadMigrationSource, MigrationSourceError, type MigrationSource } from './source.js';

const INIT_SQL = `CREATE TABLE schema_migration (
  id         TEXT NOT NULL PRIMARY KEY,
  name       TEXT NOT NULL,
  checksum   TEXT NOT NULL CHECK (length(checksum) = 64),
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT, WITHOUT ROWID;

CREATE TABLE migration_lock (
  id          INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  holder      TEXT,
  acquired_at TEXT,
  expires_at  TEXT
) STRICT;
INSERT INTO migration_lock (id) VALUES (1);

CREATE TABLE a (id INTEGER NOT NULL PRIMARY KEY) STRICT;
`;

const SECOND_SQL = 'CREATE TABLE b (id INTEGER NOT NULL PRIMARY KEY) STRICT;\n';

let opened: OpenedExecutor;
let init: MigrationSource;
let second: MigrationSource;

beforeEach(async () => {
  opened = openNodeSqliteExecutor();
  init = await loadMigrationSource('core', '0001_init.sql', INIT_SQL);
  second = await loadMigrationSource('core', '0002_b.sql', SECOND_SQL);
});

afterEach(async () => {
  await opened.close();
});

async function userTables(): Promise<string[]> {
  const rows = await opened.executor.all<{ name: string }>({
    sql: "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    params: [],
  });
  return rows.map((row) => row.name);
}

describe('migrate', () => {
  it('1: applies a fresh database in order and leaves the lock free', async () => {
    const result = await migrate(opened.executor, [init, second], { holder: 'run-1' });

    expect(result).toEqual({
      applied: ['core:0001_init', 'core:0002_b'],
      skipped: [],
      unknown: [],
      pending: [],
    });
    const rows = await opened.executor.all<{ id: string; checksum: string }>({
      sql: 'SELECT id, checksum FROM schema_migration ORDER BY id',
      params: [],
    });
    expect(rows).toEqual([
      { id: init.id, checksum: init.checksum },
      { id: second.id, checksum: second.checksum },
    ]);
    expect(await userTables()).toEqual(['a', 'b', 'migration_lock', 'schema_migration']);
    const lock = await opened.executor.all({
      sql: 'SELECT holder, acquired_at, expires_at FROM migration_lock',
      params: [],
    });
    expect(lock).toEqual([{ holder: null, acquired_at: null, expires_at: null }]);
  });

  it('2: skips applied migrations on a rerun without a batch call', async () => {
    await migrate(opened.executor, [init, second], { holder: 'run-1' });
    const counted = countCalls(opened.executor);

    const result = await migrate(counted.executor, [init, second], { holder: 'run-2' });

    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(['core:0001_init', 'core:0002_b']);
    expect(counted.counts().batch).toBe(0);
  });

  it('3: dry run on a fresh database lists everything and writes nothing', async () => {
    const result = await migrate(opened.executor, [init, second], {
      holder: 'run-1',
      dryRun: true,
    });

    expect(result.pending).toEqual(['core:0001_init', 'core:0002_b']);
    expect(result.applied).toEqual([]);
    expect(await userTables()).toEqual([]);
  });

  it('4: dry run on an initialized database lists the pending source without a batch', async () => {
    await migrate(opened.executor, [init], { holder: 'run-1' });
    const counted = countCalls(opened.executor);

    const result = await migrate(counted.executor, [init, second], {
      holder: 'run-2',
      dryRun: true,
    });

    expect(result.pending).toEqual(['core:0002_b']);
    expect(result.skipped).toEqual(['core:0001_init']);
    expect(counted.counts().batch).toBe(0);
    expect(await userTables()).not.toContain('b');
  });

  it('5: rejects an applied source whose text changed', async () => {
    await migrate(opened.executor, [init, second], { holder: 'run-1' });
    const edited = await loadMigrationSource(
      'core',
      '0002_b.sql',
      'CREATE TABLE b (id INTEGER NOT NULL PRIMARY KEY, extra TEXT) STRICT;\n',
    );

    const error = await migrate(opened.executor, [init, edited], { holder: 'run-2' }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(MigrationChecksumError);
    const checksumError = error as MigrationChecksumError;
    expect(checksumError.id).toBe('core:0002_b');
    expect(checksumError.stored).toBe(second.checksum);
    expect(checksumError.computed).toBe(edited.checksum);
  });

  it('5: rejects a hand-edited sql before any database call', async () => {
    const tampered: MigrationSource = { ...second, sql: `${SECOND_SQL}-- edited\n` };
    const counted = countCalls(opened.executor);

    await expect(migrate(counted.executor, [init, tampered], { holder: 'run-1' })).rejects.toThrow(
      MigrationSourceError,
    );
    expect(counted.counts()).toEqual({ all: 0, batch: 0 });
  });

  it('6: rejects sources that do not start with core:0001_init before any database call', async () => {
    const counted = countCalls(opened.executor);

    await expect(migrate(counted.executor, [second, init], { holder: 'run-1' })).rejects.toThrow(
      MigrationSourceError,
    );
    await expect(migrate(counted.executor, [second], { holder: 'run-1' })).rejects.toThrow(
      MigrationSourceError,
    );
    expect(counted.counts()).toEqual({ all: 0, batch: 0 });
  });

  it('7: rethrows the original error when the first migration is invalid', async () => {
    const broken = await loadMigrationSource(
      'core',
      '0001_init.sql',
      `${INIT_SQL}CREATE TABL c (id INTEGER);\n`,
    );

    const error = await migrate(opened.executor, [broken], { holder: 'run-1' }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/syntax error/i);
    expect((error as Error).message).not.toMatch(/no such table/i);
    expect(await userTables()).toEqual([]);
  });

  it('reports applied ids this build does not ship as unknown', async () => {
    await migrate(opened.executor, [init, second], { holder: 'run-1' });
    const events: string[] = [];

    const result = await migrate(opened.executor, [init], {
      holder: 'run-2',
      log: (event) => events.push(`${event.level}:${event.id ?? ''}`),
    });

    expect(result.unknown).toEqual(['core:0002_b']);
    expect(result.skipped).toEqual(['core:0001_init']);
    expect(events).toContain('warn:core:0002_b');
  });

  it('repairs a missing lock row and releases the lock after a failed migration', async () => {
    await migrate(opened.executor, [init], { holder: 'run-1' });
    await opened.executor.batch([{ sql: 'DELETE FROM migration_lock', params: [] }]);
    const failing = await loadMigrationSource('core', '0002_b.sql', 'CREATE TABL b (id INTEGER);');

    await expect(migrate(opened.executor, [init, failing], { holder: 'run-2' })).rejects.toThrow();

    const lock = await opened.executor.all({
      sql: 'SELECT holder FROM migration_lock',
      params: [],
    });
    expect(lock).toEqual([{ holder: null }]);
  });

  it('calls onBeforeApply once per pending source after the lock is held', async () => {
    const seen: string[] = [];

    await migrate(opened.executor, [init, second], {
      holder: 'run-1',
      onBeforeApply: (source) => {
        seen.push(source.id);
      },
    });

    expect(seen).toEqual(['core:0002_b']);
  });
});

function wrap(
  executor: ScalarSqlExecutor,
  hooks: {
    all?: (sql: string) => void;
    batch?: (
      sqls: string[],
      run: () => ReturnType<ScalarSqlExecutor['batch']>,
    ) => ReturnType<ScalarSqlExecutor['batch']>;
  },
): ScalarSqlExecutor {
  return {
    driver: executor.driver,
    all: async (statement) => {
      hooks.all?.(statement.sql);
      return executor.all(statement);
    },
    batch: async (statements) => {
      const run = (): ReturnType<ScalarSqlExecutor['batch']> => executor.batch(statements);
      return hooks.batch === undefined
        ? run()
        : hooks.batch(
            statements.map((s) => s.sql),
            run,
          );
    },
  };
}

describe('failure handling and lock waiting', () => {
  it('validates holder and ttl before any database call, also in dry run', async () => {
    const counted = countCalls(opened.executor);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(
        migrate(counted.executor, [init], { holder: 'h', lockTtlSeconds: bad, dryRun: true }),
      ).rejects.toThrow(RangeError);
    }
    await expect(migrate(counted.executor, [init], { holder: '' })).rejects.toThrow(TypeError);
    expect(counted.counts()).toEqual({ all: 0, batch: 0 });
  });

  it('rethrows the original error when the recovery read fails', async () => {
    const original = new Error('boom');
    let failed = false;
    const executor = wrap(opened.executor, {
      all: () => {
        if (failed) throw new Error('recovery read failed');
      },
      batch: async () => {
        failed = true;
        throw original;
      },
    });

    const error = await migrate(executor, [init], { holder: 'h' }).catch((e: unknown) => e);

    expect(error).toBe(original);
    expect((error as Error).cause).toEqual(new Error('recovery read failed'));
  });

  it('names the failing migration and keeps the original as cause', async () => {
    await migrate(opened.executor, [init], { holder: 'run-1' });
    const failing = await loadMigrationSource('core', '0002_b.sql', 'CREATE TABL b (id INTEGER);');

    const error = await migrate(opened.executor, [init, failing], { holder: 'run-2' }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(MigrationApplyError);
    expect((error as MigrationApplyError).id).toBe('core:0002_b');
    expect((error as MigrationApplyError).cause).toBeInstanceOf(Error);
  });

  it('reports a lost lease as MigrationLockedError', async () => {
    await migrate(opened.executor, [init], { holder: 'run-1' });

    const error = await migrate(opened.executor, [init, second], {
      holder: 'run-2',
      onBeforeApply: async () => {
        await opened.executor.all({
          sql: "UPDATE migration_lock SET holder = 'thief'",
          params: [],
        });
      },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MigrationLockedError);
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(await userTables()).not.toContain('b');
  });

  it('waits for a live holder, then skips what it applied', async () => {
    await migrate(opened.executor, [init], { holder: 'run-1' });
    let reached!: () => void;
    const reachedPromise = new Promise<void>((resolve) => (reached = resolve));
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => (openGate = resolve));

    const first = migrate(opened.executor, [init, second], {
      holder: 'a',
      onBeforeApply: async () => {
        reached();
        await gate;
      },
    });
    await reachedPromise;
    const sleeps: number[] = [];
    const secondRun = migrate(opened.executor, [init, second], {
      holder: 'b',
      sleep: async (ms) => {
        sleeps.push(ms);
        openGate();
        await first;
      },
    });

    const [a, b] = await Promise.all([first, secondRun]);

    expect(a.applied).toEqual(['core:0002_b']);
    expect(b.applied).toEqual([]);
    expect(b.skipped).toEqual(['core:0001_init', 'core:0002_b']);
    expect(sleeps).toEqual([500]);
  });

  it('throws MigrationLockedError when the wait times out', async () => {
    await migrate(opened.executor, [init], { holder: 'run-1' });
    await opened.executor.all({
      sql: "UPDATE migration_lock SET holder = 'x', expires_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour')",
      params: [],
    });
    let clock = 0;

    await expect(
      migrate(opened.executor, [init, second], {
        holder: 'b',
        lockWaitMs: 1000,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      }),
    ).rejects.toThrow(MigrationLockedError);
    expect(clock).toBe(1000);
  });

  it('tolerates a lost response and says so', async () => {
    const events: MigrateLogEvent[] = [];
    const executor = wrap(opened.executor, {
      batch: async (sqls, run) => {
        const result = await run();
        if (sqls.some((sql) => sql.startsWith('CREATE TABLE'))) throw new Error('response lost');
        return result;
      },
    });

    const result = await migrate(executor, [init, second], {
      holder: 'h',
      log: (event) => events.push(event),
    });

    expect(result.applied).toEqual(['core:0002_b']);
    expect(result.skipped).toEqual(['core:0001_init']);
    const warns = events.filter((event) => event.level === 'warn');
    expect(warns.some((event) => event.id === 'core:0001_init')).toBe(true);
    expect(warns.some((event) => event.id === 'core:0002_b')).toBe(true);
    expect(events.every((event) => event.holder === 'h')).toBe(true);
  });

  it('rejects a pending source that sorts before an applied one', async () => {
    const third = await loadMigrationSource('core', '0003_c.sql', 'CREATE TABLE c (id INTEGER);');
    await migrate(opened.executor, [init, third], { holder: 'run-1' });

    const error = await migrate(opened.executor, [init, second, third], { holder: 'run-2' }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(MigrationOrderError);
    expect((error as MigrationOrderError).id).toBe('core:0002_b');
    expect((error as MigrationOrderError).appliedId).toBe('core:0003_c');
  });

  it('reports a half-initialized database', async () => {
    await opened.executor.batch([
      {
        sql: 'CREATE TABLE migration_lock (id INTEGER NOT NULL PRIMARY KEY, holder TEXT, acquired_at TEXT, expires_at TEXT)',
        params: [],
      },
    ]);

    await expect(migrate(opened.executor, [init], { holder: 'h' })).rejects.toThrow(
      MigrationStateError,
    );
  });

  it('a dry run only reads', async () => {
    const reads: string[] = [];
    const guarded = wrap(opened.executor, {
      all: (sql) => {
        if (!/^\s*SELECT\b/i.test(sql)) throw new Error(`dry run issued: ${sql}`);
        reads.push(sql);
      },
      batch: async () => {
        throw new Error('dry run issued a batch');
      },
    });

    await migrate(guarded, [init, second], { holder: 'h', dryRun: true });
    await migrate(opened.executor, [init], { holder: 'run-1' });
    await migrate(guarded, [init, second], { holder: 'h', dryRun: true });

    expect(reads.length).toBeGreaterThan(0);
  });

  it('retries at once when the holder releases between the failed acquire and the lock read', async () => {
    await migrate(opened.executor, [init], { holder: 'run-1' });
    await opened.executor.all({
      sql: "UPDATE migration_lock SET holder = 'x', expires_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour')",
      params: [],
    });
    let released = false;
    const executor = wrap(opened.executor, {
      all: (sql) => {
        if (!released && sql.startsWith('SELECT holder, expires_at FROM migration_lock')) {
          released = true;
          void opened.executor.all({
            sql: 'UPDATE migration_lock SET holder = NULL, acquired_at = NULL, expires_at = NULL',
            params: [],
          });
        }
      },
    });
    const sleeps: number[] = [];

    const result = await migrate(executor, [init, second], {
      holder: 'b',
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(result.applied).toEqual(['core:0002_b']);
    expect(sleeps).toEqual([]);
  });

  it('releases the lock and completes when the logger throws on acquire', async () => {
    await migrate(opened.executor, [init], { holder: 'run-1' });

    const result = await migrate(opened.executor, [init, second], {
      holder: 'h',
      log: (event) => {
        if (event.message === 'migration lock acquired') throw new Error('logger failed');
      },
    });

    expect(result.applied).toEqual(['core:0002_b']);
    const lock = await opened.executor.all({
      sql: 'SELECT holder FROM migration_lock',
      params: [],
    });
    expect(lock).toEqual([{ holder: null }]);
  });

  it('applies a fresh database when the logger throws on the applied event', async () => {
    const result = await migrate(opened.executor, [init, second], {
      holder: 'h',
      log: (event) => {
        if (event.message.startsWith('applied ')) throw new Error('logger failed');
      },
    });

    expect(result.applied).toEqual(['core:0001_init', 'core:0002_b']);
    expect(await userTables()).toEqual(['a', 'b', 'migration_lock', 'schema_migration']);
  });

  it('ignores a rejecting async logger', async () => {
    const result = await migrate(opened.executor, [init], {
      holder: 'h',
      log: (() => Promise.reject(new Error('logger failed'))) as unknown as () => void,
    });

    expect(result.applied).toEqual(['core:0001_init']);
  });

  it('keeps the migration failure when the logger throws on release', async () => {
    await migrate(opened.executor, [init], { holder: 'run-1' });
    const failing = await loadMigrationSource('core', '0002_b.sql', 'CREATE TABL b (id INTEGER);');

    const error = await migrate(opened.executor, [init, failing], {
      holder: 'h',
      log: (event) => {
        if (event.message === 'migration lock released') throw new Error('logger failed');
      },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MigrationApplyError);
    expect((error as MigrationApplyError).id).toBe('core:0002_b');
  });

  it('warns about an unknown id recorded between the first read and acquisition, once', async () => {
    await migrate(opened.executor, [init], { holder: 'run-1' });
    await opened.executor.batch([
      {
        sql: "INSERT INTO schema_migration (id, name, checksum) VALUES ('core:0009_old', '0009_old', ?)",
        params: ['a'.repeat(64)],
      },
    ]);
    let injected = false;
    const executor = wrap(opened.executor, {
      all: (sql) => {
        if (!injected && sql.startsWith('UPDATE migration_lock SET holder = ?')) {
          injected = true;
          void opened.executor.batch([
            {
              sql: "INSERT INTO schema_migration (id, name, checksum) VALUES ('plugin-x:0001_p', '0001_p', ?)",
              params: ['b'.repeat(64)],
            },
          ]);
        }
      },
    });
    const events: MigrateLogEvent[] = [];

    const result = await migrate(executor, [init, second], {
      holder: 'h',
      log: (event) => events.push(event),
    });

    expect(result.unknown.sort()).toEqual(['core:0009_old', 'plugin-x:0001_p']);
    const unknownWarns = events.filter((event) => event.message.includes('not shipped'));
    expect(unknownWarns.map((event) => event.id).sort()).toEqual([
      'core:0009_old',
      'plugin-x:0001_p',
    ]);
  });

  it('reports a recorded source as skipped when the lease was lost', async () => {
    await migrate(opened.executor, [init], { holder: 'run-1' });
    const events: MigrateLogEvent[] = [];
    const executor = wrap(opened.executor, {
      batch: async (sqls, run) => {
        if (!sqls.some((sql) => sql.startsWith('CREATE TABLE'))) return run();
        await run();
        await opened.executor.all({
          sql: "UPDATE migration_lock SET holder = 'other'",
          params: [],
        });
        throw new Error('response lost');
      },
    });

    const result = await migrate(executor, [init, second], {
      holder: 'h',
      log: (event) => events.push(event),
    });

    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(['core:0001_init', 'core:0002_b']);
    expect(events.some((event) => event.level === 'warn' && event.id === 'core:0002_b')).toBe(true);
  });

  it('names an expired own lease instead of a blocker', async () => {
    await migrate(opened.executor, [init], { holder: 'run-1' });

    const error = await migrate(opened.executor, [init, second], {
      holder: 'h',
      onBeforeApply: async () => {
        await opened.executor.all({
          sql: "UPDATE migration_lock SET expires_at = '2000-01-01T00:00:00.000Z'",
          params: [],
        });
      },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MigrationApplyError);
    expect((error as Error).message).toMatch(/lease expired during the run/);
  });

  it('logs the lock wait once and the timeout once', async () => {
    await migrate(opened.executor, [init], { holder: 'run-1' });
    await opened.executor.all({
      sql: "UPDATE migration_lock SET holder = 'x', expires_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour')",
      params: [],
    });
    let clock = 0;
    const events: MigrateLogEvent[] = [];

    await migrate(opened.executor, [init, second], {
      holder: 'b',
      lockWaitMs: 2000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      log: (event) => events.push(event),
    }).catch(() => undefined);

    expect(
      events.filter((event) => event.message.startsWith('migration lock is held')),
    ).toHaveLength(1);
    expect(events.filter((event) => event.message.includes('timed out'))).toHaveLength(1);
  });
});
