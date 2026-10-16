import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrgContext, SqlExecutor } from '@package-broker/core/db/port';
import {
  IdempotencyConflictError,
  JOB_ATTEMPT_OUTCOMES,
  StaleFenceError,
  type JobClaim,
  type JobEnqueue,
} from '@package-broker/core/platform/job-repository';
import { JobError, retryDelaySeconds } from '@package-broker/core/platform/jobs';
import { countCalls } from '../contract/count-calls.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { BACKOFF_STEPS, createJobRepository } from './job.js';

const TYPE = 'demo:work:v1';
const OTHER_TYPE = 'demo:other:v1';
const PROJECT_A = '01J0PROJECTA00000000000A01';
const PROJECT_B = '01J0PROJECTB00000000000B01';
const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const PAST = '2020-01-01T00:00:00.000Z';
const FUTURE = '2099-01-01T00:00:00.000Z';

interface ColumnRow {
  readonly name: string;
  readonly notnull: number;
}

function owner(n: number): string {
  return `01J0${'W'.repeat(18)}${String(n).padStart(4, '0')}`;
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `01J0JOB${String(counter).padStart(19, '0')}`;
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

async function all<R>(executor: SqlExecutor, sql: string, params: (string | number | null)[] = []) {
  return executor.all<R>({ sql, params });
}

describe('job schema assertions', () => {
  let database: MigratedDatabase;

  beforeEach(async () => {
    database = await openMigratedDatabase();
  });

  afterEach(async () => {
    await database.close();
  });

  it('job has the provenance columns, both nullable', async () => {
    const rows = await all<ColumnRow>(
      database.executor,
      `SELECT name, "notnull" AS "notnull" FROM pragma_table_info('job')`,
    );
    const byName = new Map(rows.map((row) => [row.name, row]));
    for (const name of [
      'id',
      'org_id',
      'type',
      'payload_json',
      'resource_key',
      'idempotency_key',
      'state',
      'attempts',
      'max_attempts',
      'lease_owner',
      'lease_until',
      'fence',
      'run_at',
      'last_error',
      'finished_at',
      'created_at',
      'updated_at',
    ]) {
      expect(byName.has(name), `job.${name}`).toBe(true);
    }
    expect(byName.get('project_id')?.notnull).toBe(0);
    expect(byName.get('initiator_token_id')?.notnull).toBe(0);
  });

  it('foreign key exists on project_id only', async () => {
    const keys = await all<{ from: string; table: string }>(
      database.executor,
      `SELECT "from", "table" FROM pragma_foreign_key_list('job')`,
    );
    const from = keys.map((key) => key.from).sort();
    expect(from).toContain('project_id');
    expect(from).not.toContain('initiator_token_id');
    expect(keys.find((key) => key.from === 'project_id')?.table).toBe('project');
  });

  it('job_attempt allows released, not dead, and keeps the fence index', async () => {
    const [table] = await all<{ sql: string }>(
      database.executor,
      "SELECT sql FROM sqlite_master WHERE name = 'job_attempt'",
    );
    const sql = table?.sql ?? '';
    for (const outcome of JOB_ATTEMPT_OUTCOMES) expect(sql).toContain(`'${outcome}'`);
    expect(sql).not.toContain("'dead'");
    const [index] = await all<{ sql: string }>(
      database.executor,
      "SELECT sql FROM sqlite_master WHERE name = 'job_attempt_fence'",
    );
    expect(index?.sql).toContain('(job_id, fence)');
  });
});

describe('job repository', () => {
  let database: MigratedDatabase;
  let a: OrgContext;
  let b: OrgContext;
  let executor: SqlExecutor;
  let directory: string;
  let repo: ReturnType<typeof createJobRepository>;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'job-repo-'));
    database = await openMigratedDatabase({
      twoOrganizations: true,
      file: join(directory, 'db.sqlite'),
    });
    executor = database.executor;
    a = database.orgs!.a;
    b = database.orgs!.b;
    await executor.batch([
      {
        sql: "INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, 'pa', 'PA')",
        params: [PROJECT_A, a.orgId],
      },
      {
        sql: "INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, 'pb', 'PB')",
        params: [PROJECT_B, b.orgId],
      },
    ]);
    repo = createJobRepository(executor, { random: () => 0.5 });
  });

  afterEach(async () => {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  });

  const claimOne = (
    owner: string,
    input: Partial<{ id: string; types: string[]; leaseSeconds: number; maxRunning: number }> = {},
    ctx: OrgContext = a,
  ): Promise<JobClaim | null> =>
    repo.claim(ctx, owner, { types: [TYPE], leaseSeconds: 60, maxRunning: 5, ...input });

  const setLease = (id: string, until: string) =>
    all(executor, 'UPDATE job SET lease_until = ? WHERE id = ?', [until, id]);

  const rowOf = async (id: string) =>
    (
      await all<Record<string, string | number | null>>(
        executor,
        'SELECT state, attempts, fence, lease_owner, lease_until, run_at, last_error, finished_at FROM job WHERE id = ?',
        [id],
      )
    )[0]!;

  const attemptsOf = (id: string) =>
    all<Record<string, string | number | null>>(
      executor,
      'SELECT attempt, fence, worker, outcome, error, finished_at, next_run_at FROM job_attempt WHERE job_id = ? ORDER BY fence',
      [id],
    );

  describe('enqueue', () => {
    it('creates once and returns the original on an identical replay', async () => {
      const row = job();
      expect(await repo.enqueue(a, row)).toEqual({ id: row.id, created: true });
      const replay = await repo.enqueue(a, { ...row, id: nextId() });
      expect(replay).toEqual({ id: row.id, created: false });
      const [count] = await all<{ n: number }>(executor, 'SELECT count(*) AS n FROM job');
      expect(count?.n).toBe(1);
    });

    it('throws IdempotencyConflictError on a different payload or type', async () => {
      const row = job();
      await repo.enqueue(a, row);
      await expect(
        repo.enqueue(a, { ...row, id: nextId(), payloadJson: '{"a":2}' }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
      await expect(
        repo.enqueue(a, { ...row, id: nextId(), type: OTHER_TYPE }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
    });

    it('records project and initiator, and DB time when runAt is null', async () => {
      const row = job({ projectId: PROJECT_A, initiatorTokenId: '01J0TOKEN0000000000000T001' });
      await repo.enqueue(a, row);
      const [stored] = await all<Record<string, string | null>>(
        executor,
        `SELECT project_id, initiator_token_id, run_at, ${NOW_SQL} AS now FROM job WHERE id = ?`,
        [row.id],
      );
      expect(stored?.project_id).toBe(PROJECT_A);
      expect(stored?.initiator_token_id).toBe('01J0TOKEN0000000000000T001');
      expect(stored?.run_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('creates nothing for a project of another organization or a missing one', async () => {
      await expect(repo.enqueue(a, job({ projectId: PROJECT_B }))).rejects.toMatchObject({
        name: 'JobError',
        code: 'invalid_payload',
      });
      await expect(repo.enqueue(a, job({ projectId: 'nope' }))).rejects.toBeInstanceOf(JobError);
      const [count] = await all<{ n: number }>(executor, 'SELECT count(*) AS n FROM job');
      expect(count?.n).toBe(0);
    });

    it('rejects malformed runAt and out-of-range maxAttempts', async () => {
      await expect(repo.enqueue(a, job({ runAt: '2026-01-01T00:00:00Z' }))).rejects.toMatchObject({
        code: 'invalid_run_at',
      });
      await expect(repo.enqueue(a, job({ maxAttempts: 0 }))).rejects.toBeInstanceOf(JobError);
      await expect(repo.enqueue(a, job({ maxAttempts: 101 }))).rejects.toBeInstanceOf(JobError);
    });

    it('a replay with a different project or resource key conflicts', async () => {
      const row = job({ projectId: PROJECT_A, resourceKey: 'r' });
      await repo.enqueue(a, row);
      await expect(
        repo.enqueue(a, { ...row, id: nextId(), projectId: null }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
      await expect(
        repo.enqueue(a, { ...row, id: nextId(), resourceKey: 'other' }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
    });

    it('a cross-organization project fails even when the key already exists', async () => {
      const row = job();
      await repo.enqueue(a, row);
      await expect(
        repo.enqueue(a, { ...row, id: nextId(), projectId: PROJECT_B }),
      ).rejects.toMatchObject({ code: 'invalid_payload' });
    });

    it('rejects invalid payload JSON', async () => {
      await expect(repo.enqueue(a, job({ payloadJson: '{nope' }))).rejects.toMatchObject({
        code: 'invalid_payload',
      });
    });

    it('a reused id under a new key raises instead of being swallowed', async () => {
      const row = job();
      await repo.enqueue(a, row);
      await expect(repo.enqueue(a, { ...row, idempotencyKey: 'another-key' })).rejects.toThrow();
    });

    it('two enqueues with the same key give one creation', async () => {
      const other = createJobRepository(await database.second());
      const row = job();
      const results = await Promise.all([
        repo.enqueue(a, row),
        other.enqueue(a, { ...row, id: nextId() }),
      ]);
      expect(results.filter((result) => result.created)).toHaveLength(1);
      expect(results[0].id).toBe(results[1].id);
    });

    it('keeps the same key in another organization independent', async () => {
      const row = job();
      await repo.enqueue(a, row);
      expect(await repo.enqueue(b, { ...row, id: nextId() })).toMatchObject({ created: true });
    });
  });

  describe('claim', () => {
    it('two claims on one job give one winner and one null (the node executor serialises; real concurrency is T282/T283)', async () => {
      const other = createJobRepository(await database.second());
      const row = job();
      await repo.enqueue(a, row);
      const results = await Promise.all([
        claimOne(owner(1), { id: row.id }),
        other.claim(a, owner(2), {
          id: row.id,
          types: [TYPE],
          leaseSeconds: 60,
          maxRunning: 5,
        }),
      ]);
      expect(results.filter((result) => result !== null)).toHaveLength(1);
      expect((await attemptsOf(row.id)).length).toBe(1);
    });

    it('increments attempts and fence, inserts the matching attempt, sets the lease', async () => {
      const row = job({ projectId: PROJECT_A, initiatorTokenId: 'tok', resourceKey: 'r1' });
      await repo.enqueue(a, row);
      const who = owner(3);
      const claim = await claimOne(who);
      expect(claim).toMatchObject({
        id: row.id,
        owner: who,
        fence: 1,
        attempt: 1,
        type: TYPE,
        payloadJson: '{"a":1}',
        projectId: PROJECT_A,
        initiatorTokenId: 'tok',
        resourceKey: 'r1',
        maxAttempts: 3,
      });
      expect(claim?.leaseUntil).toMatch(/Z$/);
      expect(await attemptsOf(row.id)).toEqual([
        expect.objectContaining({ attempt: 1, fence: 1, worker: who, outcome: 'running' }),
      ]);
      const [attempt] = await all<{ id: string }>(
        executor,
        'SELECT id FROM job_attempt WHERE job_id = ?',
        [row.id],
      );
      expect(attempt?.id).toBe(who);
    });

    it('does not claim a job scheduled in the future, an unregistered type, or another org', async () => {
      const future = job({ runAt: FUTURE });
      const unknown = job({ type: OTHER_TYPE });
      await repo.enqueue(a, future);
      await repo.enqueue(a, unknown);
      expect(await claimOne(owner(4))).toBeNull();
      const mine = job();
      await repo.enqueue(a, mine);
      expect(await claimOne(owner(5), {}, b)).toBeNull();
      expect(await claimOne(owner(6), { types: [] })).toBeNull();
      expect((await claimOne(owner(7)))?.id).toBe(mine.id);
    });

    it('claims the oldest due row by run_at then id', async () => {
      const late = job({ runAt: '2020-01-02T00:00:00.000Z' });
      const early = job({ runAt: PAST });
      await repo.enqueue(a, late);
      await repo.enqueue(a, early);
      expect((await claimOne(owner(8)))?.id).toBe(early.id);
    });

    it('serialises jobs on one resource and lets other resources run up to the cap', async () => {
      const first = job({ resourceKey: 'r', runAt: PAST });
      const second = job({ resourceKey: 'r', runAt: '2020-01-01T00:00:01.000Z' });
      const free = job({ resourceKey: 'other', runAt: '2020-01-01T00:00:02.000Z' });
      await repo.enqueue(a, first);
      await repo.enqueue(a, second);
      await repo.enqueue(a, free);
      expect((await claimOne(owner(9)))?.id).toBe(first.id);
      expect((await claimOne(owner(10)))?.id).toBe(free.id);
      expect(await claimOne(owner(11))).toBeNull();
    });

    it('enforces the global cap on live leases only', async () => {
      const rows = [
        job({ resourceKey: 'x' }),
        job({ resourceKey: 'y' }),
        job({ resourceKey: 'z' }),
      ];
      for (const row of rows) await repo.enqueue(a, row);
      const one = await claimOne(owner(12), { maxRunning: 2 });
      await claimOne(owner(13), { maxRunning: 2 });
      expect(await claimOne(owner(14), { maxRunning: 2 })).toBeNull();
      await setLease(one!.id, PAST);
      expect((await claimOne(owner(15), { maxRunning: 2 }))?.id).toBe(rows[2]!.id);
    });

    it('a held head-of-line resource does not stall an independent job', async () => {
      const held = job({ resourceKey: 'busy', runAt: PAST });
      const head = job({ resourceKey: 'busy', runAt: '2020-01-01T00:00:01.000Z' });
      const free = job({ resourceKey: 'free', runAt: '2020-01-01T00:00:02.000Z' });
      for (const row of [held, head, free]) await repo.enqueue(a, row);
      await claimOne(owner(16), { id: held.id });
      expect((await claimOne(owner(17)))?.id).toBe(free.id);
    });

    it('an expired unreaped holder no longer blocks a successor, a live holder still does', async () => {
      const held = job({ resourceKey: 'busy', runAt: PAST });
      const next = job({ resourceKey: 'busy', runAt: '2020-01-01T00:00:01.000Z' });
      await repo.enqueue(a, held);
      await repo.enqueue(a, next);
      const claim = (await claimOne(owner(900)))!;
      expect(await claimOne(owner(901))).toBeNull();
      await setLease(claim.id, PAST);
      const successor = await claimOne(owner(902));
      expect(successor?.id).toBe(next.id);
      expect(await rowOf(held.id)).toMatchObject({ state: 'queued', lease_owner: null });
      expect((await attemptsOf(held.id))[0]).toMatchObject({
        outcome: 'lease_expired',
        error: 'lease_lost',
      });
      await expect(repo.heartbeat(a, claim)).rejects.toBeInstanceOf(StaleFenceError);
    });

    it('an expired holder with no running attempt is requeued by reap with a fixed code', async () => {
      const row = job({ maxAttempts: 3 });
      await repo.enqueue(a, row);
      await claimOne(owner(910));
      await all(executor, 'DELETE FROM job_attempt WHERE job_id = ?', [row.id]);
      await setLease(row.id, PAST);
      expect(await repo.reap(a, 10)).toBe(1);
      expect(await rowOf(row.id)).toMatchObject({
        state: 'queued',
        lease_owner: null,
        last_error: 'lease_lost',
      });
    });

    it('registers 200 types without a limit', async () => {
      const row = job();
      await repo.enqueue(a, row);
      const types = Array.from({ length: 200 }, (_, index) => `demo:t${String(index)}:v1`);
      types.push(TYPE);
      expect((await claimOne(owner(920), { types }))?.id).toBe(row.id);
    });

    it('rejects a non-ULID owner', async () => {
      await expect(claimOne('process-1234')).rejects.toBeInstanceOf(RangeError);
    });

    it('two claims on different jobs sharing a resource give one winner and no error', async () => {
      const other = createJobRepository(await database.second());
      const first = job({ resourceKey: 'shared' });
      const second = job({ resourceKey: 'shared' });
      await repo.enqueue(a, first);
      await repo.enqueue(a, second);
      const results = await Promise.all([
        claimOne(owner(930)),
        other.claim(a, owner(931), { types: [TYPE], leaseSeconds: 60, maxRunning: 5 }),
      ]);
      expect(results.filter((result) => result !== null)).toHaveLength(1);
    });

    it('rejects invalid lease and cap input', async () => {
      await expect(claimOne(owner(960), { leaseSeconds: 0 })).rejects.toThrow(
        'leaseSeconds must be an integer',
      );
      await expect(claimOne(owner(961), { maxRunning: 0 })).rejects.toThrow(
        'maxRunning must be an integer',
      );
    });

    it('a live holder blocks the claim without a constraint error', async () => {
      const held = job({ resourceKey: 'busy', runAt: PAST });
      const next = job({ resourceKey: 'busy', runAt: '2020-01-01T00:00:01.000Z' });
      await repo.enqueue(a, held);
      await repo.enqueue(a, next);
      const claim = (await claimOne(owner(962), { id: held.id }))!;
      for (const until of [FUTURE, '2099-01-01T00:00:00.001Z']) {
        await setLease(claim.id, until);
        expect(await claimOne(owner(963), { id: next.id })).toBeNull();
      }
      expect((await rowOf(next.id)).state).toBe('queued');
    });

    it('an expired holder whose attempt is not at the current fence is reaped as an orphan, never a constraint error', async () => {
      const held = job({ resourceKey: 'busy', runAt: PAST });
      const next = job({ resourceKey: 'busy', runAt: '2020-01-01T00:00:01.000Z' });
      await repo.enqueue(a, held);
      await repo.enqueue(a, next);
      const claim = (await claimOne(owner(967), { id: held.id }))!;
      await all(executor, 'UPDATE job SET fence = fence + 1, lease_until = ? WHERE id = ?', [
        PAST,
        claim.id,
      ]);
      expect((await claimOne(owner(968)))?.id).toBe(next.id);
      expect(await rowOf(held.id)).toMatchObject({ state: 'queued', last_error: 'lease_lost' });
    });

    it('a reused owner gets null and skips the claim (the in-batch reap of expired holders still commits)', async () => {
      const first = job();
      const second = job();
      await repo.enqueue(a, first);
      await repo.enqueue(a, second);
      const claim = (await claimOne(owner(964)))!;
      expect(await claimOne(owner(964))).toBeNull();
      expect((await rowOf(second.id)).state).toBe('queued');
      expect(await attemptsOf(claim.id)).toHaveLength(1);
      await repo.settle(a, claim, { outcome: 'succeeded' });
      expect(await claimOne(owner(964))).toBeNull();
      expect((await rowOf(second.id)).state).toBe('queued');
    });

    it('bounds the payload in UTF-8 bytes', async () => {
      const exact = `"${'a'.repeat(131072 - 2)}"`;
      expect(await repo.enqueue(a, job({ payloadJson: exact }))).toMatchObject({ created: true });
      const over = `"${'a'.repeat(131072 - 1)}"`;
      await expect(repo.enqueue(a, job({ payloadJson: over }))).rejects.toMatchObject({
        code: 'invalid_payload',
      });
      const wide = `"${'é'.repeat(65536)}"`;
      expect(wide.length).toBeLessThan(131072);
      await expect(repo.enqueue(a, job({ payloadJson: wide }))).rejects.toMatchObject({
        code: 'invalid_payload',
      });
    });

    it('bounds the registered types JSON at 64 KiB of UTF-8', async () => {
      const lengths = Array.from({ length: 130 }, () => 500);
      let total = 2 + lengths.reduce((sum, length) => sum + length + 2, 0) + (lengths.length - 1);
      for (let index = 0; total < 65536; index = (index + 1) % lengths.length) {
        lengths[index] = (lengths[index] ?? 0) + 1;
        total += 1;
      }
      const types = lengths.map((length, index) => `t${String(index)}`.padEnd(length, 'x'));
      expect(Buffer.byteLength(JSON.stringify(types))).toBe(65536);
      expect(await claimOne(owner(965), { types })).toBeNull();
      const wide = [...types];
      wide[1] = `${wide[1]!}y`;
      await expect(claimOne(owner(966), { types: wide })).rejects.toBeInstanceOf(RangeError);
    });
  });

  describe('heartbeat', () => {
    it('renews the lease', async () => {
      const row = job();
      await repo.enqueue(a, row);
      const claim = (await claimOne(owner(18)))!;
      await setLease(row.id, '2099-01-01T00:00:00.000Z');
      await all(
        executor,
        "UPDATE job SET lease_until = strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 seconds') WHERE id = ?",
        [row.id],
      );
      const before = (await rowOf(row.id)).lease_until as string;
      await repo.heartbeat(a, claim);
      const after = (await rowOf(row.id)).lease_until as string;
      expect(after > before).toBe(true);
    });

    it('rejects after expiry even before takeover, and for the wrong org, owner, fence or id', async () => {
      const row = job();
      await repo.enqueue(a, row);
      const claim = (await claimOne(owner(19)))!;
      await expect(repo.heartbeat(b, claim)).rejects.toBeInstanceOf(StaleFenceError);
      await expect(repo.heartbeat(a, { ...claim, owner: 'x' })).rejects.toBeInstanceOf(
        StaleFenceError,
      );
      await expect(repo.heartbeat(a, { ...claim, fence: 9 })).rejects.toBeInstanceOf(
        StaleFenceError,
      );
      await expect(repo.heartbeat(a, { ...claim, id: 'missing' })).rejects.toBeInstanceOf(
        StaleFenceError,
      );
      await setLease(row.id, PAST);
      await expect(repo.heartbeat(a, claim)).rejects.toBeInstanceOf(StaleFenceError);
    });
  });

  describe('heartbeat and settle against reap', () => {
    it('heartbeat never shortens a longer lease', async () => {
      const row = job();
      await repo.enqueue(a, row);
      const claim = (await claimOne(owner(940), { leaseSeconds: 600 }))!;
      const before = (await rowOf(row.id)).lease_until as string;
      await repo.heartbeat(a, claim);
      expect(((await rowOf(row.id)).lease_until as string) >= before).toBe(true);
    });

    it('reap then heartbeat or settle on the same expired lease both reject', async () => {
      const row = job();
      await repo.enqueue(a, row);
      const claim = (await claimOne(owner(941)))!;
      await setLease(row.id, PAST);
      await repo.reap(a, 10);
      await expect(repo.heartbeat(a, claim)).rejects.toBeInstanceOf(StaleFenceError);
      await expect(repo.settle(a, claim, { outcome: 'succeeded' })).rejects.toBeInstanceOf(
        StaleFenceError,
      );
    });

    it('settle then reap leaves the settled job alone', async () => {
      const row = job();
      await repo.enqueue(a, row);
      const claim = (await claimOne(owner(942)))!;
      await setLease(row.id, PAST);
      await repo.settle(a, claim, { outcome: 'succeeded' });
      expect(await repo.reap(a, 10)).toBe(0);
      expect((await rowOf(row.id)).state).toBe('succeeded');
      expect((await attemptsOf(row.id))[0]?.outcome).toBe('succeeded');
    });

    it('heartbeat then reap leaves the renewed lease alone', async () => {
      const row = job();
      await repo.enqueue(a, row);
      const claim = (await claimOne(owner(943)))!;
      await setLease(row.id, PAST);
      await expect(repo.heartbeat(a, claim)).rejects.toBeInstanceOf(StaleFenceError);
      await all(
        executor,
        "UPDATE job SET lease_until = strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 seconds') WHERE id = ?",
        [row.id],
      );
      await repo.heartbeat(a, claim);
      expect(await repo.reap(a, 10)).toBe(0);
    });

    it('reap draws jitter per row when no random is injected', async () => {
      const plain = createJobRepository(executor);
      const rows = Array.from({ length: 8 }, () => job());
      for (const row of rows) await plain.enqueue(a, row);
      for (let index = 0; index < rows.length; index += 1) {
        await plain.claim(a, owner(950 + index), {
          types: [TYPE],
          leaseSeconds: 60,
          maxRunning: 20,
        });
      }
      await all(executor, 'UPDATE job SET lease_until = ? WHERE state = ?', [PAST, 'running']);
      expect(await plain.reap(a, 50)).toBe(8);
      const deltas = (
        await all<{ d: number }>(
          executor,
          `SELECT (julianday(a.next_run_at) - julianday(a.finished_at)) * 86400 AS d
           FROM job_attempt a`,
        )
      ).map((row) => row.d);
      for (const d of deltas) {
        expect(d).toBeGreaterThanOrEqual(3.99);
        expect(d).toBeLessThanOrEqual(5.01);
      }
      expect(new Set(deltas.map((d) => d.toFixed(3))).size).toBeGreaterThan(1);
    });
  });

  describe('settle', () => {
    it('succeeds and records the attempt and job together', async () => {
      const row = job();
      await repo.enqueue(a, row);
      const claim = (await claimOne(owner(20)))!;
      await repo.settle(a, claim, { outcome: 'succeeded' });
      expect(await rowOf(row.id)).toMatchObject({
        state: 'succeeded',
        lease_owner: null,
        lease_until: null,
      });
      expect((await rowOf(row.id)).finished_at).not.toBeNull();
      expect(await attemptsOf(row.id)).toEqual([
        expect.objectContaining({ outcome: 'succeeded', error: null }),
      ]);
    });

    it('still succeeds after the lease expired when no takeover happened', async () => {
      const row = job();
      await repo.enqueue(a, row);
      const claim = (await claimOne(owner(21)))!;
      await setLease(row.id, PAST);
      await repo.settle(a, claim, { outcome: 'succeeded' });
      expect((await rowOf(row.id)).state).toBe('succeeded');
      expect((await attemptsOf(row.id))[0]?.outcome).toBe('succeeded');
    });

    it('a retryable failure requeues with the retry delay and stores only the code', async () => {
      const row = job();
      await repo.enqueue(a, row);
      const claim = (await claimOne(owner(22)))!;
      await repo.settle(a, claim, {
        outcome: 'failed',
        errorCode: 'handler_error',
        permanent: false,
      });
      const stored = await rowOf(row.id);
      expect(stored).toMatchObject({
        state: 'queued',
        attempts: 1,
        last_error: 'handler_error',
        lease_owner: null,
      });
      const [attempt] = await attemptsOf(row.id);
      expect(attempt).toMatchObject({ outcome: 'failed', error: 'handler_error' });
      const delta =
        (Date.parse(stored.run_at as string) - Date.parse(attempt!.finished_at as string)) / 1000;
      expect(delta).toBeCloseTo(
        retryDelaySeconds(1, () => 0.5),
        2,
      );
    });

    it('a permanent failure or exhausted attempts becomes dead', async () => {
      const permanent = job({ maxAttempts: 5 });
      await repo.enqueue(a, permanent);
      const first = (await claimOne(owner(23)))!;
      await repo.settle(a, first, {
        outcome: 'failed',
        errorCode: 'invalid_payload',
        permanent: true,
      });
      expect(await rowOf(permanent.id)).toMatchObject({ state: 'dead' });
      expect((await rowOf(permanent.id)).finished_at).not.toBeNull();

      const exhausted = job({ maxAttempts: 1 });
      await repo.enqueue(a, exhausted);
      const second = (await claimOne(owner(24)))!;
      await repo.settle(a, second, {
        outcome: 'failed',
        errorCode: 'handler_error',
        permanent: false,
      });
      expect((await rowOf(exhausted.id)).state).toBe('dead');
      expect((await attemptsOf(exhausted.id))[0]?.outcome).toBe('failed');
    });

    it('released returns the job to queued without consuming an attempt', async () => {
      const row = job();
      await repo.enqueue(a, row);
      const claim = (await claimOne(owner(25)))!;
      await repo.settle(a, claim, { outcome: 'released', delaySeconds: 60 });
      const stored = await rowOf(row.id);
      expect(stored).toMatchObject({
        state: 'queued',
        attempts: 0,
        fence: 1,
        lease_owner: null,
        lease_until: null,
      });
      const [attempt] = await attemptsOf(row.id);
      expect(attempt?.outcome).toBe('released');
      const delta =
        (Date.parse(stored.run_at as string) - Date.parse(attempt!.finished_at as string)) / 1000;
      expect(delta).toBeCloseTo(60, 2);
      expect(await claimOne(owner(26))).toBeNull();
    });

    it('validates release delay', async () => {
      const row = job();
      await repo.enqueue(a, row);
      const claim = (await claimOne(owner(27)))!;
      await expect(
        repo.settle(a, claim, { outcome: 'released', delaySeconds: -1 }),
      ).rejects.toBeInstanceOf(RangeError);
      await expect(
        repo.settle(a, claim, { outcome: 'released', delaySeconds: 1.5 }),
      ).rejects.toBeInstanceOf(RangeError);
      await expect(
        repo.settle(a, claim, { outcome: 'released', delaySeconds: 10 ** 9 }),
      ).rejects.toBeInstanceOf(RangeError);
    });

    it('a takeover bumps the fence and the old owner heartbeat, success and failure all throw', async () => {
      const row = job();
      await repo.enqueue(a, row);
      const old = (await claimOne(owner(28)))!;
      await setLease(row.id, PAST);
      expect(await repo.reap(a, 10)).toBe(1);
      await all(executor, 'UPDATE job SET run_at = ? WHERE id = ?', [PAST, row.id]);
      const fresh = (await claimOne(owner(29)))!;
      expect(fresh.fence).toBe(old.fence + 1);
      await expect(repo.heartbeat(a, old)).rejects.toBeInstanceOf(StaleFenceError);
      await expect(repo.settle(a, old, { outcome: 'succeeded' })).rejects.toBeInstanceOf(
        StaleFenceError,
      );
      await expect(
        repo.settle(a, old, { outcome: 'failed', errorCode: 'handler_error', permanent: false }),
      ).rejects.toBeInstanceOf(StaleFenceError);
      expect(await rowOf(row.id)).toMatchObject({
        state: 'running',
        lease_owner: fresh.owner,
        fence: 2,
      });
      const attempts = await attemptsOf(row.id);
      expect(attempts.map((attempt) => attempt.outcome)).toEqual(['lease_expired', 'running']);
    });

    it('wrong org and missing rows fail closed without touching the attempt', async () => {
      const row = job();
      await repo.enqueue(a, row);
      const claim = (await claimOne(owner(30)))!;
      await expect(repo.settle(b, claim, { outcome: 'succeeded' })).rejects.toBeInstanceOf(
        StaleFenceError,
      );
      await expect(
        repo.settle(a, { ...claim, id: 'missing' }, { outcome: 'succeeded' }),
      ).rejects.toBeInstanceOf(StaleFenceError);
      expect((await attemptsOf(row.id))[0]?.outcome).toBe('running');
      expect((await rowOf(row.id)).state).toBe('running');
      await repo.settle(a, claim, { outcome: 'succeeded' });
      await expect(repo.settle(a, claim, { outcome: 'succeeded' })).rejects.toBeInstanceOf(
        StaleFenceError,
      );
    });
  });

  describe('reap', () => {
    it('requeues an expired attempt with backoff and records lease_expired', async () => {
      const row = job();
      await repo.enqueue(a, row);
      const claim = (await claimOne(owner(31)))!;
      await setLease(row.id, PAST);
      expect(await repo.reap(a, 10)).toBe(1);
      const stored = await rowOf(row.id);
      expect(stored).toMatchObject({
        state: 'queued',
        lease_owner: null,
        lease_until: null,
        fence: claim.fence,
      });
      const [attempt] = await attemptsOf(row.id);
      expect(attempt).toMatchObject({ outcome: 'lease_expired', error: 'lease_lost' });
      const delta =
        (Date.parse(stored.run_at as string) - Date.parse(attempt!.finished_at as string)) / 1000;
      expect(delta).toBeCloseTo(
        retryDelaySeconds(1, () => 0.5),
        2,
      );
      expect(attempt?.next_run_at).toBe(stored.run_at);
    });

    it('marks the job dead when attempts are exhausted', async () => {
      const row = job({ maxAttempts: 1 });
      await repo.enqueue(a, row);
      await claimOne(owner(32));
      await setLease(row.id, PAST);
      expect(await repo.reap(a, 10)).toBe(1);
      expect(await rowOf(row.id)).toMatchObject({ state: 'dead', lease_owner: null });
    });

    it('cannot clear a lease renewed by a live heartbeat', async () => {
      const row = job();
      await repo.enqueue(a, row);
      const claim = (await claimOne(owner(33)))!;
      await repo.heartbeat(a, claim);
      expect(await repo.reap(a, 10)).toBe(0);
      expect((await rowOf(row.id)).state).toBe('running');
      expect((await attemptsOf(row.id))[0]?.outcome).toBe('running');
    });

    it('is bounded by the limit, scoped to the org, and ignores live leases', async () => {
      const rows = [job(), job(), job()];
      for (const row of rows) await repo.enqueue(a, row);
      for (let index = 0; index < 3; index += 1) {
        const claim = await claimOne(owner(100 + index), {});
        await setLease(claim!.id, PAST);
      }
      expect(await repo.reap(b, 10)).toBe(0);
      expect(await repo.reap(a, 2)).toBe(2);
      expect(await repo.reap(a, 2)).toBe(1);
      await expect(repo.reap(a, 0)).rejects.toBeInstanceOf(RangeError);
      await expect(repo.reap(a, 1000)).rejects.toBeInstanceOf(RangeError);
    });

    it('processes at most twice the limit across attempts and orphans in one executor call', async () => {
      const rows = Array.from({ length: 8 }, () => job());
      for (const row of rows) await repo.enqueue(a, row);
      for (let index = 0; index < rows.length; index += 1)
        await claimOne(owner(970 + index), { maxRunning: 20 });
      await all(
        executor,
        `DELETE FROM job_attempt WHERE job_id IN (${rows
          .slice(4)
          .map(() => '?')
          .join(', ')})`,
        rows.slice(4).map((row) => row.id),
      );
      await all(executor, 'UPDATE job SET lease_until = ?', [PAST]);
      const calls = countCalls(executor);
      const first = await createJobRepository(calls.executor).reap(a, 3);
      expect(calls.counts()).toEqual({ all: 0, batch: 1 });
      expect(first).toBe(6);
      expect(first).toBeLessThanOrEqual(2 * 3);
      expect(await repo.reap(a, 3)).toBe(2);
    });

    it('keeps BACKOFF_STEPS tied to the core cap', () => {
      expect(retryDelaySeconds(BACKOFF_STEPS + 1, () => 1)).toBe(
        retryDelaySeconds(BACKOFF_STEPS, () => 1),
      );
      expect(retryDelaySeconds(BACKOFF_STEPS - 1, () => 1)).not.toBe(
        retryDelaySeconds(BACKOFF_STEPS, () => 1),
      );
    });
  });

  describe('status', () => {
    it('returns a bounded summary and null for missing or foreign jobs', async () => {
      const row = job({ maxAttempts: 30 });
      await repo.enqueue(a, row);
      for (let index = 0; index < 22; index += 1) {
        const claim = (await claimOne(owner(200 + index)))!;
        await repo.settle(a, claim, {
          outcome: 'failed',
          errorCode: 'handler_error',
          permanent: false,
        });
        await all(executor, 'UPDATE job SET run_at = ? WHERE id = ?', [PAST, row.id]);
      }
      const status = await repo.status(a, row.id);
      expect(status).toMatchObject({
        id: row.id,
        type: TYPE,
        state: 'queued',
        attempts: 22,
        maxAttempts: 30,
        lastErrorCode: 'handler_error',
      });
      expect(status?.history).toHaveLength(20);
      expect(status?.history.at(-1)).toMatchObject({
        outcome: 'failed',
        errorCode: 'handler_error',
      });
      expect(status?.history[0]?.attempt).toBeLessThan(status!.history.at(-1)!.attempt);
      expect(JSON.stringify(status)).not.toContain('payload');
      expect(await repo.status(b, row.id)).toBeNull();
      expect(await repo.status(a, 'missing')).toBeNull();
    });
  });
});
