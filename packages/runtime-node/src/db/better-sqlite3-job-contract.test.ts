import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll } from 'vitest';
import type { SqlExecutor } from '@package-broker/core/db/port';
import {
  describeJobContract,
  type JobContractFixture,
} from '@package-broker/db-sqlite/contract/job-contract';
import { seedTwoOrganizations } from '@package-broker/db-sqlite/contract/two-organizations';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import {
  loadMigrationSource,
  type MigrationSource,
} from '@package-broker/db-sqlite/migrations/source';
import { createJobRepository } from '@package-broker/db-sqlite/repositories/job';
import { createJobScheduleRepository } from '@package-broker/db-sqlite/repositories/job-schedule';
import { openBetterSqliteExecutor } from './better-sqlite3-executor.js';

const require = createRequire(import.meta.url);
const migrationsDirectory = join(
  dirname(require.resolve('@package-broker/db-sqlite/package.json')),
  'migrations',
);

const closers: (() => Promise<void>)[] = [];

afterAll(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function loadSources(): Promise<MigrationSource[]> {
  return Promise.all(
    readdirSync(migrationsDirectory)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) =>
        loadMigrationSource('core', name, readFileSync(join(migrationsDirectory, name), 'utf8')),
      ),
  );
}

async function make(): Promise<JobContractFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'pb-better-sqlite3-job-'));
  const path = join(directory, 'contract.db');
  const opened: ReturnType<typeof openBetterSqliteExecutor>[] = [];
  closers.push(async () => {
    try {
      for (const connection of opened) await connection.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  const connect = (): SqlExecutor => {
    const connection = openBetterSqliteExecutor(path);
    opened.push(connection);
    return connection.executor;
  };

  const executorA = connect();
  await migrate(executorA, await loadSources(), { holder: 'job-contract' });
  await seedTwoOrganizations(executorA);
  const executorB = connect();

  const update = (sql: string, key: string, iso: string) =>
    executorA.batch([{ sql, params: [iso, key] }]);

  return {
    a: createJobRepository(executorA),
    b: createJobRepository(executorB),
    executorA,
    executorB,
    schedule: createJobScheduleRepository(executorA),
    scheduleB: createJobScheduleRepository(executorB),
    random: (draw) => createJobRepository(executorA, { random: draw }),
    async setLease(jobId, iso) {
      await update('UPDATE job SET lease_until = ? WHERE id = ?', jobId, iso);
    },
    async setNextRunAt(name, iso) {
      await update('UPDATE job_schedule SET next_run_at = ? WHERE name = ?', name, iso);
    },
    async setRunAt(jobId, iso) {
      await update('UPDATE job SET run_at = ? WHERE id = ?', jobId, iso);
    },
  };
}

describeJobContract('better-sqlite3', make);
