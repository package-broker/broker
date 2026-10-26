import { describe, expect, it } from 'vitest';
import type { SqlExecutor, Statement } from '@package-broker/core/db/port';
import { MigrationLockedError } from '../migrations/lock.js';
import { migrate, MigrationApplyError, type MigrateLogEvent } from '../migrations/runner.js';
import { loadMigrationSource, type MigrationSource } from '../migrations/source.js';
import { countCalls } from './count-calls.js';

export interface OpenedPair {
  readonly executor: SqlExecutor;
  second(): Promise<SqlExecutor>;
  close(): Promise<void>;
}

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

function pendingSource(): Promise<MigrationSource> {
  return loadMigrationSource('core', '0002_x.sql', 'CREATE TABLE x (id INTEGER PRIMARY KEY);');
}

const READ_APPLIED_SQL = 'SELECT id, checksum FROM schema_migration';

function twoRunnerBarrier(): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived === 2) release();
    await ready;
  };
}

function raceExecutors(executors: readonly [SqlExecutor, SqlExecutor], pending: boolean) {
  const firstReadBarrier = twoRunnerBarrier();
  const pendingReadBarrier = twoRunnerBarrier();
  return executors.map((executor) => {
    const reads: { sql: string; rows: unknown[] }[] = [];
    let readPending = false;
    const wrapped: SqlExecutor = {
      driver: executor.driver,
      async all<R = Record<string, unknown>>(statement: Statement): Promise<R[]> {
        const rows = await executor.all<R>(statement);
        reads.push({ sql: statement.sql, rows });
        if (reads.length === 1) await firstReadBarrier();
        if (pending && !readPending && statement.sql === READ_APPLIED_SQL) {
          readPending = true;
          await pendingReadBarrier();
        }
        return rows;
      },
      batch: (statements) => executor.batch(statements),
    };
    return { executor: wrapped, reads };
  });
}

async function expectNotApplied(executor: SqlExecutor, source: MigrationSource): Promise<void> {
  expect(
    await executor.all({
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      params: ['x'],
    }),
  ).toEqual([]);
  expect(
    await executor.all({
      sql: 'SELECT id FROM schema_migration WHERE id = ?',
      params: [source.id],
    }),
  ).toEqual([]);
}

export function describeMigrationLockContract(
  name: string,
  open: () => Promise<OpenedPair>,
  core0001: () => Promise<MigrationSource>,
): void {
  describe(`migration lock contract: ${name}`, () => {
    for (const live of [true, false]) {
      it(`8. ${live ? 'rejects a live' : 'takes over an expired'} foreign lock`, async () => {
        await withPair(open, async ({ executor }) => {
          const init = await core0001();
          const pending = await pendingSource();
          await migrate(executor, [init], { holder: 'setup' });
          await executor.all({
            sql: `UPDATE migration_lock SET holder = ?, expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?) WHERE id = 1`,
            params: ['foreign', live ? '+1 hour' : '-1 hour'],
          });
          const run = migrate(executor, [init, pending], { holder: 'runner', lockWaitMs: 0 });
          if (live) {
            await expect(run).rejects.toBeInstanceOf(MigrationLockedError);
            await expectNotApplied(executor, pending);
          } else {
            expect((await run).applied).toEqual([pending.id]);
            expect(
              await executor.all({
                sql: 'SELECT id FROM schema_migration WHERE id = ?',
                params: [pending.id],
              }),
            ).toEqual([{ id: pending.id }]);
          }
        });
      });
    }

    for (const takeover of [true, false]) {
      it(`${takeover ? '9. takeover' : '10. expiry'} before the batch prevents all application`, async () => {
        await withPair(open, async ({ executor, second }) => {
          const init = await core0001();
          const pending = await pendingSource();
          await migrate(executor, [init], { holder: 'setup' });
          const other = await second();
          const events: MigrateLogEvent[] = [];
          const counted = countCalls(executor);
          let hookRows: { holder: string }[] | undefined;
          await expect(
            migrate(counted.executor, [init, pending], {
              holder: 'runner',
              log: (event) => events.push(event),
              onBeforeApply: async () => {
                hookRows = await other.all<{ holder: string }>({
                  sql: takeover
                    ? "UPDATE migration_lock SET holder = 'intruder' WHERE id = 1 AND holder = ? RETURNING holder"
                    : "UPDATE migration_lock SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = 1 AND holder = ? RETURNING holder",
                  params: ['runner'],
                });
              },
            }),
          ).rejects.toBeInstanceOf(takeover ? MigrationLockedError : MigrationApplyError);
          expect(hookRows).toEqual([{ holder: takeover ? 'intruder' : 'runner' }]);
          expect(counted.counts().batch).toBe(1);
          await expectNotApplied(executor, pending);
          expect(events.filter((event) => event.message === `applied ${pending.id}`)).toEqual([]);
        });
      });
    }

    for (const missing of ['row', 'table'] as const) {
      for (const dryRun of [false, true]) {
        it(`11. missing lock ${missing}: ${dryRun ? 'dry run writes nothing' : 'repairs and applies'}`, async () => {
          await withPair(open, async ({ executor }) => {
            const init = await core0001();
            const pending = await pendingSource();
            await migrate(executor, [init], { holder: 'setup' });
            await executor.all({
              sql: missing === 'row' ? 'DELETE FROM migration_lock' : 'DROP TABLE migration_lock',
              params: [],
            });
            const counted = countCalls(executor);
            const result = await migrate(counted.executor, [init, pending], {
              holder: 'runner',
              dryRun,
            });
            if (dryRun) {
              expect(counted.counts().batch).toBe(0);
              expect(result.applied).toEqual([]);
              expect(result.pending).toEqual([pending.id]);
              await expectNotApplied(executor, pending);
              if (missing === 'row') {
                expect(
                  await executor.all({ sql: 'SELECT * FROM migration_lock', params: [] }),
                ).toEqual([]);
              } else {
                expect(
                  await executor.all({
                    sql: "SELECT name FROM sqlite_master WHERE name = 'migration_lock'",
                    params: [],
                  }),
                ).toEqual([]);
              }
            } else {
              expect(result.applied).toEqual([pending.id]);
              expect(
                await executor.all({ sql: 'SELECT id, holder FROM migration_lock', params: [] }),
              ).toEqual([{ id: 1, holder: null }]);
              expect(
                await executor.all({
                  sql: 'SELECT id FROM schema_migration WHERE id = ?',
                  params: [pending.id],
                }),
              ).toEqual([{ id: pending.id }]);
              expect(await executor.all({ sql: 'SELECT * FROM x', params: [] })).toEqual([]);
            }
          });
        });
      }
    }

    it('12. two fresh runners both resolve and apply core once (ten races)', async () => {
      for (let iteration = 0; iteration < 10; iteration += 1) {
        await withPair(open, async ({ executor, second }) => {
          const init = await core0001();
          const other = await second();
          const runners = raceExecutors([executor, other], false);
          const events: MigrateLogEvent[] = [];
          const results = await Promise.all(
            runners.map((runner, index) =>
              migrate(runner.executor, [init], {
                holder: `runner-${index}`,
                log: (event) => events.push(event),
              }),
            ),
          );
          expect(runners.map((runner) => runner.reads[0]?.rows)).toEqual([[], []]);
          expect(
            events.filter(
              (event) =>
                event.level === 'warn' &&
                event.id === init.id &&
                event.message.includes('is already recorded; another runner applied it'),
            ),
          ).toHaveLength(1);
          expect(results.filter((result) => result.applied.includes(init.id))).toHaveLength(1);
          expect(
            await executor.all({ sql: 'SELECT id FROM schema_migration', params: [] }),
          ).toEqual([{ id: init.id }]);
          expect(
            await executor.all({
              sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'",
              params: [],
            }),
          ).toHaveLength(56);
        });
      }
    }, 60_000);

    it('13. two pending runners both resolve, one applies and one skips (ten races)', async () => {
      for (let iteration = 0; iteration < 10; iteration += 1) {
        await withPair(open, async ({ executor, second }) => {
          const init = await core0001();
          const pending = await pendingSource();
          await migrate(executor, [init], { holder: 'setup' });
          const other = await second();
          const runners = raceExecutors([executor, other], true);
          const events: MigrateLogEvent[] = [];
          const results = await Promise.all(
            runners.map((runner, index) =>
              migrate(runner.executor, [init, pending], {
                holder: `runner-${index}`,
                log: (event) => events.push(event),
              }),
            ),
          );
          for (const runner of runners) {
            expect(runner.reads[0]?.rows).toEqual(
              expect.arrayContaining([{ name: 'schema_migration' }, { name: 'migration_lock' }]),
            );
            expect(runner.reads.find((read) => read.sql === READ_APPLIED_SQL)?.rows).toEqual([
              { id: init.id, checksum: init.checksum },
            ]);
          }
          expect(results.filter((result) => result.applied.includes(pending.id))).toHaveLength(1);
          const loser = results.find((result) => !result.applied.includes(pending.id));
          expect(loser?.skipped).toContain(pending.id);
          const loserIndex = results.findIndex((result) => result === loser);
          expect(events).toContainEqual({
            level: 'info',
            message: 'migration lock acquired',
            holder: `runner-${loserIndex}`,
          });
          expect(
            runners[loserIndex]?.reads
              .filter((read) => read.sql === READ_APPLIED_SQL)
              .map((read) => read.rows),
          ).toEqual([
            [{ id: init.id, checksum: init.checksum }],
            expect.arrayContaining([
              { id: init.id, checksum: init.checksum },
              { id: pending.id, checksum: pending.checksum },
            ]),
          ]);
          expect(
            await executor.all({
              sql: 'SELECT id FROM schema_migration WHERE id = ?',
              params: [pending.id],
            }),
          ).toEqual([{ id: pending.id }]);
        });
      }
    }, 60_000);
  });
}
