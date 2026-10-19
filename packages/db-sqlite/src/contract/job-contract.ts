import { describe, expect, it } from 'vitest';
import {
  orgContext,
  type OrgContext,
  type SqlExecutor,
  type Statement,
  type StatementResult,
} from '@package-broker/core/db/port';
import {
  IdempotencyConflictError,
  StaleFenceError,
  type JobClaim,
  type JobEnqueue,
  type JobRepository,
} from '@package-broker/core/platform/job-repository';
import { JobError, retryDelaySeconds } from '@package-broker/core/platform/jobs';
import { createJobRepository } from '../repositories/job.js';
import { jobLeaseGuard } from '../repositories/job-lease-guard.js';
import {
  createJobScheduleRepository,
  type JobScheduleRepository,
} from '../repositories/job-schedule.js';

export { jobLeaseGuard };

/** Called before statement `index` of a batch runs; a thrown error aborts and rolls back the batch. */
export type StatementHook = (index: number, sql: string) => void | Promise<void>;

/** Thrown by a case that needs a capability the fixture does not offer; the runner reports a skip. */
export class JobContractUnsupported extends Error {
  constructor(what: string) {
    super(`unsupported by this fixture: ${what}`);
    this.name = 'JobContractUnsupported';
  }
}

async function totalChanges(executor: SqlExecutor): Promise<number> {
  const rows = await executor.all<{ n: number }>({
    sql: 'SELECT total_changes() AS n',
    params: [],
  });
  return Number(rows[0]?.n ?? 0);
}

/**
 * Runs each batch statement by statement inside one transaction on a single connection, calling
 * the hook first. The hook may write through the wrapped executor's own `all` and sees the open
 * transaction. For drivers that expose BEGIN and COMMIT (node:sqlite, better-sqlite3).
 */
export function interceptBatches(base: SqlExecutor, onStatement: StatementHook): SqlExecutor {
  return {
    driver: base.driver,
    all: (statement) => base.all(statement),
    async batch(statements) {
      if (statements.length === 0) return [];
      await base.all({ sql: 'BEGIN IMMEDIATE', params: [] });
      try {
        const results: StatementResult[] = [];
        for (const [index, statement] of statements.entries()) {
          await onStatement(index, statement.sql);
          const before = await totalChanges(base);
          const rows = await base.all(statement);
          results.push({ changes: (await totalChanges(base)) - before, rows });
        }
        await base.all({ sql: 'COMMIT', params: [] });
        return results;
      } catch (error) {
        try {
          await base.all({ sql: 'ROLLBACK', params: [] });
        } catch {
          // the transaction already ended; the original error wins
        }
        throw error;
      }
    },
  };
}

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
  /**
   * Optional: wraps an executor of this fixture so that `onStatement` runs before each statement
   * of a batch, inside the batch's transaction. Absent where a batch cannot be split (D1); the
   * cases that need it then report themselves unsupported.
   */
  readonly intercept?: (executor: SqlExecutor, onStatement: StatementHook) => SqlExecutor;
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

function interceptOf(fixture: JobContractFixture) {
  if (fixture.intercept === undefined) throw new JobContractUnsupported('statement interception');
  return fixture.intercept;
}

function once(pattern: RegExp, action: () => Promise<void>): StatementHook {
  let done = false;
  return async (_index, sql) => {
    if (done || !pattern.test(sql)) return;
    done = true;
    await action();
  };
}

async function brokenRunningJobs(executor: SqlExecutor): Promise<number> {
  const rows = await executor.all<{ n: number }>({
    sql: `SELECT count(*) AS n FROM job WHERE
      (state = 'running' AND (lease_owner IS NULL OR lease_until IS NULL OR NOT EXISTS (
        SELECT 1 FROM job_attempt a WHERE a.job_id = job.id AND a.fence = job.fence
          AND a.worker = job.lease_owner AND a.outcome = 'running')))
      OR (state <> 'running' AND (lease_owner IS NOT NULL OR lease_until IS NOT NULL))`,
    params: [],
  });
  return Number(rows[0]?.n ?? 0);
}

async function expireNow(executor: SqlExecutor, jobId: string): Promise<void> {
  await executor.all({
    sql: 'UPDATE job SET lease_until = ? WHERE id = ?',
    params: [PAST, jobId],
  });
}

const REQUEUE_EXPIRED = /^UPDATE job SET\s+state = CASE/;
const EXPIRE_ATTEMPTS = /^UPDATE job_attempt SET outcome = 'lease_expired'/;
const INSERT_ATTEMPT = /^INSERT INTO job_attempt/;

const leaseExpiresBetweenClaimStatements: Case = async (fixture) => {
  const { a, b, executorA } = fixture;
  const intercept = interceptOf(fixture);
  const intercepted = (hook: StatementHook) => createJobRepository(intercept(executorA, hook));

  const held = await enqueued(a, { resourceKey: 'shared', runAt: PAST });
  const next = await enqueued(a, { resourceKey: 'shared', runAt: PAST_PLUS_ONE });
  const holder = present(await claimOf(a, 1), 'the first claim');
  expect(holder.id).toBe(held.id);

  const late = intercepted(once(REQUEUE_EXPIRED, () => expireNow(executorA, holder.id)));
  expect(await claimOf(late, 2)).toBeNull();
  expect(await brokenRunningJobs(executorA)).toBe(0);
  expect(await stateOf(a, held.id)).toMatchObject({ state: 'running', attempts: 1 });
  expect(await stateOf(a, next.id)).toMatchObject({ state: 'queued', attempts: 0, history: [] });

  const taken = present(await claimOf(b, 3), 'the takeover on the next claim');
  expect(taken.id).toBe(next.id);
  expect(await brokenRunningJobs(executorA)).toBe(0);
  const status = await stateOf(a, held.id);
  expect(status.state).toBe('queued');
  expect(status.history.map((attempt) => attempt.outcome)).toEqual(['lease_expired']);
  await rejectsStale(a.settle(ORG_A, holder, { outcome: 'succeeded' }));

  const second = await enqueued(a, { resourceKey: 'other', runAt: PAST });
  const third = await enqueued(a, { resourceKey: 'other', runAt: PAST_PLUS_ONE });
  const lapsing = present(await claimOf(a, 4, { id: second.id }), 'a claim');
  const early = intercepted(once(EXPIRE_ATTEMPTS, () => expireNow(executorA, lapsing.id)));
  expect(present(await claimOf(early, 5), 'a takeover inside one claim').id).toBe(third.id);
  expect(await brokenRunningJobs(executorA)).toBe(0);
  expect((await stateOf(a, second.id)).state).toBe('queued');
};

const leaseExpiresRightAfterGrant: Case = async (fixture) => {
  const { a, b, executorA } = fixture;
  const intercept = interceptOf(fixture);
  const row = await enqueued(a);
  let granted: string | undefined;
  const repo = createJobRepository(
    intercept(
      executorA,
      once(INSERT_ATTEMPT, async () => {
        granted = row.id;
        await expireNow(executorA, row.id);
      }),
    ),
  );
  const claim = present(await claimOf(repo, 1), 'a claim whose lease lapsed at once');
  expect(granted).toBe(row.id);
  expect(await brokenRunningJobs(executorA)).toBe(0);
  expect(await stateOf(a, row.id)).toMatchObject({ state: 'running', attempts: 1 });
  expect(await b.reap(ORG_A, 10)).toBe(1);
  await rejectsStale(a.settle(ORG_A, claim, { outcome: 'succeeded' }));
  expect(await brokenRunningJobs(executorA)).toBe(0);
};

const faultMidClaimRollsBack: Case = async (fixture) => {
  const { a, executorA } = fixture;
  const intercept = interceptOf(fixture);
  const row = await enqueued(a);
  const fault = new Error('injected fault');
  const repo = createJobRepository(
    intercept(
      executorA,
      once(INSERT_ATTEMPT, () => {
        throw fault;
      }),
    ),
  );
  await expect(claimOf(repo, 1)).rejects.toBe(fault);
  expect(await stateOf(a, row.id)).toMatchObject({ state: 'queued', attempts: 0, history: [] });
  expect(await brokenRunningJobs(executorA)).toBe(0);
  expect(present(await claimOf(a, 2), 'a claim once the fault clears').id).toBe(row.id);
};

const slotBoundaryInsideTick: Case = async (fixture) => {
  const { a, executorA } = fixture;
  const intercept = interceptOf(fixture);
  const before = '2020-01-01T00:01:59.999Z';
  const after = '2020-01-01T00:02:00.001Z';
  await executorA.all({
    sql: 'CREATE TEMP TABLE job_contract_clock (iso TEXT NOT NULL)',
    params: [],
  });
  await executorA.all({ sql: 'INSERT INTO job_contract_clock VALUES (?)', params: [before] });
  const atDatabaseTime = (statement: Statement): Statement => ({
    ...statement,
    sql: statement.sql.replaceAll("'now'", '(SELECT iso FROM temp.job_contract_clock)'),
  });
  const clock: SqlExecutor = {
    driver: executorA.driver,
    all: (statement) => executorA.all(atDatabaseTime(statement)),
    batch: (statements) => executorA.batch(statements.map(atDatabaseTime)),
  };
  let injections = 0;
  const repo = createJobScheduleRepository(
    intercept(
      clock,
      once(/^UPDATE job_schedule SET\s+last_slot/, async () => {
        injections += 1;
        await executorA.all({ sql: 'UPDATE job_contract_clock SET iso = ?', params: [after] });
      }),
    ),
  );
  const name = 'core:slot-boundary:v1';
  await repo.sync(ORG_A, [{ name, everySeconds: 60, nextRunAt: PAST }]);
  const fired = await repo.tick(ORG_A);
  expect(injections).toBe(1);
  expect(fired).toHaveLength(1);
  const jobs = await executorA.all<{ idempotency_key: string }>({
    sql: 'SELECT idempotency_key FROM job WHERE org_id = ? AND type = ?',
    params: [ORG_A.orgId, name],
  });
  expect(jobs.map((row) => row.idempotency_key)).toEqual([
    `schedule:${name}:2020-01-01T00:01:00.000Z`,
  ]);
  const stored = await executorA.all<{ next_run_at: string; last_slot: string }>({
    sql: 'SELECT next_run_at, last_slot FROM job_schedule WHERE org_id = ? AND name = ?',
    params: [ORG_A.orgId, name],
  });
  expect(stored[0]).toMatchObject({
    last_slot: '2020-01-01T00:01:00.000Z',
    next_run_at: '2020-01-01T00:02:00.000Z',
  });
  expect(present(await claimOf(a, 10, { types: [name] }), 'the slot job').id).toBe(
    present(fired[0], 'a fired job').jobId,
  );
};

async function corruptPayload(executor: SqlExecutor, jobId: string, raw: string): Promise<void> {
  try {
    await executor.all({ sql: 'PRAGMA ignore_check_constraints = ON', params: [] });
    await executor.all({
      sql: 'UPDATE job SET payload_json = ? WHERE id = ?',
      params: [raw, jobId],
    });
  } catch (error) {
    throw new JobContractUnsupported(`writing past the payload CHECK (${String(error)})`);
  } finally {
    await executor.all({ sql: 'PRAGMA ignore_check_constraints = OFF', params: [] });
  }
}

const corruptedPayloadAtClaim: Case = async ({ a, b, executorA }) => {
  const broken = await enqueued(a, { runAt: PAST });
  const sound = await enqueued(a, { runAt: PAST_PLUS_ONE });
  await corruptPayload(executorA, broken.id, '{"a":');
  const checked = await executorA.all<{ ok: number }>({
    sql: 'SELECT json_valid(payload_json) AS ok FROM job WHERE id = ?',
    params: [broken.id],
  });
  expect(checked[0]?.ok).toBe(0);

  const claim = present(await claimOf(a, 1), 'the claim behind the corrupted row');
  expect(claim.id).toBe(sound.id);
  expect(() => JSON.parse(claim.payloadJson)).not.toThrow();
  const status = await stateOf(a, broken.id);
  expect(status).toMatchObject({ state: 'dead', attempts: 0, lastErrorCode: 'invalid_payload' });
  expect(await claimOf(b, 2, { id: broken.id })).toBeNull();
  expect(await claimOf(b, 3)).toBeNull();
  expect(await brokenRunningJobs(executorA)).toBe(0);
  await a.settle(ORG_A, claim, { outcome: 'succeeded' });

  const targeted = await enqueued(a, { runAt: PAST });
  await corruptPayload(executorA, targeted.id, 'nope');
  expect(await claimOf(a, 4, { id: targeted.id })).toBeNull();
  expect(await stateOf(a, targeted.id)).toMatchObject({
    state: 'dead',
    lastErrorCode: 'invalid_payload',
  });
};

const corruptPayloadBehindBlockedRows: Case = async ({ a, executorA }) => {
  const held = await enqueued(a, { resourceKey: 'blocked', runAt: PAST });
  expect(present(await claimOf(a, 1), 'the resource holder').id).toBe(held.id);
  const blocked = [];
  for (let index = 0; index < 10; index += 1) {
    blocked.push(await enqueued(a, { resourceKey: 'blocked', runAt: PAST }));
  }
  const broken = await enqueued(a, { runAt: PAST_PLUS_ONE });
  await corruptPayload(executorA, broken.id, '{');
  const sound = await enqueued(a, { runAt: PAST_PLUS_ONE });
  expect(present(await claimOf(a, 2), 'an independent claim').id).toBe(sound.id);
  expect(await stateOf(a, broken.id)).toMatchObject({
    state: 'dead',
    attempts: 0,
    lastErrorCode: 'invalid_payload',
    history: [],
  });
  for (const row of blocked) {
    expect(await stateOf(a, row.id)).toMatchObject({ state: 'queued', attempts: 0 });
  }
};

const sqliteOnlyPayloadAtClaim: Case = async ({ a, executorA }) => {
  const raw = '{}\u0000garbage';
  expect(() => JSON.parse(raw)).toThrow();
  const checked = await executorA.all<{ ok: number }>({
    sql: 'SELECT json_valid(?) AS ok',
    params: [raw],
  });
  expect(checked[0]?.ok).toBe(1);
  const broken = await enqueued(a, { runAt: PAST });
  await corruptPayload(executorA, broken.id, raw);
  const sound = await enqueued(a, { runAt: PAST_PLUS_ONE });
  expect(present(await claimOf(a, 1), 'a JavaScript-readable claim').id).toBe(sound.id);
  expect(await stateOf(a, broken.id)).toMatchObject({
    state: 'dead',
    attempts: 0,
    lastErrorCode: 'invalid_payload',
    history: [],
  });
  expect(await claimOf(a, 2, { id: broken.id })).toBeNull();
  expect(await brokenRunningJobs(executorA)).toBe(0);
};

async function legacyJobIndexRemoved(fixture: JobContractFixture, name: string): Promise<void> {
  expect(
    await fixture.executorA.all({
      sql: 'SELECT name FROM sqlite_master WHERE name = ?',
      params: [name],
    }),
  ).toEqual([]);
}

async function claimPlansAfterContract(fixture: JobContractFixture): Promise<void> {
  const statements: Statement[] = [];
  const executor: SqlExecutor = {
    driver: fixture.executorA.driver,
    all: (statement) => fixture.executorA.all(statement),
    batch: (batch) => {
      statements.push(...batch);
      return fixture.executorA.batch(batch);
    },
  };
  await claimOf(createJobRepository(executor), 900);
  expect(statements).toHaveLength(8);
  for (const statement of statements) {
    const plan = await fixture.executorA.all<{ detail: string }>({
      sql: `EXPLAIN QUERY PLAN ${statement.sql}`,
      params: statement.params,
    });
    const details = plan.map((step) => step.detail).join('\n');
    expect(details).not.toMatch(/USING (?:COVERING )?INDEX job_(?:claim|lease)\b/);
    if (statement.sql.includes("last_error = 'invalid_payload'")) {
      expect(details).toMatch(
        /SEARCH job USING (?:COVERING )?INDEX job_claim_org \(org_id=\? AND run_at<\?\)/,
      );
    }
  }
}

const legacyJobContractCases = (
  [
    ['job_claim', 'queued'],
    ['job_lease', 'running'],
  ] as const
).flatMap<[string, Case]>(([name, state]) => [
  [`migration removes legacy ${name}`, (fixture) => legacyJobIndexRemoved(fixture, name)],
  [
    `EXPLAIN rejects a legacy ${name} index dependency`,
    async (fixture) => {
      // Build the deliberately invalid hint separately from the production index coverage scan.
      const legacyIndexHint = ['INDEXED', 'BY', name].join(' ');
      await expect(
        fixture.executorA.all({
          sql: `EXPLAIN QUERY PLAN SELECT id FROM job ${legacyIndexHint} WHERE org_id = ? AND state = '${state}'`,
          params: [ORG_A.orgId],
        }),
      ).rejects.toThrow();
    },
  ],
]);

export const jobContractCases: ReadonlyMap<string, Case> = new Map<string, Case>([
  ...legacyJobContractCases,
  ['claim statements prepare after the contract migration', claimPlansAfterContract],
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
  [
    'lease expiry between the statements of a claim stays consistent',
    leaseExpiresBetweenClaimStatements,
  ],
  [
    'a lease that lapses right after the grant leaves a reapable claim',
    leaseExpiresRightAfterGrant,
  ],
  ['a fault between claim statements rolls the claim back', faultMidClaimRollsBack],
  ['a slot boundary inside a tick fires exactly one slot', slotBoundaryInsideTick],
  [
    'corrupt payload scan progresses past valid resource-blocked rows',
    corruptPayloadBehindBlockedRows,
  ],
  ['a stored payload accepted only by SQLite is dead before claim', sqliteOnlyPayloadAtClaim],
  [
    'a corrupted queued payload is dead with invalid_payload and the queue moves',
    corruptedPayloadAtClaim,
  ],
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
        async (context) => {
          const fixture = await make();
          assertJobFixture(fixture);
          try {
            await run(fixture);
          } catch (error) {
            if (error instanceof JobContractUnsupported) context.skip(error.message);
            throw error;
          }
        },
        CASE_TIMEOUT_MS,
      );
    }
  });
}
