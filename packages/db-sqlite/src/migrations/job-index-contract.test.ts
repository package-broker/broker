import { afterEach, describe, expect, it } from 'vitest';
import { jobContractCases, type JobContractFixture } from '../contract/job-contract.js';
import { discoveredMigrations } from '../testing/migrated-database.js';
import { openNodeSqliteExecutor, type OpenedExecutor } from '../testing/node-sqlite-executor.js';
import { migrate } from './runner.js';

let opened: OpenedExecutor | undefined;

afterEach(async () => {
  await opened?.close();
});

describe('legacy job index EXPLAIN probes', () => {
  it.each(['job_claim', 'job_lease'])(
    'the shared EXPLAIN probe detects a retained %s index',
    async (name) => {
      opened = openNodeSqliteExecutor();
      await migrate(opened.executor, await discoveredMigrations(), {
        holder: 'job-index-contract',
      });
      await opened.executor.all({
        sql:
          name === 'job_claim'
            ? "CREATE INDEX job_claim ON job (run_at, id) WHERE state = 'queued'"
            : "CREATE INDEX job_lease ON job (lease_until) WHERE state = 'running'",
        params: [],
      });
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
