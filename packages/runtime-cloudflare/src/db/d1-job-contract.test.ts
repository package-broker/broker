import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterAll } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
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
import { createD1Executor, type D1DatabaseLike } from './d1-executor.js';

const bindings = Array.from({ length: 64 }, (_, index) => `JDB${index}`);

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

async function database(): Promise<D1DatabaseLike> {
  const binding = bindings[next];
  next += 1;
  if (binding === undefined) throw new Error('out of D1 bindings');
  return (await mf.getD1Database(binding)) as unknown as D1DatabaseLike;
}

const require = createRequire(import.meta.url);
const migrationsDirectory = join(
  dirname(require.resolve('@package-broker/db-sqlite/package.json')),
  'migrations',
);

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
  const db = await database();
  const executorA = createD1Executor(db);
  const executorB = createD1Executor(db);
  await migrate(executorA, await loadSources(), { holder: 'job-contract' });
  await seedTwoOrganizations(executorA);

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

describeJobContract('d1-miniflare', make);
