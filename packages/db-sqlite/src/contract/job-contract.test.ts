import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createJobRepository } from '../repositories/job.js';
import { createJobScheduleRepository } from '../repositories/job-schedule.js';
import { openMigratedDatabase } from '../testing/migrated-database.js';
import {
  assertJobFixture,
  describeJobContract,
  interceptBatches,
  jobContractCases,
  type JobContractFixture,
} from './job-contract.js';

const closers: (() => Promise<void>)[] = [];

afterAll(async () => {
  for (const close of closers.splice(0)) await close();
});

async function make(): Promise<JobContractFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'pb-job-contract-'));
  const database = await openMigratedDatabase({
    file: join(directory, 'contract.sqlite'),
    twoOrganizations: true,
  });
  closers.push(async () => {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  });
  const second = await database.second();
  return {
    a: createJobRepository(database.executor),
    b: createJobRepository(second),
    executorA: database.executor,
    executorB: second,
    schedule: createJobScheduleRepository(database.executor),
    scheduleB: createJobScheduleRepository(second),
    random: (draw) => createJobRepository(database.executor, { random: draw }),
    intercept: interceptBatches,
    async setLease(jobId, iso) {
      await database.executor.batch([
        { sql: 'UPDATE job SET lease_until = ? WHERE id = ?', params: [iso, jobId] },
      ]);
    },
    async setNextRunAt(name, iso) {
      await database.executor.batch([
        { sql: 'UPDATE job_schedule SET next_run_at = ? WHERE name = ?', params: [iso, name] },
      ]);
    },
    async setRunAt(jobId, iso) {
      await database.executor.batch([
        { sql: 'UPDATE job SET run_at = ? WHERE id = ?', params: [iso, jobId] },
      ]);
    },
  };
}

describeJobContract('node:sqlite', make);

const REQUIRED_CASES = [
  'concurrent claims',
  'same-resource exclusivity',
  'independent resources up to the cap',
  'repeated enqueue and conflicting reuse',
  'claim and attempt roll back together',
  'heartbeat renewal',
  'expiry before takeover',
  'takeover increases the fence',
  'old owner heartbeat, complete, fail and release reject',
  'wrong org',
  'missing row',
  'exhausted lease and permanent error become dead',
  'deterministic backoff',
  'duplicate scheduler ticks',
  'crash after effect before completion yields one effect on replay',
  'long-delay row is not claimed early',
  'mixed-version consumer releases without consuming an attempt',
  'head-of-line resource does not stall independent claims',
  'lease expiry mid-batch leaves consistent state',
  'expired leases do not count toward maxRunning',
  'claim takes over an expired holder on the same resource',
  'lease guard lets a batch write while the lease is live',
  'lease guard rejects the batch when the lease or fence is not current',
  'lease guard rejects another organization',
  'malformed claim input is rejected',
  'clock jump during a tick does not fire a slot twice',
  'settle after expiry without takeover succeeds',
  'schedule sync without conflict succeeds',
  'schedule sync with a conflicting interval rolls back',
  'lease expiry between the statements of a claim stays consistent',
  'a lease that lapses right after the grant leaves a reapable claim',
  'a fault between claim statements rolls the claim back',
  'a slot boundary inside a tick fires exactly one slot',
  'corrupt payload scan progresses past valid resource-blocked rows',
  'a stored payload accepted only by SQLite is dead before claim',
  'a corrupted queued payload is dead with invalid_payload and the queue moves',
];

describe('job contract registry', () => {
  it('lists every required case exactly once', () => {
    const names = [...jobContractCases.keys()];
    expect(names).toEqual(expect.arrayContaining(REQUIRED_CASES));
    expect(new Set(names).size).toBe(names.length);
  });

  it('the slot boundary case detects an update that recomputes the slot from now', async () => {
    const fixture = await make();
    const run = jobContractCases.get('a slot boundary inside a tick fires exactly one slot')!;
    let recomputed = false;
    const intercept: NonNullable<JobContractFixture['intercept']> = (base, hook) =>
      interceptBatches(
        {
          ...base,
          all: (statement) => {
            if (/^UPDATE job_schedule SET\s+last_slot/.test(statement.sql)) {
              recomputed = true;
              return base.all({
                sql: `UPDATE job_schedule SET
                  last_slot = strftime('%Y-%m-%dT%H:%M:00.000Z','now'),
                  next_run_at = strftime('%Y-%m-%dT%H:%M:00.000Z','now','+1 minute')
                  WHERE name = 'core:slot-boundary:v1'`,
                params: [],
              });
            }
            return base.all(statement);
          },
        },
        hook,
      );
    await expect(run({ ...fixture, intercept })).rejects.toMatchObject({
      actual: {
        last_slot: '2020-01-01T00:02:00.000Z',
        next_run_at: '2020-01-01T00:03:00.000Z',
      },
    });
    expect(recomputed).toBe(true);
  });

  it('fails a fixture with a missing hook instead of skipping', () => {
    const fixture = {} as unknown as JobContractFixture;
    expect(() => assertJobFixture(fixture)).toThrow(/setLease/);
    expect(() => assertJobFixture(fixture)).toThrow(/setNextRunAt/);
    expect(() => assertJobFixture(fixture)).toThrow(/scheduleB/);
  });

  it('refuses a fixture whose two handles are the same object', async () => {
    const fixture = await make();
    expect(() => assertJobFixture({ ...fixture, b: fixture.a })).toThrow(/independent/);
    expect(() => assertJobFixture({ ...fixture, scheduleB: fixture.schedule })).toThrow(
      /independent/,
    );
  });

  it('is exported from the package under NodeNext', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { exports: Record<string, unknown> };
    expect(manifest.exports['./contract/job-contract']).toEqual({
      types: './dist/contract/job-contract.d.ts',
      default: './dist/contract/job-contract.js',
    });
  });
});
