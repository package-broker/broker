import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { orgContext, type SqlExecutor, type Statement } from '@package-broker/core/db/port';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createJobRepository } from './job.js';

const OWNER = '01J0WWWWWWWWWWWWWWWWWW0001';
const input = { types: ['demo:plan:v1'], leaseSeconds: 60, maxRunning: 10 };

describe('job claim query plans (node:sqlite)', () => {
  let database: MigratedDatabase;
  let statements: Statement[];
  let executor: SqlExecutor;
  let batches: number;

  beforeEach(async () => {
    database = await openMigratedDatabase();
    statements = [];
    batches = 0;
    executor = {
      driver: database.executor.driver,
      all: (statement) => database.executor.all(statement),
      batch: (batch) => {
        batches += 1;
        statements.push(...batch);
        return database.executor.batch(batch);
      },
    };
  });

  afterEach(async () => {
    await database.close();
  });

  async function claimPlan(): Promise<string> {
    await createJobRepository(executor).claim(orgContext('plan-org'), OWNER, input);
    const claim = statements.find(
      (statement) =>
        statement.sql.includes('SELECT c.id FROM job c') && statement.sql.includes('lease_until >'),
    );
    if (claim === undefined) throw new Error('claim update missing');
    const plan = await database.executor.all<{ detail: string }>({
      sql: `EXPLAIN QUERY PLAN ${claim.sql}`,
      params: claim.params,
    });
    return plan.map((step) => step.detail).join('\n');
  }

  it('searches queued candidates by organization and due time without sorting', async () => {
    const plan = await claimPlan();
    expect(plan).toMatch(/SEARCH c USING INDEX job_claim_org \(org_id=\? AND run_at<\?\)/);
    expect(plan).not.toContain('TEMP B-TREE');
  });

  it('counts live leases using the organization and lease expiry index', async () => {
    expect(await claimPlan()).toMatch(
      /SEARCH r USING (COVERING )?INDEX job_lease_org \(org_id=\? AND lease_until>\?\)/,
    );
  });

  it('issues eight statements in one batch even when no job can be claimed', async () => {
    const repo = createJobRepository(executor);
    expect(await repo.claim(orgContext('plan-org'), OWNER, input)).toBeNull();
    expect(statements).toHaveLength(8);
    expect(batches).toBe(1);
  });

  it('issues no statements when no job types are registered', async () => {
    expect(
      await createJobRepository(executor).claim(orgContext('plan-org'), OWNER, {
        ...input,
        types: [],
      }),
    ).toBeNull();
    expect(statements).toHaveLength(0);
  });
});
