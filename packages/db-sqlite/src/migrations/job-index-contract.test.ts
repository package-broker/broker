import { afterEach, describe, expect, it } from 'vitest';
import { jobContractCases, type JobContractFixture } from '../contract/job-contract.js';
import { discoveredMigrations } from '../testing/migrated-database.js';
import { openNodeSqliteExecutor, type OpenedExecutor } from '../testing/node-sqlite-executor.js';
import { migrate } from './runner.js';
import { loadMigrationSource } from './source.js';

let opened: OpenedExecutor | undefined;

afterEach(async () => {
  await opened?.close();
});

describe('migration 0016 legacy job indexes', () => {
  it('declares the destructive migration as contract phase', async () => {
    const migration = (await discoveredMigrations()).find((source) => source.sequence === 16);
    expect(migration?.phase).toBe('contract');
  });

  it.each([false, true])(
    'upgrades an existing queue without changing jobs or organization indexes (later migration=%s)',
    async (laterMigration) => {
      opened = openNodeSqliteExecutor();
      const executor = opened.executor;
      const discovered = await discoveredMigrations();
      if (laterMigration) {
        discovered.push(await loadMigrationSource('core', '9999_future.sql', 'SELECT 1;'));
      }
      const sources = discovered.filter((source) => source.sequence <= 16);
      await migrate(
        executor,
        sources.filter((source) => source.sequence < 16),
        {
          holder: 'job-index-contract',
        },
      );
      expect(
        await executor.all({
          sql: "SELECT name FROM sqlite_master WHERE name IN ('job_claim', 'job_lease') ORDER BY name",
          params: [],
        }),
      ).toEqual([{ name: 'job_claim' }, { name: 'job_lease' }]);
      await executor.batch([
        {
          sql: "INSERT INTO organization (id, slug, name) VALUES ('jobs', 'jobs', 'Jobs')",
          params: [],
        },
        {
          sql: `INSERT INTO job (id, org_id, type, state, lease_owner, lease_until)
          VALUES ('queued', 'jobs', 'demo:migrate:v1', 'queued', NULL, NULL),
            ('running', 'jobs', 'demo:migrate:v1', 'running', 'worker', '2099-01-01T00:00:00.000Z')`,
          params: [],
        },
      ]);
      const jobs = { sql: 'SELECT * FROM job WHERE org_id = ? ORDER BY id', params: ['jobs'] };
      const before = await executor.all(jobs);
      const result = await migrate(executor, sources, { holder: 'job-index-contract' });
      expect(result.applied).toHaveLength(1);
      expect(await executor.all(jobs)).toEqual(before);
      expect(
        await executor.all({
          sql: "SELECT name FROM sqlite_master WHERE name IN ('job_claim', 'job_lease', 'job_claim_org', 'job_lease_org') ORDER BY name",
          params: [],
        }),
      ).toEqual([{ name: 'job_claim_org' }, { name: 'job_lease_org' }]);
      expect((await migrate(executor, sources, { holder: 'job-index-contract' })).applied).toEqual(
        [],
      );
    },
  );

  it.each(['job_claim', 'job_lease'])(
    'the shared EXPLAIN probe detects a retained %s index',
    async (name) => {
      opened = openNodeSqliteExecutor();
      await migrate(
        opened.executor,
        (await discoveredMigrations()).filter((source) => source.sequence < 16),
        { holder: 'job-index-contract' },
      );
      const entry = [...jobContractCases].find(
        ([label]) => label.startsWith('EXPLAIN rejects') && label.includes(name),
      );
      expect(entry).toBeDefined();
      const run = entry![1];
      const fixture = { executorA: opened.executor } as JobContractFixture;
      await expect(run(fixture)).rejects.toThrow(/resolved/);
    },
  );
});
