import { describe, expect, it } from 'vitest';
import { orgContext, type OrgContext, type SqlExecutor } from '@package-broker/core/db/port';
import {
  IdempotencyConflictError,
  StaleFenceError,
  type JobClaim,
  type JobEnqueue,
  type JobRepository,
} from '@package-broker/core/platform/job-repository';
import { JobError, retryDelaySeconds } from '@package-broker/core/platform/jobs';
import { jobLeaseGuard } from '../repositories/job-lease-guard.js';
import type { JobScheduleRepository } from '../repositories/job-schedule.js';

export { jobLeaseGuard };

/**
 * Every `make()` call returns a new, empty database holding the two organizations of
 * `seedTwoOrganizations`. `a` and `b` (and `schedule` and `scheduleB`) run over independent
 * connections to that one storage; `executorA` and `executorB` are the raw executors behind them.
 * `setLease`, `setNextRunAt` and `setRunAt` rewrite stored deadlines; the contract never moves
 * a production clock predicate.
 */
export interface JobContractFixture {
  readonly a: JobRepository;
  readonly b: JobRepository;
  readonly executorA: SqlExecutor;
  readonly executorB: SqlExecutor;
  readonly schedule: JobScheduleRepository;
  readonly scheduleB: JobScheduleRepository;
  readonly setLease: (jobId: string, iso: string) => Promise<void>;
  readonly setNextRunAt: (name: string, iso: string) => Promise<void>;
  readonly setRunAt: (jobId: string, iso: string) => Promise<void>;
  /** Optional: a repository on connection a whose backoff jitter draws from the given source. */
  readonly random?: (draw: () => number) => JobRepository;
}

type Case = (fixture: JobContractFixture) => Promise<void>;

const ORG_A = orgContext('01J00000000000000000000A0A');
const ORG_B = orgContext('01J00000000000000000000B0B');
const TYPE = 'demo:work:v1';
const OTHER_TYPE = 'demo:other:v1';
const PAST = '2020-01-01T00:00:00.000Z';
const PAST_PLUS_ONE = '2020-01-01T00:00:01.000Z';
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const TOLERANCE_SECONDS = 2;
const BACKOFF_ROUNDS = 12;
const DAY_SECONDS = 86_400;
const CASE_TIMEOUT_MS = 30_000;

let counter = 0;

function nextId(): string {
  counter += 1;
  return `01J0CJOB${String(counter).padStart(18, '0')}`;
}

function owner(n: number): string {
  return `01J0${'W'.repeat(18)}${String(n).padStart(4, '0')}`;
}

function job(overrides: Partial<JobEnqueue> = {}): JobEnqueue {
  const id = overrides.id ?? nextId();
  return {
    id,
    type: TYPE,
    payloadJson: '{"a":1}',
    idempotencyKey: `${TYPE}:${id}`,
    resourceKey: null,
    runAt: null,
    maxAttempts: 3,
    projectId: null,
    initiatorTokenId: null,
    ...overrides,
  };
}

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function minuteStart(offsetMs: number): string {
  return new Date(Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS + offsetMs).toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

function claimOf(
  repo: JobRepository,
  who: number,
  input: Partial<{
    id: string;
    types: string[];
    leaseSeconds: number;
    maxRunning: number;
  }> = {},
  ctx: OrgContext = ORG_A,
): Promise<JobClaim | null> {
  return repo.claim(ctx, owner(who), {
    types: [TYPE],
    leaseSeconds: 60,
    maxRunning: 5,
    ...input,
  });
}

async function enqueued(repo: JobRepository, overrides: Partial<JobEnqueue> = {}) {
  const row = job(overrides);
  await repo.enqueue(ORG_A, row);
  return row;
}

async function stateOf(repo: JobRepository, id: string) {
  return present(await repo.status(ORG_A, id), `job ${id}`);
}

const failed = (permanent: boolean) =>
  ({ outcome: 'failed', errorCode: 'handler_error', permanent }) as const;

async function rejectsBatch(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught ?? new Error('rejected without a reason'),
  );
  expect(error).toBeDefined();
  expect(error).not.toBeInstanceOf(RangeError);
  expect(error).not.toBeInstanceOf(JobError);
}

async function rejectsStale(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(StaleFenceError);
}

const concurrentClaims: Case = async ({ a, b }) => {
  const only = await enqueued(a);
  const raced = await Promise.all([claimOf(a, 1), claimOf(b, 2)]);
  const winners = raced.filter((claim) => claim !== null);
  expect(winners).toHaveLength(1);
  expect(present(winners[0], 'a winner').id).toBe(only.id);

  await enqueued(a);
  await enqueued(a);
  const pair = await Promise.all([claimOf(a, 3), claimOf(b, 4)]);
  const ids = pair.map((claim) => present(claim, 'a claim').id);
  expect(new Set(ids).size).toBe(2);
  expect(ids).not.toContain(only.id);
};

const sameResourceExclusivity: Case = async ({ a, b }) => {
  const first = await enqueued(a, { resourceKey: 'repo:1', runAt: PAST });
  const second = await enqueued(a, { resourceKey: 'repo:1', runAt: PAST_PLUS_ONE });
  const held = present(await claimOf(a, 1), 'the first claim');
  expect(held.id).toBe(first.id);
  expect(await claimOf(b, 2)).toBeNull();
  await a.settle(ORG_A, held, { outcome: 'succeeded' });
  expect(present(await claimOf(b, 3), 'the second claim').id).toBe(second.id);
};

const independentResourcesUpToCap: Case = async ({ a, b }) => {
  for (const key of ['r:1', 'r:2', 'r:3']) await enqueued(a, { resourceKey: key });
  const first = present(await claimOf(a, 1, { maxRunning: 2 }), 'a claim');
  const second = present(await claimOf(b, 2, { maxRunning: 2 }), 'a claim');
  expect(first.id).not.toBe(second.id);
  expect(await claimOf(a, 3, { maxRunning: 2 })).toBeNull();
  await a.settle(ORG_A, first, { outcome: 'succeeded' });
  expect(await claimOf(b, 4, { maxRunning: 2 })).not.toBeNull();
};

const repeatedEnqueue: Case = async ({ a }) => {
  const row = job();
  expect(await a.enqueue(ORG_A, row)).toEqual({ id: row.id, created: true });
  expect(await a.enqueue(ORG_A, { ...row, id: nextId() })).toEqual({ id: row.id, created: false });
  await expect(
    a.enqueue(ORG_A, { ...row, id: nextId(), payloadJson: '{"a":2}' }),
  ).rejects.toBeInstanceOf(IdempotencyConflictError);
  await expect(
    a.enqueue(ORG_A, { ...row, id: nextId(), resourceKey: 'other' }),
  ).rejects.toBeInstanceOf(IdempotencyConflictError);
  await expect(a.enqueue(ORG_A, { ...row, id: nextId(), type: OTHER_TYPE })).rejects.toBeInstanceOf(
    IdempotencyConflictError,
  );
  const sibling = { ...row, id: nextId() };
  expect(await a.enqueue(ORG_B, sibling)).toEqual({ id: sibling.id, created: true });
};

const claimAttemptRollback: Case = async ({ a, b, executorA }) => {
  const first = await enqueued(a);
  const second = await enqueued(a);
  expect(await claimOf(a, 1)).not.toBeNull();
  expect(await claimOf(b, 1)).toBeNull();
  expect(await stateOf(a, second.id)).toMatchObject({ state: 'queued', attempts: 0, history: [] });
  expect((await stateOf(a, first.id)).history).toHaveLength(1);

  const target = await enqueued(a, { runAt: PAST_PLUS_ONE });
  await executorA.batch([
    {
      sql: `INSERT INTO job_attempt (id, org_id, job_id, attempt, fence, worker, outcome, error)
        VALUES (?, ?, ?, 1, 1, ?, 'failed', 'handler_error')`,
      params: [owner(90), ORG_A.orgId, target.id, owner(91)],
    },
  ]);
  await rejectsBatch(claimOf(b, 2, { id: target.id }));
  expect(await stateOf(a, target.id)).toMatchObject({ state: 'queued', attempts: 0 });
  await executorA.batch([{ sql: 'DELETE FROM job_attempt WHERE id = ?', params: [owner(90)] }]);
  const retry = present(await claimOf(b, 3, { id: target.id }), 'a claim after the fault clears');
  expect(retry.fence).toBe(1);
  expect(retry.attempt).toBe(1);
};

const heartbeatRenewal: Case = async ({ a, b, setLease }) => {
  await enqueued(a);
  const claim = present(await claimOf(a, 1), 'a claim');
  await setLease(claim.id, iso(1000));
  await a.heartbeat(ORG_A, claim);
  await sleep(1300);
  expect(await b.reap(ORG_A, 10)).toBe(0);
  await a.heartbeat(ORG_A, claim);
  expect(await stateOf(a, claim.id)).toMatchObject({ state: 'running', attempts: 1 });
};

const expiryBeforeTakeover: Case = async ({ a, setLease }) => {
  await enqueued(a);
  const claim = present(await claimOf(a, 1), 'a claim');
  await setLease(claim.id, PAST);
  await rejectsStale(a.heartbeat(ORG_A, claim));
  expect(await stateOf(a, claim.id)).toMatchObject({ state: 'running', attempts: 1 });
};

const takeoverFence: Case = async ({ a, b, setLease, setRunAt }) => {
  await enqueued(a);
  const first = present(await claimOf(a, 1), 'a claim');
  await setLease(first.id, PAST);
  expect(await b.reap(ORG_A, 10)).toBe(1);
  await setRunAt(first.id, PAST);
  const second = present(await claimOf(b, 2), 'the takeover claim');
  expect(second.id).toBe(first.id);
  expect(second.fence).toBe(first.fence + 1);
  expect(second.attempt).toBe(first.attempt + 1);
  const status = await stateOf(a, first.id);
  expect(status.history.map((attempt) => attempt.outcome)).toEqual(['lease_expired', 'running']);
  await rejectsStale(a.heartbeat(ORG_A, first));
  await rejectsStale(a.settle(ORG_A, first, { outcome: 'succeeded' }));
  await b.heartbeat(ORG_A, second);
};

const oldOwnerRejected: Case = async ({ a, b }) => {
  const row = await enqueued(a);
  const first = present(await claimOf(a, 1, { id: row.id }), 'a claim');
  await a.settle(ORG_A, first, { outcome: 'released', delaySeconds: 0 });
  const second = present(await claimOf(b, 2, { id: row.id }), 'a claim');
  expect(second.fence).toBe(first.fence + 1);
  await rejectsStale(a.heartbeat(ORG_A, first));
  await rejectsStale(a.settle(ORG_A, first, { outcome: 'succeeded' }));
  await rejectsStale(a.settle(ORG_A, first, failed(false)));
  await rejectsStale(a.settle(ORG_A, first, failed(true)));
  await rejectsStale(a.settle(ORG_A, first, { outcome: 'released', delaySeconds: 0 }));
  expect(await stateOf(a, row.id)).toMatchObject({ state: 'running' });
  await b.settle(ORG_A, second, { outcome: 'succeeded' });
  await rejectsStale(b.settle(ORG_A, second, failed(false)));
};

const wrongOrg: Case = async ({ a, b }) => {
  const row = await enqueued(a);
  const claim = present(await claimOf(a, 1), 'a claim');
  await rejectsStale(b.heartbeat(ORG_B, claim));
  await rejectsStale(b.settle(ORG_B, claim, { outcome: 'succeeded' }));
  await rejectsStale(b.settle(ORG_B, claim, failed(true)));
  expect(await b.status(ORG_B, row.id)).toBeNull();
  expect(await claimOf(b, 2, { id: row.id }, ORG_B)).toBeNull();
  expect(await claimOf(b, 3, {}, ORG_B)).toBeNull();
  expect(await b.reap(ORG_B, 10)).toBe(0);
  expect(await stateOf(a, row.id)).toMatchObject({ state: 'running', attempts: 1 });
};

const missingRow: Case = async ({ a }) => {
  const ghost = { id: nextId(), owner: owner(1), fence: 1 };
  expect(await a.status(ORG_A, ghost.id)).toBeNull();
  await rejectsStale(a.heartbeat(ORG_A, ghost));
  await rejectsStale(a.settle(ORG_A, ghost, { outcome: 'succeeded' }));
  await rejectsStale(a.settle(ORG_A, ghost, failed(false)));
  expect(await a.reap(ORG_A, 10)).toBe(0);
  expect(await claimOf(a, 2, { id: ghost.id })).toBeNull();
};

const deadStates: Case = async ({ a, b, setLease }) => {
  const exhausted = await enqueued(a, { maxAttempts: 1 });
  const lapsed = present(await claimOf(a, 1), 'a claim');
  await setLease(lapsed.id, PAST);
  expect(await b.reap(ORG_A, 10)).toBe(1);
  expect(await stateOf(a, exhausted.id)).toMatchObject({
    state: 'dead',
    attempts: 1,
    lastErrorCode: 'lease_lost',
  });
  expect(await claimOf(b, 2, { id: exhausted.id })).toBeNull();

  const permanent = await enqueued(a, { maxAttempts: 5 });
  const claim = present(await claimOf(a, 3, { id: permanent.id }), 'a claim');
  await a.settle(ORG_A, claim, failed(true));
  expect(await stateOf(a, permanent.id)).toMatchObject({
    state: 'dead',
    attempts: 1,
    lastErrorCode: 'handler_error',
  });

  const retried = await enqueued(a, { maxAttempts: 2 });
  const transient = present(await claimOf(a, 4, { id: retried.id }), 'a claim');
  await a.settle(ORG_A, transient, failed(false));
  expect(await stateOf(a, retried.id)).toMatchObject({ state: 'queued', attempts: 1 });
};

const JITTER_DRAW = 0.5;

const deterministicBackoff: Case = async ({ a, setRunAt, random }) => {
  const repo = random?.(() => JITTER_DRAW) ?? a;
  const row = await enqueued(repo, { maxAttempts: BACKOFF_ROUNDS + 1 });
  for (let round = 1; round <= BACKOFF_ROUNDS; round += 1) {
    const claim = present(await claimOf(repo, round, { id: row.id }), `claim ${String(round)}`);
    const before = Date.now();
    await repo.settle(ORG_A, claim, failed(false));
    const after = Date.now();
    const status = await stateOf(repo, row.id);
    expect(status).toMatchObject({ state: 'queued', attempts: round });
    const ceiling = retryDelaySeconds(round, () => 1);
    const runAt = Date.parse(status.runAt);
    if (random === undefined) {
      expect(runAt).toBeGreaterThanOrEqual(
        before + 0.8 * ceiling * 1000 - TOLERANCE_SECONDS * 1000,
      );
      expect(runAt).toBeLessThanOrEqual(after + ceiling * 1000 + TOLERANCE_SECONDS * 1000);
    } else {
      const finished = Date.parse(
        present(status.history[status.history.length - 1]?.finishedAt, 'a finish time'),
      );
      const expected = ceiling * (0.8 + 0.2 * JITTER_DRAW) * 1000;
      expect(Math.abs(runAt - finished - expected)).toBeLessThanOrEqual(2);
    }
    expect(await claimOf(repo, 100 + round, { id: row.id })).toBeNull();
    await setRunAt(row.id, PAST);
  }
};

const duplicateTicks: Case = async ({ a, schedule, scheduleB }) => {
  const name = 'core:tick-once:v1';
  await schedule.sync(ORG_A, [
    { name, everySeconds: DAY_SECONDS, nextRunAt: minuteStart(-MINUTE_MS) },
  ]);
  const fired = (await Promise.all([schedule.tick(ORG_A), scheduleB.tick(ORG_A)])).flat();
  expect(fired).toHaveLength(1);
  expect(await schedule.tick(ORG_A)).toEqual([]);
  expect(await scheduleB.tick(ORG_A)).toEqual([]);
  const claim = present(await claimOf(a, 1, { types: [name] }), 'the scheduled job');
  expect(claim.id).toBe(present(fired[0], 'a fired job').jobId);
  expect(claim.idempotencyKey.startsWith(`schedule:${name}:`)).toBe(true);
  expect(await claimOf(a, 2, { types: [name] })).toBeNull();
};

async function effectTable(executor: SqlExecutor): Promise<void> {
  await executor.batch([
    { sql: 'CREATE TABLE IF NOT EXISTS effect (domain_key TEXT PRIMARY KEY)', params: [] },
  ]);
}

async function effectCount(executor: SqlExecutor): Promise<number> {
  const rows = await executor.all<{ n: number }>({
    sql: 'SELECT count(*) AS n FROM effect',
    params: [],
  });
  return Number(rows[0]?.n ?? 0);
}

function guardedEffect(
  executor: SqlExecutor,
  ctx: OrgContext,
  claim: JobClaim,
  key: string,
  leading = false,
) {
  return executor.batch([
    ...(leading
      ? [{ sql: 'INSERT INTO effect (domain_key) VALUES (?)', params: [`${key}:leading`] }]
      : []),
    ...jobLeaseGuard(ctx, claim),
    {
      sql: 'INSERT INTO effect (domain_key) VALUES (?) ON CONFLICT (domain_key) DO NOTHING',
      params: [key],
    },
  ]);
}

const crashAfterEffect: Case = async ({ a, b, executorA, executorB, setLease, setRunAt }) => {
  await effectTable(executorA);
  const row = await enqueued(a);
  const crashed = present(await claimOf(a, 1), 'a claim');
  await guardedEffect(executorA, ORG_A, crashed, crashed.idempotencyKey);
  expect(await effectCount(executorA)).toBe(1);
  await setLease(crashed.id, PAST);
  expect(await b.reap(ORG_A, 10)).toBe(1);
  await setRunAt(crashed.id, PAST);
  const replay = present(await claimOf(b, 2), 'the replay claim');
  await guardedEffect(executorB, ORG_A, replay, replay.idempotencyKey);
  expect(replay.idempotencyKey).toBe(crashed.idempotencyKey);
  expect(await effectCount(executorB)).toBe(1);
  await rejectsBatch(guardedEffect(executorA, ORG_A, crashed, 'stale-owner-effect', true));
  expect(await effectCount(executorA)).toBe(1);
  await b.settle(ORG_A, replay, { outcome: 'succeeded' });
  await rejectsStale(a.settle(ORG_A, crashed, { outcome: 'succeeded' }));
  const status = await stateOf(a, row.id);
  expect(status.state).toBe('succeeded');
  expect(status.history.map((attempt) => attempt.outcome)).toEqual(['lease_expired', 'succeeded']);
};

const leaseGuardWrites: Case = async ({ a, executorA }) => {
  await effectTable(executorA);
  await enqueued(a);
  const claim = present(await claimOf(a, 1), 'a claim');
  await guardedEffect(executorA, ORG_A, claim, 'live');
  expect(await effectCount(executorA)).toBe(1);
};

const leaseGuardRollsBack: Case = async ({ a, executorA, setLease }) => {
  await effectTable(executorA);
  await enqueued(a);
  const claim = present(await claimOf(a, 1), 'a claim');
  await setLease(claim.id, PAST);
  await rejectsBatch(guardedEffect(executorA, ORG_A, claim, 'expired', true));
  await setLease(claim.id, iso(DAY_MS));
  await rejectsBatch(
    guardedEffect(executorA, ORG_A, { ...claim, fence: claim.fence + 1 }, 'advanced', true),
  );
  await rejectsBatch(
    guardedEffect(executorA, ORG_A, { ...claim, owner: owner(77) }, 'foreign', true),
  );
  expect(await effectCount(executorA)).toBe(0);
};

const leaseGuardOrganization: Case = async ({ a, executorA }) => {
  await effectTable(executorA);
  await enqueued(a);
  const claim = present(await claimOf(a, 1), 'a claim');
  await rejectsBatch(guardedEffect(executorA, ORG_B, claim, 'other-org', true));
  expect(await effectCount(executorA)).toBe(0);
};

const longDelay: Case = async ({ a }) => {
  const row = await enqueued(a, { runAt: iso(DAY_MS) });
  expect(await claimOf(a, 1)).toBeNull();
  expect(await claimOf(a, 2, { id: row.id })).toBeNull();
  expect(await stateOf(a, row.id)).toMatchObject({ state: 'queued', attempts: 0, history: [] });
};

const mixedVersion: Case = async ({ a, b }) => {
  const row = await enqueued(a, { type: OTHER_TYPE });
  expect(await claimOf(a, 1, { types: [TYPE] })).toBeNull();
  expect(await claimOf(a, 2, { types: [TYPE], id: row.id })).toBeNull();
  expect(await stateOf(a, row.id)).toMatchObject({ state: 'queued', attempts: 0 });

  const claim = present(await claimOf(b, 3, { types: [TYPE, OTHER_TYPE] }), 'a claim');
  expect(claim.type).toBe(OTHER_TYPE);
  const before = Date.now();
  await b.settle(ORG_A, claim, { outcome: 'released', delaySeconds: 120 });
  const status = await stateOf(a, row.id);
  expect(status).toMatchObject({ state: 'queued', attempts: 0 });
  expect(status.history.map((attempt) => attempt.outcome)).toEqual(['released']);
  expect(Date.parse(status.runAt)).toBeGreaterThanOrEqual(before + 120_000 - 2000);
  expect(await claimOf(a, 4, { types: [OTHER_TYPE] })).toBeNull();
};

const headOfLine: Case = async ({ a, b }) => {
  const held = await enqueued(a, { resourceKey: 'busy', runAt: PAST });
  const blocked = await enqueued(a, { resourceKey: 'busy', runAt: PAST_PLUS_ONE });
  const free = await enqueued(a, { resourceKey: 'free' });
  const first = present(await claimOf(a, 1), 'a claim');
  expect(first.id).toBe(held.id);
  expect(present(await claimOf(b, 2), 'an independent claim').id).toBe(free.id);
  expect(await claimOf(b, 3)).toBeNull();
  expect(await stateOf(a, blocked.id)).toMatchObject({ state: 'queued', attempts: 0 });
};

const leaseExpiryMidBatch: Case = async ({ a, b, setLease }) => {
  const settleFirst = await enqueued(a);
  const early = present(await claimOf(a, 1, { id: settleFirst.id }), 'a claim');
  await setLease(early.id, PAST);
  await a.settle(ORG_A, early, { outcome: 'succeeded' });
  expect(await b.reap(ORG_A, 10)).toBe(0);
  const settled = await stateOf(a, settleFirst.id);
  expect(settled.state).toBe('succeeded');
  expect(settled.history.map((attempt) => attempt.outcome)).toEqual(['succeeded']);

  const reapFirst = await enqueued(a);
  const late = present(await claimOf(a, 2, { id: reapFirst.id }), 'a claim');
  await setLease(late.id, PAST);
  expect(await b.reap(ORG_A, 10)).toBe(1);
  await rejectsStale(a.settle(ORG_A, late, { outcome: 'succeeded' }));
  const reaped = await stateOf(a, reapFirst.id);
  expect(reaped.state).toBe('queued');
  expect(reaped.history.map((attempt) => attempt.outcome)).toEqual(['lease_expired']);
  expect(reaped.history[0]?.finishedAt).not.toBeNull();

  const raced = await enqueued(a);
  const racing = present(await claimOf(a, 3, { id: raced.id }), 'a claim');
  await setLease(racing.id, PAST);
  const [outcome, reap] = await Promise.allSettled([
    a.settle(ORG_A, racing, { outcome: 'succeeded' }),
    b.reap(ORG_A, 10),
  ]);
  expect(reap.status).toBe('fulfilled');
  const status = await stateOf(a, raced.id);
  expect(status.history).toHaveLength(1);
  if (outcome.status === 'fulfilled') {
    expect(status.state).toBe('succeeded');
    expect(status.history[0]?.outcome).toBe('succeeded');
  } else {
    expect(outcome.reason).toBeInstanceOf(StaleFenceError);
    expect(status.state).toBe('queued');
    expect(status.history[0]?.outcome).toBe('lease_expired');
  }
};

const expiredLeasesFreeCapacity: Case = async ({ a, b, setLease }) => {
  const first = await enqueued(a);
  const second = await enqueued(a);
  const held = present(await claimOf(a, 1, { maxRunning: 1 }), 'a claim');
  expect(held.id).toBe(first.id);
  expect(await claimOf(b, 2, { maxRunning: 1 })).toBeNull();
  await setLease(held.id, PAST);
  const next = present(await claimOf(b, 3, { maxRunning: 1 }), 'a claim beside the expired lease');
  expect(next.id).toBe(second.id);
};

const claimTakesOverExpiredHolder: Case = async ({ a, b, setLease }) => {
  const held = await enqueued(a, { resourceKey: 'shared', runAt: PAST });
  const next = await enqueued(a, { resourceKey: 'shared', runAt: PAST_PLUS_ONE });
  const lapsed = present(await claimOf(a, 1), 'a claim');
  expect(lapsed.id).toBe(held.id);
  await setLease(lapsed.id, PAST);
  const taken = present(await claimOf(b, 2), 'a claim over the expired holder');
  expect(taken.id).toBe(next.id);
  const status = await stateOf(a, held.id);
  expect(status.state).toBe('queued');
  expect(status.history.map((attempt) => attempt.outcome)).toEqual(['lease_expired']);
  await rejectsStale(a.settle(ORG_A, lapsed, { outcome: 'succeeded' }));
};

const malformedClaimInput: Case = async ({ a }) => {
  const row = await enqueued(a);
  await expect(a.claim(ORG_A, 'not-a-ulid', base())).rejects.toThrow(RangeError);
  await expect(a.claim(ORG_A, owner(2), { ...base(), id: '' })).rejects.toThrow(RangeError);
  await expect(a.claim(ORG_A, owner(2), { ...base(), leaseSeconds: 0 })).rejects.toThrow(
    RangeError,
  );
  await expect(a.claim(ORG_A, owner(2), { ...base(), maxRunning: 0 })).rejects.toThrow(RangeError);
  await expect(a.claim(ORG_A, owner(2), { ...base(), types: [''] })).rejects.toThrow(RangeError);
  await expect(a.enqueue(ORG_A, job({ payloadJson: 'not json' }))).rejects.toBeInstanceOf(JobError);
  expect(await a.claim(ORG_A, owner(3), { ...base(), id: nextId() })).toBeNull();
  expect(await stateOf(a, row.id)).toMatchObject({ state: 'queued', attempts: 0, history: [] });
};

function base() {
  return { types: [TYPE], leaseSeconds: 60, maxRunning: 5 };
}

const clockJump: Case = async ({ a, executorA, schedule, scheduleB, setNextRunAt }) => {
  const name = 'core:clock-jump:v1';
  const anchor = minuteStart(-3 * DAY_MS - MINUTE_MS);
  await schedule.upsert(ORG_A, { name, everySeconds: DAY_SECONDS, nextRunAt: anchor });
  const fired = (await Promise.all([schedule.tick(ORG_A), scheduleB.tick(ORG_A)])).flat();
  expect(fired).toHaveLength(1);
  expect(await schedule.tick(ORG_A)).toEqual([]);

  const claim = present(await claimOf(a, 1, { types: [name] }), 'the scheduled job');
  const slotIso = claim.idempotencyKey.slice(`schedule:${name}:`.length);
  const slot = Date.parse(slotIso);
  expect(slot).toBeLessThanOrEqual(Date.now());
  expect(slot).toBeGreaterThan(Date.now() - 2 * DAY_SECONDS * 1000);
  expect((slot - Date.parse(anchor)) % (DAY_SECONDS * 1000)).toBe(0);

  await setNextRunAt(name, slotIso);
  const moved = await executorA.all<{ next_run_at: string }>({
    sql: 'SELECT next_run_at FROM job_schedule WHERE org_id = ? AND name = ?',
    params: [ORG_A.orgId, name],
  });
  expect(moved[0]?.next_run_at).toBe(slotIso);
  expect(await schedule.tick(ORG_A)).toEqual([]);
  expect(await scheduleB.tick(ORG_A)).toEqual([]);
  expect(await claimOf(a, 2, { types: [name] })).toBeNull();
  const rows = await executorA.all<{ next_run_at: string }>({
    sql: 'SELECT next_run_at FROM job_schedule WHERE org_id = ? AND name = ?',
    params: [ORG_A.orgId, name],
  });
  expect(rows[0]?.next_run_at).toBe(new Date(slot + DAY_SECONDS * 1000).toISOString());
};

const settleAfterExpiry: Case = async ({ a, b, setLease }) => {
  const late = await enqueued(a);
  const claim = present(await claimOf(a, 1), 'a claim');
  await setLease(claim.id, PAST);
  await a.settle(ORG_A, claim, { outcome: 'succeeded' });
  const status = await stateOf(a, late.id);
  expect(status.state).toBe('succeeded');
  expect(status.history.map((attempt) => attempt.outcome)).toEqual(['succeeded']);

  const reaped = await enqueued(a);
  const lost = present(await claimOf(a, 2, { id: reaped.id }), 'a claim');
  await setLease(lost.id, PAST);
  expect(await b.reap(ORG_A, 10)).toBe(1);
  await rejectsStale(a.settle(ORG_A, lost, { outcome: 'succeeded' }));
  expect((await stateOf(a, reaped.id)).state).toBe('queued');
};

const syncWithoutConflict: Case = async ({ a, schedule }) => {
  const name = 'core:sync-ok:v1';
  const definitions = [{ name, everySeconds: 60, nextRunAt: minuteStart(-MINUTE_MS) }];
  await schedule.sync(ORG_A, definitions);
  await schedule.sync(ORG_A, definitions);
  const fired = await schedule.tick(ORG_A);
  expect(fired.map((item) => item.name)).toEqual([name]);
  expect(await claimOf(a, 1, { types: [name] })).not.toBeNull();
};

const syncConflictRollsBack: Case = async ({ schedule }) => {
  const kept = 'core:sync-kept:v1';
  const moved = 'core:sync-moved:v1';
  const added = 'core:sync-added:v1';
  const later = minuteStart(60 * MINUTE_MS);
  await schedule.sync(ORG_A, [
    { name: kept, everySeconds: 60, nextRunAt: later },
    { name: moved, everySeconds: 120, nextRunAt: later },
  ]);
  await expect(
    schedule.sync(ORG_A, [
      { name: added, everySeconds: 60, nextRunAt: minuteStart(-MINUTE_MS) },
      { name: moved, everySeconds: 300, nextRunAt: later },
    ]),
  ).rejects.toThrow(RangeError);
  expect(await schedule.tick(ORG_A)).toEqual([]);
  await schedule.sync(ORG_A, [
    { name: added, everySeconds: 60, nextRunAt: minuteStart(-MINUTE_MS) },
    { name: moved, everySeconds: 120, nextRunAt: later },
  ]);
  expect((await schedule.tick(ORG_A)).map((item) => item.name)).toEqual([added]);
};

export const jobContractCases: ReadonlyMap<string, Case> = new Map<string, Case>([
  ['concurrent claims', concurrentClaims],
  ['same-resource exclusivity', sameResourceExclusivity],
  ['independent resources up to the cap', independentResourcesUpToCap],
  ['repeated enqueue and conflicting reuse', repeatedEnqueue],
  ['claim and attempt roll back together', claimAttemptRollback],
  ['heartbeat renewal', heartbeatRenewal],
  ['expiry before takeover', expiryBeforeTakeover],
  ['takeover increases the fence', takeoverFence],
  ['old owner heartbeat, complete, fail and release reject', oldOwnerRejected],
  ['wrong org', wrongOrg],
  ['missing row', missingRow],
  ['exhausted lease and permanent error become dead', deadStates],
  ['deterministic backoff', deterministicBackoff],
  ['duplicate scheduler ticks', duplicateTicks],
  ['crash after effect before completion yields one effect on replay', crashAfterEffect],
  ['long-delay row is not claimed early', longDelay],
  ['mixed-version consumer releases without consuming an attempt', mixedVersion],
  ['head-of-line resource does not stall independent claims', headOfLine],
  ['lease expiry mid-batch leaves consistent state', leaseExpiryMidBatch],
  ['expired leases do not count toward maxRunning', expiredLeasesFreeCapacity],
  ['claim takes over an expired holder on the same resource', claimTakesOverExpiredHolder],
  ['lease guard lets a batch write while the lease is live', leaseGuardWrites],
  ['lease guard rejects the batch when the lease or fence is not current', leaseGuardRollsBack],
  ['lease guard rejects another organization', leaseGuardOrganization],
  ['malformed claim input is rejected', malformedClaimInput],
  ['clock jump during a tick does not fire a slot twice', clockJump],
  ['settle after expiry without takeover succeeds', settleAfterExpiry],
  ['schedule sync without conflict succeeds', syncWithoutConflict],
  ['schedule sync with a conflicting interval rolls back', syncConflictRollsBack],
]);

export function assertJobFixture(
  fixture: Partial<JobContractFixture>,
): asserts fixture is JobContractFixture {
  const missing: string[] = [];
  for (const key of ['a', 'b', 'executorA', 'executorB', 'schedule', 'scheduleB'] as const) {
    if (fixture[key] === undefined) missing.push(key);
  }
  for (const key of ['setLease', 'setNextRunAt', 'setRunAt'] as const) {
    if (typeof fixture[key] !== 'function') missing.push(key);
  }
  if (missing.length > 0) throw new Error(`job contract fixture is missing: ${missing.join(', ')}`);
  if (
    fixture.a === fixture.b ||
    fixture.executorA === fixture.executorB ||
    fixture.schedule === fixture.scheduleB
  ) {
    throw new Error('job contract fixture needs two independent handles');
  }
}

export function describeJobContract(name: string, make: () => Promise<JobContractFixture>): void {
  describe(`job contract: ${name}`, () => {
    for (const [caseName, run] of jobContractCases) {
      it(
        caseName,
        async () => {
          const fixture = await make();
          assertJobFixture(fixture);
          await run(fixture);
        },
        CASE_TIMEOUT_MS,
      );
    }
  });
}
